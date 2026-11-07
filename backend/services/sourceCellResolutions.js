// Resolve only fields whose absence follows from other reported source values.
// Keep the original Excel error for provenance; never infer a replacement value.
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' '));
function resolveSourceCells(record, type) {
    if (type !== 'h1b' || !record._DOL_CELL_ERRORS?.EMPLOYER_PROVINCE || record.EMPLOYER_PROVINCE != null) return {};
    const country = String(record.EMPLOYER_COUNTRY || '').trim().toUpperCase();
    const state = String(record.EMPLOYER_STATE || '').trim().toUpperCase();
    if (!['UNITED STATES OF AMERICA', 'UNITED STATES', 'USA', 'US'].includes(country) || !US_STATES.has(state)) return {};
    const resolutions = { EMPLOYER_PROVINCE: {
        value: null, originalValue: record._DOL_CELL_ERRORS.EMPLOYER_PROVINCE,
        reason: `Province is not applicable to this US address; the source reports employer state ${state}.`,
        evidence: { EMPLOYER_COUNTRY: record.EMPLOYER_COUNTRY, EMPLOYER_STATE: record.EMPLOYER_STATE },
    } };
    record._DOL_CELL_RESOLUTIONS = { ...record._DOL_CELL_RESOLUTIONS, ...resolutions };
    return resolutions;
}
module.exports = { resolveSourceCells };
