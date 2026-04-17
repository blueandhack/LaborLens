use pwd_cases;

// --- PWD CASES INDEXES ---
// Existing Compound Index (Used heavily for the default sort)
db.cases.createIndex({ DETERMINATION_DATE: -1, EMPLOYER_LEGAL_BUSINESS_NAME: 1 });

// Single Field Indexes for Searching (PWD)
db.cases.createIndex({ EMPLOYER_LEGAL_BUSINESS_NAME: 1 }); // Used for name searches
db.cases.createIndex({ EMPLOYER_CITY: 1 }); // Used for location searches
db.cases.createIndex({ EMPLOYER_STATE: 1 }); // Used for location searches
db.cases.createIndex({ CASE_NUMBER: 1 }); // Used for exact case matching
db.cases.createIndex({ JOB_TITLE: 1 }); // Used for job title matches
db.cases.createIndex({ RECEIVED_DATE: -1 }); // Used for received date bounds
db.cases.createIndex({ DETERMINATION_DATE: -1 }); // Keep a general sort index

// --- PERM CASES INDEXES ---
// Compound Index (Used for the default PERM sort)
db.permcases.createIndex({ DECISION_DATE: -1, EMP_BUSINESS_NAME: 1 });

// Single Field Indexes for Searching (PERM)
db.permcases.createIndex({ EMP_BUSINESS_NAME: 1 });
db.permcases.createIndex({ EMP_CITY: 1 });
db.permcases.createIndex({ EMP_STATE: 1 });
db.permcases.createIndex({ CASE_NUMBER: 1 });
db.permcases.createIndex({ JOB_TITLE: 1 });
db.permcases.createIndex({ RECEIVED_DATE: -1 });
db.permcases.createIndex({ DECISION_DATE: -1 });

// Critical index for the JOIN ($lookup) operation in PERM search
db.permcases.createIndex({ JOB_OPP_PWD_NUMBER: 1 });
