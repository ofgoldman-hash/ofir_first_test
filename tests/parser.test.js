import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  parseAmount, parseDate, parseCSV, detectColumns, findHeaderRow, buildTransactions,
  readFileRows, decodeText, parseHTMLTable,
} from '../js/parser.js';

test('parseAmount handles Israeli formats', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('-1,234.56'), -1234.56);
  assert.equal(parseAmount('1,234.56-'), -1234.56);
  assert.equal(parseAmount('₪ 250'), 250);
  assert.equal(parseAmount('(100)'), -100);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(42), 42);
});

test('parseDate handles common formats and Excel serials', () => {
  assert.equal(parseDate('05/03/2026'), '2026-03-05');
  assert.equal(parseDate('5.3.26'), '2026-03-05');
  assert.equal(parseDate('2026-03-05'), '2026-03-05');
  assert.equal(parseDate(46086), '2026-03-05');
  assert.equal(parseDate('סה"כ'), null);
  assert.equal(parseDate('32/01/2026'), null);
});

test('CSV with quotes and Hebrew bank headers (debit/credit)', () => {
  const csv = 'דוח תנועות\n\nתאריך,תאריך ערך,תיאור,אסמכתא,חובה,זכות,יתרה\n'
    + '01/03/2026,01/03/2026,"משכורת, חברה בע""מ",1,,"15,000.00","20,000.00"\n'
    + '02/03/2026,02/03/2026,שופרסל דיל,2,350.40,,"19,649.60"\n';
  const rows = parseCSV(csv);
  const h = findHeaderRow(rows);
  assert.equal(h, 1);
  const map = detectColumns(rows[h]);
  assert.deepEqual([map.date, map.description, map.debit, map.credit, map.amount], [0, 2, 4, 5, -1]);
  assert.equal(map.invert, false);
  const txs = buildTransactions(rows, h, map);
  assert.deepEqual(txs, [
    { date: '2026-03-01', description: 'משכורת, חברה בע"מ', amount: 15000 },
    { date: '2026-03-02', description: 'שופרסל דיל', amount: -350.4 },
  ]);
});

test('credit card statement is detected and inverted', () => {
  const rows = parseCSV('תאריך עסקה;שם בית העסק;סכום עסקה;סכום חיוב;הערות\n10/03/2026;WOLT;120;120;\n;סה"כ;;120;\n');
  const map = detectColumns(rows[0]);
  assert.equal(map.amount, 3);
  assert.equal(map.invert, true);
  const txs = buildTransactions(rows, 0, map, { invert: map.invert });
  assert.deepEqual(txs, [{ date: '2026-03-10', description: 'WOLT', amount: -120 }]);
});

test('Windows-1255 text is decoded', () => {
  const bytes = new Uint8Array([0xf9, 0xec, 0xe5, 0xed]); // "שלום"
  assert.equal(decodeText(bytes), 'שלום');
});

test('HTML table disguised as xls', async () => {
  const html = '<html><body><table><tr><th>תאריך</th><th>תיאור</th><th>סכום</th></tr>'
    + '<tr><td>01/02/2026</td><td>חברת החשמל &amp; בע&quot;מ</td><td>-450.00</td></tr></table></body></html>';
  const rows = await readFileRows('x.xls', new TextEncoder().encode(html));
  assert.deepEqual(rows, parseHTMLTable(html));
  assert.equal(rows[1][1], 'חברת החשמל & בע"מ');
});

// Minimal zip writer for building an .xlsx fixture.
function zip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = deflateRawSync(enc.encode(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameB, data);
    centrals.push(central, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

test('XLSX with shared strings and date serials', async () => {
  const xlsx = zip({
    'xl/sharedStrings.xml': '<sst><si><t>תאריך</t></si><si><t>תיאור</t></si><si><t>סכום</t></si><si><r><t>אל </t></r><r><t>על</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
      + '<row r="2"><c r="A2"><v>46086</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-3200.5</v></c></row>'
      + '</sheetData></worksheet>',
  });
  const rows = await readFileRows('s.xlsx', xlsx);
  const h = findHeaderRow(rows);
  const txs = buildTransactions(rows, h, detectColumns(rows[h]));
  assert.deepEqual(txs, [{ date: '2026-03-05', description: 'אל על', amount: -3200.5 }]);
});

test('binary xls and pdf are rejected with a clear error', async () => {
  await assert.rejects(readFileRows('a.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0])), /xls-binary/);
  await assert.rejects(readFileRows('a.pdf', new TextEncoder().encode('%PDF-1.4')), /pdf/);
});

test('unescaped Hebrew quotes (בע"מ, ש"ח) inside unquoted fields', () => {
  const rows = parseCSV('תאריך,תיאור,סכום\n10/10/2025,ישראכרט בע"מ,-100\n11/10/2025,"עמלה ש""ח",-5\n12/10/2025,"מחיר 5"" מסך",-9\n');
  assert.deepEqual(rows.slice(1), [
    ['10/10/2025', 'ישראכרט בע"מ', '-100'],
    ['11/10/2025', 'עמלה ש"ח', '-5'],
    ['12/10/2025', 'מחיר 5" מסך', '-9'],
  ]);
});

test('delimiter detection ignores commas inside quoted amounts', () => {
  const rows = parseCSV('תאריך;תיאור;סכום\n01/01/2026;משכורת;"21,500.00"\n02/01/2026;חשמל בע"מ;"-1,200.00"\n');
  assert.deepEqual(rows[2], ['02/01/2026', 'חשמל בע"מ', '-1,200.00']);
});

test('XLSX with prefixed tags, custom sheet names and a summary sheet first', async () => {
  const xlsx = zip({
    'xl/sharedStrings.xml': '<x:sst><x:si><x:t>תאריך</x:t></x:si><x:si><x:t>תיאור</x:t></x:si><x:si><x:t>סכום</x:t></x:si><x:si><x:t>ארנונה</x:t></x:si></x:sst>',
    'xl/worksheets/summary.xml': '<x:worksheet><x:sheetData>'
      + '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>סיכום</x:t></x:is></x:c></x:row>'
      + '<x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:v>2</x:v></x:c></x:row>'
      + '<x:row r="4"><x:c r="A4"><x:v>3</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    'xl/worksheets/transactions.xml': '<x:worksheet><x:sheetData>'
      + '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c></x:row>'
      + '<x:row r="2"><x:c r="A2"><x:v>46086</x:v></x:c><x:c r="B2" t="s"><x:v>3</x:v></x:c><x:c r="C2"><x:v>-820</x:v></x:c></x:row>'
      + '</x:sheetData></x:worksheet>',
  });
  const rows = await readFileRows('s.xlsx', xlsx);
  const h = findHeaderRow(rows);
  assert.deepEqual(buildTransactions(rows, h, detectColumns(rows[h])),
    [{ date: '2026-03-05', description: 'ארנונה', amount: -820 }]);
});
