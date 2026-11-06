// Aliases are based on the published FY2008–2026 workbooks and DOL layouts.
// Preserve original columns; add canonical fields used by search and cards.
const COMMON = {
    CASE_NUMBER: ['CASE_NO'], CASE_STATUS: ['STATUS'],
    RECEIVED_DATE: ['CASE_RECEIVED_DATE', 'SUBMIT_DATE'],
};
const ALIASES = {
    pwd: {
        ...COMMON,
        EMPLOYER_LEGAL_BUSINESS_NAME: ['EMPLYER_LEGAL_BUSINESS_NAME', 'BUSINESS_NAME'],
        EMPLOYER_CITY: [], EMPLOYER_STATE: [], EMPLOYER_POSTAL_CODE: [],
        EMPLOYER_ADDRESS_1: ['EMPLOYER_ADDFRESS_1'],
        JOB_TITLE: ['PW_JOB_TITLE'],
        DETERMINATION_DATE: ['PW_DETERMINATION_DATE', 'PW_DETERM_DATE', 'DETERMINATION_ISSUED'],
        REDETERMINATION_DATE: ['PW_REDETERMINATION_DATE', 'DATE_REDETERMINATION_ISSUED'],
        WITHDRAWAL_DATE: ['PW_WITHDRAWAL_DATE'],
        VISA_CLASS: ['APPLICATION_TYPE'], NAICS_CODE: ['NAICS_US_CODE', 'NAIC_ID'],
        PWD_SOC_CODE: ['PW_SOC_CODE', 'SOC_CODE'], PWD_SOC_TITLE: ['PW_SOC_TITLE', 'SOC_CODE_NAME'],
        PWD_WAGE_RATE: ['PREVAIL_WAGE'], PWD_UNIT_OF_PAY: ['PAY_RANGE_DESC'],
        PWD_OES_WAGE_LEVEL: ['PWD_WAGE_LEVEL', 'WAGE_LEVEL'],
        PWD_WAGE_SOURCE: ['PREVAILING_WAGE_SOURCE'], PWD_WAGE_EXPIRATION_DATE: ['PREVAIL_WAGE_EXPIRE_DATE'],
        TRADE_NAME_DBA: ['EMPLOYER_TRADE_DBA_NAME', 'TRADE_NAME'],
        REQUIRED_EDUCATION_LEVEL: ['PRIMARY_EDUCATION_LEVEL', 'EDUCATION_LEVEL'],
        REQUIRED_TRAINING_MONTHS: ['NUMBER_OF_MONTHS_TRAINING', 'NUM_MONTHS_TRAINING'],
        REQUIRED_EXPERIENCE_MONTHS: ['EMP_EXPERIENCE_MONTHS', 'EMP_EXP_NUM_MONTHS'],
        PRIMARY_WORKSITE_CITY: ['WORKSITE_CITY'], PRIMARY_WORKSITE_STATE: ['WORKSITE_STATE'],
        PRIMARY_WORKSITE_POSTAL_CODE: ['WORKSITE_ZIP'],
    },
    perm: {
        ...COMMON,
        DECISION_DATE: [],
        EMP_BUSINESS_NAME: ['EMPLOYER_NAME'], EMP_CITY: ['EMPLOYER_CITY'],
        EMP_STATE: ['EMPLOYER_STATE', 'EMPLOYER_STATE_PROVINCE'],
        EMP_ADDR1: ['EMPLOYER_ADDRESS_1'], EMP_ADDR2: ['EMPLOYER_ADDRESS_2'],
        EMP_POSTCODE: ['EMPLOYER_POSTAL_CODE'], EMP_COUNTRY: ['EMPLOYER_COUNTRY'],
        // FY2013's ADD_THESE column contains the actual job title; its other
        // PW_JOB_TITLE_9089 column repeats the SOC occupation title.
        JOB_TITLE: ['JOB_INFO_JOB_TITLE', 'ADD_THESE_PW_JOB_TITLE_9089', 'PW_JOB_TITLE_9089', 'PW_JOB_TITLE'],
        PWD_SOC_CODE: ['PW_SOC_CODE'], PWD_SOC_TITLE: ['PW_SOC_TITLE'],
        JOB_OPP_PWD_NUMBER: ['PW_TRACK_NUMBER', 'PW_TRACK_NUM'],
        JOB_OPP_WAGE_FROM: ['WAGE_OFFER_FROM', 'WAGE_OFFERED_FROM_9089', 'WAGE_OFFER_FROM_9089'],
        JOB_OPP_WAGE_TO: ['WAGE_OFFER_TO', 'WAGE_OFFERED_TO_9089', 'WAGE_OFFER_TO_9089'],
        JOB_OPP_WAGE_PER: ['WAGE_OFFER_UNIT_OF_PAY', 'WAGE_OFFERED_UNIT_OF_PAY_9089', 'WAGE_OFFER_UNIT_OF_PAY_9089'],
        PWD_OES_WAGE_LEVEL: ['PW_SKILL_LEVEL', 'PW_LEVEL_9089'],
        EMP_NAICS_CODE: ['NAICS_CODE', 'NAICS_US_CODE', '2007_NAICS_US_CODE', 'EMP_NAICS'],
    },
};
const DATE_FIELDS = [
    'RECEIVED_DATE', 'DETERMINATION_DATE', 'PREVAIL_WAGE_DETERM_DATE', 'PWD_WAGE_EXPIRATION_DATE',
    'REDETERMINATION_DATE', 'CENTER_DIRECTOR_REVIEW_DATE', 'WITHDRAWAL_DATE', 'SURVEY_PUBLICATION_DATE',
    'DECISION_DATE', 'RECR_INFO_JOB_START_DATE', 'RECR_INFO_JOB_END_DATE', 'RECR_INFO_AD_DATE1', 'RECR_INFO_AD_DATE2',
];
const NUMBER_FIELDS = [
    'PWD_WAGE_RATE', 'ALT_PWD_WAGE_RATE', 'H2B_HIGHEST_PWD', 'REQUIRED_TRAINING_MONTHS',
    'REQUIRED_EXPERIENCE_MONTHS', 'ALT_TRAINING_MONTHS', 'ALT_EXPERIENCE_MONTHS',
    'JOB_OPP_WAGE_FROM', 'JOB_OPP_WAGE_TO',
];
const MISSING = /^(?:|n\/?a|n\.a\.|null|none|not applicable|not available|not reported|unknown|[-*]+)$/i;
const isMissing = value => value == null || (typeof value === 'string' && MISSING.test(value.trim()));
const normalizeHeader = value => String(value ?? '').normalize('NFKC').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function buildLayout(values, type) {
    if (!ALIASES[type]) throw new Error('Import type must be pwd or perm');
    const original = values.map(normalizeHeader);
    const id = original.includes('CASE_NUMBER') || original.includes('CASE_NO');
    const employer = type === 'pwd' ? 'EMPLOYER_LEGAL_BUSINESS_NAME' : 'EMP_BUSINESS_NAME';
    if (!id || ![employer, ...ALIASES[type][employer]].some(field => original.includes(field))) return null;
    const seen = new Map();
    const duplicates = [];
    const headers = original.map(header => {
        if (!header) return '';
        const count = (seen.get(header) || 0) + 1;
        seen.set(header, count);
        if (count > 1) duplicates.push(header);
        return count > 1 ? `${header}__${count}` : header;
    });
    const mapped = {};
    const missing = [];
    for (const [canonical, aliases] of Object.entries(ALIASES[type])) {
        const source = [canonical, ...aliases].find(field => headers.includes(field));
        if (source) mapped[canonical] = source;
        else missing.push(canonical);
    }
    return { headers, mapped, missing, duplicates };
}

function excelDateToJSDate(value, { date1904 = false } = {}) {
    if (isMissing(value)) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) && value.getUTCFullYear() > 1970 && value.getUTCFullYear() < 2101 ? value : null;
    if (typeof value === 'number' || (typeof value === 'string' && /^\d{5}(?:\.\d+)?$/.test(value.trim()))) {
        const date = new Date(Math.round((Number(value) - (date1904 ? 24107 : 25569)) * 86400000));
        return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970 && date.getUTCFullYear() < 2101 ? date : null;
    }
    const text = String(value).trim();
    let parts = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/);
    let year, month, day;
    if (parts) [year, month, day] = parts.slice(1, 4).map(Number);
    else {
        parts = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i);
        if (!parts) return null;
        [month, day, year] = parts.slice(1).map(Number);
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year <= 1970 || year > 2100 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    // Dates in disclosure files describe calendar days, not local time zones.
    return date;
}

function parseNumber(value) {
    if (isMissing(value)) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim().replace(/^\$\s*/, '');
    if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(text)) return null;
    return Number(text.replaceAll(',', ''));
}

function normalizeRecord(record, type, { layout, date1904 = false, issues = [] } = {}) {
    if (layout) {
        for (const [canonical, source] of Object.entries(layout.mapped)) record[canonical] = record[source];
        for (const field of layout.missing) record[field] = null;
    }
    record.CASE_NUMBER = isMissing(record.CASE_NUMBER) ? null : String(record.CASE_NUMBER).trim();
    const raw = {};
    for (const field of DATE_FIELDS) {
        if (record[field] === undefined) continue;
        const original = record[field];
        record[field] = excelDateToJSDate(original, { date1904 });
        if (!isMissing(original) && record[field] === null) {
            raw[field] = original;
            issues.push({ field, reason: 'invalid_date', value: original });
        }
    }
    for (const field of NUMBER_FIELDS) {
        if (record[field] === undefined) continue;
        const original = record[field];
        record[field] = parseNumber(original);
        if (!isMissing(original) && record[field] === null) {
            raw[field] = original;
            issues.push({ field, reason: 'invalid_number', value: original });
        }
    }
    const units = { hr: 'Hour', hourly: 'Hour', hour: 'Hour', yr: 'Year', yearly: 'Year', year: 'Year',
        wk: 'Week', weekly: 'Week', week: 'Week', bi: 'Bi-Weekly', 'bi-weekly': 'Bi-Weekly',
        mth: 'Month', monthly: 'Month', month: 'Month' };
    for (const field of ['PWD_UNIT_OF_PAY', 'JOB_OPP_WAGE_PER']) {
        if (record[field] !== undefined) record[field] = isMissing(record[field]) ? null
            : units[String(record[field]).trim().toLowerCase()] || String(record[field]).trim();
    }
    for (const field of Object.keys(ALIASES[type])) {
        if (NUMBER_FIELDS.includes(field) || DATE_FIELDS.includes(field) || record[field] == null) continue;
        record[field] = isMissing(record[field]) ? null : String(record[field]).trim();
    }
    const fields = type === 'pwd'
        ? { EMPLOYER_LEGAL_BUSINESS_NAME: 'EMPLOYER_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMPLOYER_CITY: 'EMPLOYER_CITY_LOWER' }
        : { EMP_BUSINESS_NAME: 'EMP_BUSINESS_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMP_CITY: 'EMP_CITY_LOWER' };
    for (const [source, target] of Object.entries(fields)) record[target] = isMissing(record[source]) ? '' : String(record[source]).toLowerCase();
    if (Object.keys(raw).length) record._DOL_RAW_VALUES = raw;
    return record;
}

function eventTime(record, type) {
    const fields = type === 'perm' ? ['DECISION_DATE'] : ['DETERMINATION_DATE', 'REDETERMINATION_DATE', 'WITHDRAWAL_DATE', 'CENTER_DIRECTOR_REVIEW_DATE'];
    return Math.max(0, ...fields.map(field => record[field] instanceof Date ? record[field].getTime() : 0));
}

module.exports = { ALIASES, DATE_FIELDS, NUMBER_FIELDS, isMissing, normalizeHeader, buildLayout, excelDateToJSDate, parseNumber, normalizeRecord, eventTime };
