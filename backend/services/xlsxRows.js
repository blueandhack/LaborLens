const unzipper = require('unzipper');
const { SaxesParser } = require('saxes');
const { StringDecoder } = require('string_decoder');

// Read ZIP members in an explicit order. ExcelJS's WorkbookReader can emit
// sheets before their shared strings, and can retain large XML event batches.
async function* xmlValues(entry, configure, maxBytes) {
    const input = entry.stream();
    const decoder = new StringDecoder('utf8');
    const parser = new SaxesParser();
    let pending = [];
    let bytes = 0;
    configure(parser, value => pending.push(value));
    try {
        for await (const chunk of input) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error(`Workbook XML exceeds size limit: ${entry.path}`);
            parser.write(decoder.write(chunk));
            for (const value of pending) yield value;
            pending = [];
        }
        parser.write(decoder.end()).close();
        for (const value of pending) yield value;
    } finally {
        input.destroy();
    }
}

const tag = node => (typeof node === 'string' ? node : node.name).split(':').pop();

async function readSharedStrings(entry) {
    if (!entry) return [];
    const strings = [];
    const configure = (parser, emit) => {
        let text = '';
        let inText = false;
        let phonetic = false;
        parser.on('opentag', node => {
            if (tag(node) === 'si') text = '';
            if (tag(node) === 'rPh') phonetic = true;
            if (tag(node) === 't') inText = !phonetic;
        });
        parser.on('text', value => { if (inText) text += value; });
        parser.on('closetag', node => {
            if (tag(node) === 't') inText = false;
            if (tag(node) === 'rPh') phonetic = false;
            if (tag(node) === 'si') emit(text);
        });
    };
    for await (const value of xmlValues(entry, configure, 256 * 1024 * 1024)) strings.push(value);
    return strings;
}

function columnNumber(reference) {
    let column = 0;
    for (const letter of reference.match(/^[A-Z]+/i)?.[0] || '') column = column * 26 + letter.toUpperCase().charCodeAt(0) - 64;
    if (column > 16384) throw new Error('Invalid worksheet column');
    return column;
}

async function* readWorkbookRows(filePath) {
    const archive = await unzipper.Open.file(filePath);
    const strings = await readSharedStrings(archive.files.find(entry => entry.path === 'xl/sharedStrings.xml'));
    const sheets = archive.files.filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path))
        .sort((a, b) => Number(a.path.match(/sheet(\d+)/)[1]) - Number(b.path.match(/sheet(\d+)/)[1]));
    for (const sheet of sheets) {
        const configure = (parser, emit) => {
            let row;
            let cell;
            let field;
            parser.on('opentag', node => {
                const name = tag(node);
                if (name === 'row') row = { sheet: sheet.path, number: Number(node.attributes.r), values: [] };
                if (name === 'c' && row) cell = { column: columnNumber(node.attributes.r || '') || row.values.length || 1, type: node.attributes.t, value: '', text: '' };
                if (cell && ['v', 't'].includes(name)) field = name;
            });
            parser.on('text', value => {
                if (!cell || !field) return;
                if (field === 'v') cell.value += value;
                else cell.text += value;
                if (cell.value.length + cell.text.length > 1024 * 1024) throw new Error('Workbook cell exceeds size limit');
            });
            parser.on('closetag', node => {
                const name = tag(node);
                if (name === 'v' || name === 't') field = null;
                if (name === 'c' && cell && row) {
                    let value;
                    if (cell.type === 's') {
                        value = strings[Number(cell.value)];
                        if (value === undefined) throw new Error('Invalid workbook shared string reference');
                    } else if (cell.type === 'inlineStr') value = cell.text;
                    else if (cell.type === 'str' || cell.type === 'd') value = cell.value;
                    else if (cell.type === 'e') value = null;
                    else if (cell.type === 'b') value = cell.value === '1';
                    else value = cell.value === '' ? null : Number(cell.value);
                    row.values[cell.column] = value;
                    cell = null;
                }
                if (name === 'row' && row) { emit(row); row = null; }
            });
        };
        yield* xmlValues(sheet, configure, 2 * 1024 * 1024 * 1024);
    }
}

module.exports = { readWorkbookRows };
