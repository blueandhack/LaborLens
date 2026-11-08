const { createHash } = require('node:crypto');
const id = key => createHash('sha256').update(key).digest('hex').slice(0, 24);

// Reviewed filing-name links, not a rule that merges similar company names.
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
}].map(group => Object.freeze({ ...group, id: id(group.key), scope: createHash('sha256').update(JSON.stringify(group.keys)).digest('hex').slice(0, 16) }));
const byKey = new Map(groups.flatMap(group => group.keys.map(key => [key, group])));
const byId = new Map(groups.map(group => [group.id, group]));
const queryName = value => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ').replace(/\bltd$/, 'limited');
const byQuery = new Map(groups.flatMap(group => group.keys.map(key => [queryName(key), group])));
const groupForKey = key => typeof key === 'string' ? byKey.get(key.toLowerCase()) : undefined;
const groupForId = value => typeof value === 'string' ? byId.get(value) : undefined;
const groupForQuery = value => typeof value === 'string' ? byQuery.get(queryName(value)) : undefined;
const cacheIdFor = employer => {
    const group = groupForKey(employer.key);
    return group ? `${group.id}:names:${group.scope}` : employer._id;
};
module.exports = { groups, groupForKey, groupForId, groupForQuery, cacheIdFor };
