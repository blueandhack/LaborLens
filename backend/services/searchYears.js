// Read the ends of existing date indexes instead of scanning every disclosure.
async function getAvailableYears(Model, fields) {
    const validRange = { $gte: new Date('1901-01-01T00:00:00.000Z'), $lt: new Date('2100-01-01T00:00:00.000Z') };
    const bounds = await Promise.all(fields.flatMap(field => [1, -1].map(direction =>
        Model.findOne({ [field]: validRange }, { [field]: 1, _id: 0 })
            .sort({ [field]: direction }).lean().maxTimeMS(5000).then(row => row?.[field])
    )));
    const years = bounds.filter(value => value instanceof Date).map(value => value.getUTCFullYear());
    if (!years.length) return [];
    const min = Math.min(...years);
    const max = Math.max(...years);
    return Array.from({ length: max - min + 1 }, (_, index) => max - index);
}
module.exports = { getAvailableYears };
