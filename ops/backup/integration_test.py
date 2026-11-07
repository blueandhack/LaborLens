#!/usr/bin/env python3
"""Run on the configured backup host: real MongoDB dump/restore and encrypted rclone round trip.

Creates and drops only uniquely named laborlens_backup_test_* databases.
Uses a local crypt remote, so it needs no Google credentials or production writes.
"""
import configparser
import gzip
import json
import os
from pathlib import Path
import secrets
import tempfile

from backup import Drive, Lease, command, dump_database, sha256, verify_gzip


def main():
    os.umask(0o077)
    kubectl = ['kubectl', '-n', 'laborlens']
    name = 'laborlens_backup_test_' + secrets.token_hex(8)
    restored = name + 'ff'

    def node(source):
        return command(kubectl + ['exec', 'deployment/laborlens-backend', '--', 'node', '-e', source],
                       capture_output=True, text=True).stdout.strip()

    setup = """
const {MongoClient}=require('mongodb');
(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);try{
 const db=c.db(NAME);
 await db.collection('cases').insertMany(Array.from({length:12},(_,i)=>({CASE_NUMBER:'test-'+i,EMPLOYER:'München 東京',amount:i,date:new Date('2026-01-01')})));
 await db.collection('cases').createIndex({CASE_NUMBER:1},{unique:true});
 await db.collection('permcases').insertMany(Array.from({length:8},(_,i)=>({CASE_NUMBER:'perm-test-'+i})));
 await db.collection('admins').insertOne({username:'backup-test-fixture'});
 await db.collection('import_catalog').insertOne({_id:'dol',datasets:[]});
 console.log('isolated fixture created');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exit(1)});
""".replace('NAME', json.dumps(name))
    cleanup = """
const {MongoClient}=require('mongodb');
(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);try{
 for(const name of NAMES){if(!/^laborlens_backup_test_[a-f0-9]+$/.test(name))throw Error('Unsafe cleanup');await c.db(name).dropDatabase();}
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exit(1)});
""".replace('NAMES', json.dumps([name, restored]))
    print(node(setup), flush=True)
    try:
        pods = json.loads(command(kubectl + ['get', 'pods', '-l', 'app=laborlens-mongodb', '-o', 'json'],
                                  capture_output=True, text=True).stdout)['items']
        pod = next(p['metadata']['name'] for p in pods if p['status']['phase'] == 'Running')
        with tempfile.TemporaryDirectory(prefix='integration-', dir='/var/lib/laborlens-backup') as temporary:
            work = Path(temporary)
            source = work / 'source'
            source.mkdir()
            archive = source / 'pwd_cases.archive.gz'
            with Lease(kubectl, test_database=name) as lease:
                conflict = """
const {MongoClient}=require('mongodb');const{acquireImportLock}=require('./services/importLock');
(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);try{try{await acquireImportLock(c.db(NAME),'conflicting test');throw Error('Lease not exclusive')}catch(e){if(e.status!==409)throw e;console.log('Concurrent writer refused')}}finally{await c.close()}})().catch(e=>{console.error(e.message);process.exit(1)});
""".replace('NAME', json.dumps(name))
                print(node(conflict), flush=True)
                dump_database(kubectl, pod, archive, lease)
                assert sum(c['count'] for c in lease.manifest['collections']) == 22
            verify_gzip(archive)
            print('Real dump and shared lease passed', flush=True)

            config = configparser.ConfigParser(interpolation=None)
            def obscure(value):
                return command(['rclone', 'obscure', '-'], input=value + '\n', capture_output=True, text=True).stdout.strip()
            config['testcrypt'] = {'type': 'crypt', 'remote': str(work / 'encrypted'),
                                   'directory_name_encryption': 'false',
                                   'password': obscure(secrets.token_urlsafe(32)),
                                   'password2': obscure(secrets.token_urlsafe(32))}
            config_path = work / 'rclone.conf'
            with config_path.open('w') as stream:
                config.write(stream)
            drive = Drive()
            drive.base = ['rclone', '--config', str(config_path), '--transfers=1', '--checkers=1']
            drive.remote = 'testcrypt:mongodb'
            stamp = '2026-11-06_12-00-00_UTC-00000000'
            drive.publish(source, stamp)
            assert (work / 'encrypted' / 'mongodb' / stamp).is_dir()
            assert not (work / 'encrypted' / 'mongodb' / stamp / archive.name).exists()
            download = work / 'download'
            drive.run('copy', f'{drive.remote}/{stamp}', str(download))
            assert sha256(download / archive.name) == sha256(archive)
            verify_gzip(download / archive.name)
            print('Encrypted upload, cryptcheck and decrypted download passed', flush=True)

            restore_bin = '/tmp/laborlens-mongorestore-100.20.0'
            with open('/opt/laborlens-backup/bin/mongorestore', 'rb') as binary:
                command(kubectl + ['exec', '-i', pod, '--', 'sh', '-c',
                                  f'cat > {restore_bin} && chmod 700 {restore_bin}'], stdin=binary)
            with (download / archive.name).open('rb') as stream:
                command(kubectl + ['exec', '-i', pod, '--', restore_bin,
                                  '--uri=mongodb://127.0.0.1:27017', '--archive', '--gzip',
                                  f'--nsInclude={name}.*', f'--nsFrom={name}.*', f'--nsTo={restored}.*'], stdin=stream)
            verify = """
const {MongoClient,BSON}=require('mongodb');const assert=require('node:assert/strict');
(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);try{
 for(const col of ['cases','permcases','admins','import_catalog']){
  const a=c.db(SOURCE).collection(col),b=c.db(TARGET).collection(col);
  assert.equal(BSON.EJSON.stringify(await a.find().sort({_id:1}).toArray()),BSON.EJSON.stringify(await b.find().sort({_id:1}).toArray()));
  assert.deepEqual(await a.indexes(),await b.indexes());
 }
 assert.equal(await c.db(TARGET).collection('import_locks').countDocuments(),0);
 console.log('Restored documents, Unicode, dates and indexes match; no stale import lock');
}finally{await c.close();}})().catch(e=>{console.error(e);process.exit(1)});
""".replace('SOURCE', json.dumps(name)).replace('TARGET', json.dumps(restored))
            print(node(verify), flush=True)
    finally:
        node(cleanup)
        print('Isolated test databases removed', flush=True)


if __name__ == '__main__':
    main()
