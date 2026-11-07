const programs = {
    h1b: {
        collection: 'h1bcases', company: 'EMPLOYER_NAME_LOWER', employer: 'EMPLOYER_NAME',
        city: 'EMPLOYER_CITY_LOWER', state: 'EMPLOYER_STATE', date: 'DECISION_DATE', year: 'decisionYear',
        fields: ['CASE_NUMBER', 'CASE_STATUS', 'VISA_CLASS', 'EMPLOYER_NAME', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
            'JOB_TITLE', 'PWD_SOC_CODE', 'PWD_SOC_TITLE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO',
            'WAGE_UNIT_OF_PAY', 'WORKSITE_CITY', 'WORKSITE_STATE', 'TOTAL_WORKER_POSITIONS',
            'DECISION_DATE', 'RECEIVED_DATE', 'ORIGINAL_CERT_DATE', 'BEGIN_DATE', 'END_DATE'],
    },
    pwd: {
        collection: 'cases', company: 'EMPLOYER_NAME_LOWER', employer: 'EMPLOYER_LEGAL_BUSINESS_NAME',
        city: 'EMPLOYER_CITY_LOWER', state: 'EMPLOYER_STATE', date: 'DETERMINATION_DATE', year: 'determinationYear',
        fields: ['CASE_NUMBER', 'CASE_STATUS', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
            'JOB_TITLE', 'VISA_CLASS', 'NAICS_CODE', 'PWD_WAGE_RATE', 'PWD_UNIT_OF_PAY', 'PWD_OES_WAGE_LEVEL',
            'PWD_SOC_CODE', 'PWD_SOC_TITLE', 'DETERMINATION_DATE', 'RECEIVED_DATE', 'PWD_WAGE_EXPIRATION_DATE'],
    },
    perm: {
        collection: 'permcases', company: 'EMP_BUSINESS_NAME_LOWER', employer: 'EMP_BUSINESS_NAME',
        city: 'EMP_CITY_LOWER', state: 'EMP_STATE', date: 'DECISION_DATE', year: 'decisionYear',
        fields: ['CASE_NUMBER', 'CASE_STATUS', 'EMP_BUSINESS_NAME', 'EMP_CITY', 'EMP_STATE', 'JOB_TITLE',
            'VISA_CLASS', 'EMP_NAICS_CODE', 'JOB_OPP_WAGE_FROM', 'JOB_OPP_WAGE_TO', 'JOB_OPP_WAGE_PER',
            'PWD_SOC_CODE', 'PWD_SOC_TITLE', 'JOB_OPP_PWD_NUMBER', 'DECISION_DATE', 'RECEIVED_DATE'],
    },
};

const indexNames = {
    recent: 'search_recent_v4', company: 'search_company_v3', title: 'search_title_v3',
    city: 'search_city_v3', state: 'search_state_v3', received: 'search_received_v3',
};

function searchIndexes(program) {
    const config = programs[program];
    const sort = { [config.date]: -1, _id: 1 };
    const filters = [config.company, 'JOB_TITLE_LOWER', config.city, config.state, 'RECEIVED_DATE', 'CASE_NUMBER'];
    function covered(field, direction, fields) {
        const key = { [field]: direction, ...sort };
        for (const extra of fields) if (!(extra in key)) key[extra] = 1;
        return key;
    }
    return [
        { name: indexNames.recent, key: { ...sort, ...Object.fromEntries(filters.map(field => [field, 1])), CASE_STATUS: 1 } },
        ...Object.entries({ company: config.company, title: 'JOB_TITLE_LOWER', city: config.city,
            state: config.state, received: 'RECEIVED_DATE' }).map(([name, field]) => ({
            name: indexNames[name], key: covered(field, name === 'received' ? -1 : 1,
                name === 'company' || name === 'title' ? [...filters, 'CASE_STATUS'] : name === 'received' ? []
                    : [config.city, config.state, 'RECEIVED_DATE', 'CASE_NUMBER', 'CASE_STATUS']),
        })),
    ];
}

function addSearchIndexes(schema, program) {
    for (const { name, key } of searchIndexes(program)) schema.index(key, { name });
}

module.exports = { programs, indexNames, searchIndexes, addSearchIndexes };
