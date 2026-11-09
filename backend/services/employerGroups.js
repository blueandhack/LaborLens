const { createHash } = require('node:crypto');
const id = key => createHash('sha256').update(key).digest('hex').slice(0, 24);

// Reviewed filing-name links that automatic evidence cannot establish, such
// as a former name used only before DOL disclosed employer FEINs. Each key
// also brings its normalized spelling variants (see employerIdentity.js).
// Additions require source evidence; subsidiaries remain outside the group.
const groups = [{
    key: 'infosys limited', name: 'INFOSYS LIMITED',
    keys: ['infosys limited', 'infosys  limited', 'infosys ltd.', 'infosys, ltd.', 'infosys technologies limited'],
    description: 'Combines the reported LTD./LIMITED spellings, spacing variants, and the documented former name Infosys Technologies Limited.',
    reason: 'DOL filings report matching Richardson/Plano business addresses and employer tax-ID endings. Infosys documents its June 2011 change from Infosys Technologies Limited to Infosys Limited.',
    evidence: [
        { title: 'Infosys: official company naming history', url: 'https://www.infosys.com/investors/shareholder-services/faqs.html' },
        { title: 'H-1B: INFOSYS LIMITED · I-200-26174-041313', url: '/cases/6aeeea1e1ecb0dc4c55331f5' },
        { title: 'PERM: INFOSYS LTD. · A-22145-60883', url: '/cases/6aeec8ae1ecb0dc4c54aebbf' },
        { title: 'Former name: INFOSYS TECHNOLOGIES LIMITED · A-10302-28800', url: '/cases/6aeec7db1ecb0dc4c54acbb3' },
        { title: 'Punctuation variant: INFOSYS, LTD. · I-200-11288-280411', url: '/cases/6aef81cd1ecb0dc4c569cbcb' },
    ],
}, {
    key: 'google llc', name: 'GOOGLE LLC',
    keys: ['google llc', 'google inc.'],
    description: 'Combines Google LLC with its documented former legal name, Google Inc., and the spelling variants of each.',
    reason: 'Alphabet reports that Google Inc. converted into a limited liability company in September 2017. DOL filings under both names report the same business address, 1600 Amphitheatre Parkway, Mountain View, CA 94043.',
    evidence: [
        { title: 'Alphabet FY2017 Form 10-K: Google Inc. converted into a limited liability company (September 2017)', url: 'https://www.sec.gov/Archives/edgar/data/0001652044/000165204418000007/goog10-kq42017.htm' },
        { title: 'PERM: GOOGLE INC. · A-12228-91149 · 1600 Amphitheatre Parkway', url: '/cases/6aee60367519438c61351118' },
        { title: 'PERM: GOOGLE LLC · G-100-25121-925634 · 1600 Amphitheatre Parkway', url: '/cases/6aedb1f6affd9b521d20c749' },
        { title: 'H-1B: GOOGLE INC. · I-200-17033-297956', url: '/cases/6aef95261ecb0dc4c5916c47' },
        { title: 'H-1B: GOOGLE LLC · I-200-26174-043678', url: '/cases/6aeeea1e1ecb0dc4c5533195' },
    ],
}].map(group => Object.freeze({ ...group, id: id(group.key), scope: createHash('sha256').update(JSON.stringify(group.keys)).digest('hex').slice(0, 16) }));
const byId = new Map(groups.map(group => [group.id, group]));
const queryName = value => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ').replace(/\bltd$/, 'limited');
const byQuery = new Map(groups.flatMap(group => group.keys.map(key => [queryName(key), group])));
const groupForId = value => typeof value === 'string' ? byId.get(value) : undefined;
const groupForQuery = value => typeof value === 'string' ? byQuery.get(queryName(value)) : undefined;
module.exports = { groups, groupForId, groupForQuery };
