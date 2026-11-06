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

// XLSX shared strings can contain hundreds of MB of unique text. Keep a
// compact UTF-8 tape outside the JS heap and decode through a bounded cache.
// An array of JS strings plus the validation index exceeded the 512 MB heap
// on the actual FY2025 PWD workbook.
class SharedStrings {
    constructor() {
        this.blocks = [];
        this.index = [];
        this.count = 0;
        this.offset = 0;
        this.cache = new Map();
        this.cacheBytes = 0;
    }
    add(text) {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > 1024 * 1024) throw new Error('Workbook shared string exceeds size limit');
        let block = this.blocks[this.blocks.length - 1];
        if (!block || this.offset + bytes > block.length) {
            block = Buffer.allocUnsafe(Math.max(4 * 1024 * 1024, bytes));
            this.blocks.push(block);
            this.offset = 0;
        }
        const group = Math.floor(this.count / 65536);
        const slot = (this.count % 65536) * 3;
        this.index[group] ||= new Uint32Array(65536 * 3);
        this.index[group][slot] = this.blocks.length - 1;
        this.index[group][slot + 1] = this.offset;
        this.index[group][slot + 2] = bytes;
        block.write(text, this.offset, bytes, 'utf8');
        this.offset += bytes;
        this.count++;
    }
    get(number) {
        if (!Number.isInteger(number) || number < 0 || number >= this.count) return undefined;
        if (this.cache.has(number)) return this.cache.get(number);
        const index = this.index[Math.floor(number / 65536)];
        const slot = (number % 65536) * 3;
        const start = index[slot + 1];
        const value = this.blocks[index[slot]].toString('utf8', start, start + index[slot + 2]);
        this.cache.set(number, value);
        this.cacheBytes += value.length * 2 + 48;
        while (this.cache.size > 10000 || this.cacheBytes > 16 * 1024 * 1024) {
            const first = this.cache.keys().next().value;
            this.cacheBytes -= this.cache.get(first).length * 2 + 48;
            this.cache.delete(first);
        }
        return value;
    }
}

async function readSharedStrings(entry) {
    const strings = new SharedStrings();
    if (!entry) return strings;
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
    for await (const value of xmlValues(entry, configure, 256 * 1024 * 1024)) strings.add(value);
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
    let date1904 = false;
    const workbook = archive.files.find(entry => entry.path === 'xl/workbook.xml');
    if (workbook) {
        for await (const value of xmlValues(workbook, (parser, emit) => {
            parser.on('opentag', node => { if (tag(node) === 'workbookPr') emit(['1', 'true'].includes(node.attributes.date1904)); });
        }, 2 * 1024 * 1024)) date1904 = value;
    }
    const formats = new Map();
    const styles = [];
    const styleFile = archive.files.find(entry => entry.path === 'xl/styles.xml');
    if (styleFile) {
        for await (const item of xmlValues(styleFile, (parser, emit) => {
            let inCellXfs = false;
            parser.on('opentag', node => {
                if (tag(node) === 'cellXfs') inCellXfs = true;
                if (tag(node) === 'numFmt') emit({ format: Number(node.attributes.numFmtId), value: node.attributes.formatCode });
                if (tag(node) === 'xf' && inCellXfs) emit({ style: Number(node.attributes.numFmtId) });
            });
            parser.on('closetag', node => { if (tag(node) === 'cellXfs') inCellXfs = false; });
        }, 8 * 1024 * 1024)) {
            if (item.format !== undefined) formats.set(item.format, item.value);
            else styles.push(item.style);
        }
    }
    const strings = await readSharedStrings(archive.files.find(entry => entry.path === 'xl/sharedStrings.xml'));
    const sheets = archive.files.filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path))
        .sort((a, b) => Number(a.path.match(/sheet(\d+)/)[1]) - Number(b.path.match(/sheet(\d+)/)[1]));
    for (const sheet of sheets) {
        const configure = (parser, emit) => {
            let row;
            let cell;
            let field;
            let ordinal = 0;
            parser.on('opentag', node => {
                const name = tag(node);
                if (name === 'row') { ordinal++; row = { sheet: sheet.path, number: Number(node.attributes.r) || ordinal, values: [], date1904, errors: [] }; }
                if (name === 'c' && row) cell = { column: columnNumber(node.attributes.r || '') || row.values.length || 1, type: node.attributes.t, style: Number(node.attributes.s || 0), value: '', text: '' };
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
                        value = strings.get(Number(cell.value));
                        if (value === undefined) throw new Error('Invalid workbook shared string reference');
                    } else if (cell.type === 'inlineStr') value = cell.text;
                    else if (cell.type === 'str' || cell.type === 'd') value = cell.value;
                    else if (cell.type === 'e') { value = null; row.errors.push({ column: cell.column, value: cell.value }); }
                    else if (cell.type === 'b') value = cell.value === '1';
                    else {
                        value = cell.value === '' ? null : Number(cell.value);
                        if (value !== null && !Number.isFinite(value)) {
                            row.errors.push({ column: cell.column, value: cell.value });
                            value = null;
                        }
                        // Respect explicit zero-padding (e.g. a postal code
                        // stored as numeric 1234 with display format 00000).
                        const format = formats.get(styles[cell.style]);
                        if (Number.isInteger(value) && value >= 0 && /^0{2,12}$/.test(format || '')) value = String(value).padStart(format.length, '0');
                    }
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
