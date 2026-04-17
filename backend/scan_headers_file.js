const exceljs = require('exceljs');
const fs = require('fs');
const filePath = '../PW_Disclosure_Data_FY2023_Q4_revised_form.xlsx';
const options = { sharedStrings: 'cache', hyperlinks: 'ignore', worksheets: 'emit' };

const knownFields = [
    "CASE_NUMBER", "CASE_STATUS", "RECEIVED_DATE", "EMPLOYER_LEGAL_BUSINESS_NAME",
    "EMPLOYER_ADDRESS_1", "EMPLOYER_CITY", "EMPLOYER_STATE", "EMPLOYER_POSTAL_CODE",
    "EMPLOYER_PHONE", "JOB_TITLE", "PWD_SOC_CODE", "PWD_SOC_TITLE", "PWD_WAGE_RATE",
    "PWD_UNIT_OF_PAY", "VISA_CLASS", "DETERMINATION_DATE", "PREVAIL_WAGE_DETERM_DATE",
    "PWD_WAGE_EXPIRATION_DATE"
];

async function scan() {
    const workbookReader = new exceljs.stream.xlsx.WorkbookReader(filePath, options);
    for await (const worksheetReader of workbookReader) {
        for await (const row of worksheetReader) {
            if (row.number === 1) {
                const headers = row.values.slice(1);
                const missing = headers.filter(h => h && !knownFields.includes(h));
                fs.writeFileSync('missing_headers.json', JSON.stringify({ headers, missing }, null, 2));
                console.log("Written to missing_headers.json");
                break;
            }
        }
        break;
    }
}
scan().catch(console.error);
