// DOL's published FY2010 XLSX omits VISA_CLASS. Recover it only for the
// fingerprinted official file, using DOL's documented iCERT program IDs.
const FY2010_SHA256 = '01c905de6fdb49489cca5a93942e04bd453ef671147696e19bfc564fc5c1d43b';
const CASE_NUMBER_REFERENCE = 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/PW_FY17_Record_Layout.pdf';
function canRecoverVisaClass(source) {
    return source?.type === 'h1b' && source.fiscalYear === 2010
        && source.url === 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/H-1B_FY2010.xlsx'
        && source.sha256 === FY2010_SHA256;
}
function recoverVisaClass(caseNumber) {
    const match = String(caseNumber ?? '').trim().match(/^I-(200|201|202|203)-\d{5}-\d{6}$/);
    if (!match) throw Object.assign(new Error('FY2010 visa class cannot be recovered from an unrecognized iCERT case number; source review is required.'), { code: 'SOURCE_REVIEW_REQUIRED', fields: ['VISA_CLASS'] });
    const value = { 200: 'H-1B', 201: 'H-1B1 Chile', 202: 'H-1B1 Singapore', 203: 'E-3 Australian' }[match[1]];
    return { value, sourceField: 'CASE_NUMBER', sourceValue: String(caseNumber).trim(), reference: CASE_NUMBER_REFERENCE,
        reason: `Decoded from DOL iCERT visa ID ${match[1]}; this verified FY2010 workbook omits the VISA_CLASS column.` };
}
module.exports = { FY2010_SHA256, CASE_NUMBER_REFERENCE, canRecoverVisaClass, recoverVisaClass };
