const fs = require('fs');

const missing = require('./missing_headers.json').missing;

let schemaStr = `const mongoose = require('mongoose');

const caseSchema = new mongoose.Schema({
    CASE_NUMBER: { type: String, required: true, unique: true },
    CASE_STATUS: String,
    RECEIVED_DATE: Date,
    DETERMINATION_DATE: Date,
    PREVAIL_WAGE_DETERM_DATE: Date,
    PWD_WAGE_EXPIRATION_DATE: Date,
    EMPLOYER_LEGAL_BUSINESS_NAME: String,
    EMPLOYER_ADDRESS_1: String,
    EMPLOYER_CITY: String,
    EMPLOYER_STATE: String,
    EMPLOYER_POSTAL_CODE: String,
    EMPLOYER_PHONE: String,
    JOB_TITLE: String,
    PWD_SOC_CODE: String,
    PWD_SOC_TITLE: String,
    PWD_WAGE_RATE: Number,
    PWD_UNIT_OF_PAY: String,
    VISA_CLASS: String,
`;

missing.forEach(field => {
    let type = 'String';
    if (field.includes('DATE')) {
        type = 'Date';
    } else if (field.endsWith('_MONTHS') || field.endsWith('_RATE') || field === 'H2B_HIGHEST_PWD') {
        type = 'Number';
    }
    schemaStr += `    ${field}: ${type},\n`;
});

schemaStr += `}, { strict: false, timestamps: true });

// Text index for search functionality
caseSchema.index({
    EMPLOYER_LEGAL_BUSINESS_NAME: 'text',
    CASE_NUMBER: 'text',
    EMPLOYER_ADDRESS_1: 'text',
    EMPLOYER_CITY: 'text',
    EMPLOYER_STATE: 'text',
    JOB_TITLE: 'text'
}, {
    weights: {
        EMPLOYER_LEGAL_BUSINESS_NAME: 10,
        CASE_NUMBER: 5,
        EMPLOYER_ADDRESS_1: 2,
        JOB_TITLE: 2
    }
});

// Regular indexes for partial (regex) search performance
caseSchema.index({ EMPLOYER_LEGAL_BUSINESS_NAME: 1 });
caseSchema.index({ EMPLOYER_CITY: 1 });
caseSchema.index({ JOB_TITLE: 1 });

module.exports = mongoose.model('Case', caseSchema);
`;

fs.writeFileSync('models/Case.js', schemaStr);
console.log("Updated models/Case.js successfully.");
