const quarterNumber = file => Number(file.quarter) || Number(file.filename?.match(/_Q([1-4])(?:_|\.xlsx$)/i)?.[1]) || 4;

function releaseMode(file) {
    if (['annual', 'quarterly', 'cumulative'].includes(file.coverageMode)) return file.coverageMode;
    if (!/_Q[1-4](?:_|\.xlsx$)/i.test(file.filename || '')) return 'annual';
    // Historical FLAG-era LCA archives are separate quarters. Only a release
    // explicitly identified as cumulative may cover earlier quarters.
    return file.type === 'h1b' && Number(file.fiscalYear) >= 2020 ? 'quarterly' : 'cumulative';
}

function coverageRange(file) {
    const mode = releaseMode(file);
    const end = mode === 'annual' ? 4 : quarterNumber(file);
    return { start: mode === 'quarterly' ? end : 1, end };
}

function requiredReleases(files) {
    const groups = new Map();
    for (const file of files) {
        const key = `${file.type}:${file.fiscalYear}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(file);
    }
    return [...groups.values()].flatMap(group => {
        const annual = group.filter(file => releaseMode(file) === 'annual');
        if (annual.length) return annual;
        const cumulative = group.filter(file => releaseMode(file) === 'cumulative');
        const through = Math.max(0, ...cumulative.map(quarterNumber));
        return group.filter(file => releaseMode(file) === 'cumulative' ? quarterNumber(file) === through : quarterNumber(file) > through);
    });
}

module.exports = { releaseMode, coverageRange, requiredReleases };
