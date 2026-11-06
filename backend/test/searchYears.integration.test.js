const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { getAvailableYears } = require('../services/searchYears');

test('year options preserve calendar coverage using covered index reads', { skip: !process.env.MONGO_TEST_URI }, async () => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, {
        dbName: 'laborlens_years_test_' + randomUUID().replaceAll('-', ''), autoIndex: false,
    }).asPromise();
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const Model = connection.model('YearFixture', new mongoose.Schema({ outcome: Date, received: Date }), 'fixtures');
    try {
        assert.deepEqual(await getAvailableYears(Model, ['outcome', 'received']), []);
        await Model.collection.insertMany([
            ...Array.from({ length: 1000 }, () => ({ outcome: new Date('2026-06-30T00:00:00Z'), received: new Date('2025-01-01T00:00:00Z') })),
            { outcome: new Date('2008-01-01T00:00:00Z'), received: new Date('2008-01-01T00:00:00Z') },
            { outcome: null, received: null },
            { outcome: 'invalid source date', received: '1999' },
            { outcome: new Date('1800-01-01'), received: new Date('2200-01-01') },
        ]);
        await Model.collection.createIndex({ outcome: -1 });
        await Model.collection.createIndex({ received: -1 });
        await connection.db.command({ profile: 2 });
        const years = await getAvailableYears(Model, ['outcome', 'received']);
        await connection.db.command({ profile: 0 });
        assert.deepEqual(years, Array.from({ length: 19 }, (_, index) => 2026 - index));
        const reads = await connection.db.collection('system.profile').find({ 'command.find': 'fixtures' }).toArray();
        assert.equal(reads.length, 4);
        for (const read of reads) {
            assert.equal(read.docsExamined, 0, 'year bounds must not scan case documents');
            assert.ok(read.keysExamined <= 2, 'each year bound should examine only an index endpoint');
        }
    } finally {
        await connection.db.command({ profile: 0 });
        await connection.dropDatabase();
        await connection.close();
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});
