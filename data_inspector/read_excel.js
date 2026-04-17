const ExcelJS = require('exceljs');
const options = {
  sharedStrings: 'cache',
  hyperlinks: 'ignore',
  worksheets: 'emit'
};
const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader('../PW_Disclosure_Data_FY2026_Q1.xlsx', options);
workbookReader.read();

workbookReader.on('worksheet', worksheet => {
  worksheet.on('row', row => {
    if (row.number <= 2) {
      console.log(JSON.stringify(row.values));
    }
    if (row.number > 2) {
      process.exit(0);
    }
  });
});
