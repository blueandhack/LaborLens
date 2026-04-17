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

// Text index for search functionality
permCaseSchema.index({
    EMP_BUSINESS_NAME: 'text',
    CASE_NUMBER: 'text',
    EMP_ADDR1: 'text',
    EMP_CITY: 'text',
    EMP_STATE: 'text',
    JOB_TITLE: 'text'
}, {
    weights: {
        EMP_BUSINESS_NAME: 10,
        CASE_NUMBER: 5,
        EMP_ADDR1: 2,
        JOB_TITLE: 2
    }
});

// Regular indexes for partial (regex) search performance and standard lookup
permCaseSchema.index({ EMP_BUSINESS_NAME: 1 });
permCaseSchema.index({ EMP_CITY: 1 });
permCaseSchema.index({ EMP_STATE: 1 });
permCaseSchema.index({ JOB_TITLE: 1 });
permCaseSchema.index({ DECISION_DATE: -1 });
permCaseSchema.index({ RECEIVED_DATE: -1 });

// To join/look up PWD Case quickly via JOB_OPP_PWD_NUMBER
permCaseSchema.index({ JOB_OPP_PWD_NUMBER: 1 });

// Compound index for default sorting
permCaseSchema.index({ DECISION_DATE: -1, EMP_BUSINESS_NAME: 1 });

module.exports = mongoose.model('PermCase', permCaseSchema);
