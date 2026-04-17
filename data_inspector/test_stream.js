const exceljs = require('exceljs');
async function test() {
  const options = { sharedStrings: 'cache', hyperlinks: 'ignore', worksheets: 'emit' };
  const workbookReader = new exceljs.stream.xlsx.WorkbookReader('../PW_Disclosure_Data_FY2026_Q1.xlsx', options);
  let count = 0;
  for await (const worksheetReader of workbookReader) {
    for await (const row of worksheetReader) {
      count++;
      if (count > 5) break;
      console.log(row.values.slice(1, 3));
    }
    break;
  }
}
test().catch(console.error);
