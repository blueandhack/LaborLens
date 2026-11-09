const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');

const run = promisify(execFile);
const TYPES = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'];
const hubCsv = (year, approvals) => ['Employer (Petitioner) Name,Fiscal Year   ,Industry (NAICS) Code,Measure Names,Petitioner City,Petitioner State,Petitioner Zip Code,Tax ID,Line by line,Measure Values',
    ...TYPES.flatMap(type => [`ACME INC,${year},54 - Professional,${type} Approval,AUSTIN,TX,78701,0209,1,${type === 'New Employment' ? approvals : 0}`,
        `ACME INC,${year},54 - Professional,${type} Denial,AUSTIN,TX,78701,0209,1,0`])].join('\n') + '\n';
const fiscalYear = (date = new Date()) => date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);

test('the monthly hub job imports recent fiscal years once, and skips unchanged and unpublished ones', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const current = fiscalYear(), previous = current - 1;
    let approvals = 10;
    // The current year is "not yet published": the hub ignores the filter and returns the previous year.
    const server = http.createServer((req, res) => {
        const year = Number(new URL(req.url, 'http://x').searchParams.get('Fiscal Year   '));
        res.end(hubCsv(year === current ? previous : year, approvals));
    }).listen(0);
    t.after(() => server.close());
    const dbName = 'hub_' + randomUUID().replaceAll('-', '');
    const client = await MongoClient.connect(process.env.MONGO_TEST_URI);
    t.after(async () => { await client.db(dbName).dropDatabase(); await client.close(); });
    const env = { ...process.env, MONGO_URI: `${process.env.MONGO_TEST_URI.replace(/\/$/, '')}/${dbName}`, USCIS_HUB_CSV: `http://127.0.0.1:${server.address().port}/H1BPublic.csv` };
    const events = async () => (await run(process.execPath, [path.join(__dirname, '../scripts/import-uscis-h1b.js'), '--hub-recent'], { env })).stdout
        .split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

    let log = await events();
    assert.ok(log.some(event => event.event === 'hub-unpublished' && event.fiscalYear === current), 'a year the hub has not published is skipped');
    assert.deepEqual(log.at(-1).years, [previous]);
    const db = client.db(dbName);
    assert.equal((await db.collection('uscis_h1b').findOne({ fiscalYear: previous })).initialApprovals, 10);

    log = await events();
    assert.ok(log.some(event => event.event === 'hub-unchanged' && event.fiscalYear === previous));
    assert.equal(log.at(-1).message, 'Nothing changed.', 'an unchanged download is not imported again');

    approvals = 12; // USCIS updates the year.
    log = await events();
    assert.deepEqual(log.at(-1).years, [previous]);
    assert.equal((await db.collection('uscis_h1b').findOne({ fiscalYear: previous })).initialApprovals, 12);
});
