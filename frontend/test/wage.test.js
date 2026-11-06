import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWageRange } from '../src/utils/wage.js';
import { formatDisclosureDate } from '../src/utils/disclosureDate.js';

test('missing wage periods are reported, never assumed annual', () => {
    assert.equal(formatWageRange(25, null, null), '$25 / pay period not reported');
    assert.equal(formatWageRange(25, 30, 'Hour'), '$25 – $30 / Hour');
    assert.equal(formatWageRange(null, null, 'Year'), 'N/A');
    assert.equal(formatWageRange(0, null, 'Hour'), '$0 / Hour');
});

test('disclosure calendar dates do not shift to the previous day in Pacific time', () => {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(formatDisclosureDate('2008-01-01T00:00:00.000Z', 'en-US'), '1/1/2008');
    assert.equal(formatDisclosureDate(null, 'en-US'), 'N/A');
    assert.equal(formatDisclosureDate('2013', 'en-US'), 'N/A');
});
