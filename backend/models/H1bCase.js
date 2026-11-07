const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    CASE_NUMBER: { type: String, required: true, unique: true },
    CASE_STATUS: String, VISA_CLASS: String,
    RECEIVED_DATE: Date, DECISION_DATE: Date, ORIGINAL_CERT_DATE: Date,
    EMPLOYER_NAME: String, EMPLOYER_CITY: String, EMPLOYER_STATE: String,
    JOB_TITLE: String, PWD_SOC_CODE: String, PWD_SOC_TITLE: String,
    WAGE_RATE_OF_PAY_FROM: Number, WAGE_RATE_OF_PAY_TO: Number, WAGE_UNIT_OF_PAY: String,
}, { strict: false, timestamps: true });

require('../services/searchConfig').addSearchIndexes(schema, 'h1b');
module.exports = mongoose.model('H1bCase', schema, 'h1bcases');
