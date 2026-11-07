const mongoose = require('mongoose');

const permCaseSchema = new mongoose.Schema({
    CASE_NUMBER: { type: String, required: true, unique: true },
    CASE_STATUS: String,
    RECEIVED_DATE: Date,
    DECISION_DATE: Date,
    EMP_BUSINESS_NAME: String,
    EMP_CITY: String,
    EMP_STATE: String,
    JOB_TITLE: String,
    PWD_SOC_CODE: String,
    PWD_SOC_TITLE: String,
    JOB_OPP_PWD_NUMBER: String, // Key field to link with PWD cases
    // Other fields can naturally map into this schema due to `strict: false`
}, { strict: false, timestamps: true });

// Only indexes used by the prefix search API; build/prune explicitly in production.
require('../services/searchConfig').addSearchIndexes(permCaseSchema, 'perm');

module.exports = mongoose.model('PermCase', permCaseSchema);
