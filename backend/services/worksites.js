const fields = {
    h1b: { city: ['WORKSITE_CITY', 'WORKSITE_CITY_1', 'LCA_CASE_WORKLOC1_CITY', 'CITY_1', 'WORK_LOCATION_CITY1'], state: ['WORKSITE_STATE', 'WORKSITE_STATE_1', 'LCA_CASE_WORKLOC1_STATE', 'STATE_1', 'WORK_LOCATION_STATE1'] },
    pwd: { city: ['PRIMARY_WORKSITE_CITY', 'WORKSITE_CITY'], state: ['PRIMARY_WORKSITE_STATE', 'WORKSITE_STATE'] },
    perm: { city: ['WORKSITE_CITY', 'JOB_INFO_WORK_CITY', 'JOB_OPP_CITY'], state: ['WORKSITE_STATE', 'JOB_INFO_WORK_STATE', 'JOB_OPP_STATE'] },
};
function worksite(record, program) {
    const result = {};
    for (const [part, names] of Object.entries(fields[program])) {
        const value = names.map(name => record[name]).find(value => typeof value === 'string' && value.trim());
        result[part] = value?.trim() || null;
    }
    return result;
}
function addWorksite(record, program) {
    const value = worksite(record, program);
    return Object.assign(record, { _WORKSITE_CITY_LOWER: value.city?.toLowerCase() || '',
        _WORKSITE_STATE_LOWER: value.state?.toLowerCase() || '', _DISCOVERY_VERSION: 1 });
}
function stringExpression(names) {
    return names.reduceRight((fallback, name) => ({ $cond: [
        { $eq: [{ $type: '$' + name }, 'string'] },
        { $cond: [{ $ne: [{ $trim: { input: '$' + name } }, ''] }, { $trim: { input: '$' + name } }, fallback] }, fallback,
    ] }), '');
}
async function normalizeWorksites(Model, program, { signal, onProgress = () => {} } = {}) {
    const projection = Object.fromEntries([...fields[program].city, ...fields[program].state].map(name => [name, 1]));
    let processed = 0;
    while (true) {
        signal?.throwIfAborted();
        const rows = await Model.collection.find({ _DISCOVERY_VERSION: null }, { projection, signal })
            .hint('discovery_version_v1').limit(5000).batchSize(5000).toArray();
        if (!rows.length) return processed;
        // JavaScript case-folding matches the importer, including non-ASCII
        // place names. A concurrent updated import (version 1) wins atomically.
        const groups = new Map();
        for (const row of rows) {
            const derived = addWorksite({ ...row }, program);
            const key = JSON.stringify([derived._WORKSITE_CITY_LOWER, derived._WORKSITE_STATE_LOWER]);
            if (!groups.has(key)) groups.set(key, { city: derived._WORKSITE_CITY_LOWER, state: derived._WORKSITE_STATE_LOWER, ids: [] });
            groups.get(key).ids.push(row._id);
        }
        await Model.collection.bulkWrite([...groups.values()].map(group => ({ updateMany: {
            filter: { _id: { $in: group.ids }, _DISCOVERY_VERSION: null }, hint: '_id_',
            update: { $set: { _WORKSITE_CITY_LOWER: group.city, _WORKSITE_STATE_LOWER: group.state, _DISCOVERY_VERSION: 1 } },
        } })), { ordered: false });
        processed += rows.length;
        if (processed % 100000 === 0) await onProgress({ event: 'worksites', program, processed });
    }
}
module.exports = { fields, worksite, addWorksite, stringExpression, normalizeWorksites };
