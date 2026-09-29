// Bank / credit-card statement parsing: CSV, XLSX, and HTML/XML "xls" exports.
// Dependency-free so no third-party code ever touches the statements.

// ---------- file decoding ----------

export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    // Israeli banks frequently export in Windows-1255 (Hebrew).
    text = new TextDecoder('windows-1255').decode(u8);
  }
  return text.replace(/^﻿/, '');
}

export async function readFileRows(fileName, buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8[0] === 0x50 && u8[1] === 0x4b) return readXLSX(u8);
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) {
    throw new Error('xls-binary');
  }
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) {
    throw new Error('pdf');
  }
  const text = decodeText(u8);
  if (/<table[\s>]/i.test(text)) return parseHTMLTable(text);
  if (/<Workbook[\s>]/i.test(text) && /<Row[\s>]/i.test(text)) return parseSpreadsheetML(text);
  return parseCSV(text);
}

// ---------- CSV ----------

// Pick the delimiter that yields the most rows sharing one (multi-column) width.
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const widths = new Map();
    for (const r of parseCSV(sample, d)) if (r.length > 1) widths.set(r.length, (widths.get(r.length) || 0) + 1);
    const score = Math.max(0, ...widths.values());
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function parseCSV(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [], field = '', inQ = false, atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQ) {
      if (ch !== '"') field += ch;
      else if (next === '"') { field += '"'; i++; }
      else if (next === undefined || next === delimiter || next === '\n' || next === '\r') inQ = false;
      else field += ch; // stray quote inside a quoted field
      continue;
    }
    // Quotes only open a quoted field at its start: Hebrew text such as בע"מ / ש"ח
    // often appears unescaped in bank exports.
    if (ch === '"' && atStart) { inQ = true; atStart = false; continue; }
    atStart = false;
    if (ch === delimiter) { row.push(field); field = ''; atStart = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; atStart = true;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// ---------- HTML / SpreadsheetML ("xls" that is really markup) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const cellText = html => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
  .replace(/\s+/g, ' ').trim();

export function parseHTMLTable(text) {
  const rows = [];
  for (const tr of text.match(/<tr[\s>][\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => cellText(m[1]));
    if (cells.some(c => c !== '')) rows.push(cells);
  }
  return rows;
}

export function parseSpreadsheetML(text) {
  const rows = [];
  for (const r of text.match(/<Row[\s>][\s\S]*?<\/Row>/g) || []) {
    const cells = [...r.matchAll(/<Cell[^>]*?(?:\/>|>([\s\S]*?)<\/Cell>)/g)].map(m => cellText(m[1] || ''));
    if (cells.some(c => c !== '')) rows.push(cells);
  }
  return rows;
}

// ---------- XLSX (zip + XML) ----------

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('bad-zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad-zip');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async name => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const raw = u8.subarray(start, start + f.csize);
    const bytes = f.method === 0 ? raw : f.method === 8 ? await inflateRaw(raw) : null;
    if (!bytes) throw new Error('bad-zip');
    return dec.decode(bytes);
  };
  read.names = [...files.keys()];
  return read;
}

// Some generators (e.g. .NET OpenXML) prefix every tag: <x:row>, <x:c>, <x:t>.
const stripNs = xml => xml.replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, '<$1');

const xmlText = s => decodeEntities(s.replace(/<[^>]*>/g, ''));

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function parseSheetXML(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1] || 'n';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = xmlText((body.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
      else if (v !== undefined) val = type === 'n' ? Number(v) : decodeEntities(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    if (row.some(c => String(c).trim() !== '')) rows.push(row);
  }
  return rows;
}

export async function readXLSX(u8) {
  const read = await unzip(u8);
  const find = re => read.names.filter(n => re.test(n));
  const sharedName = find(/(^|\/)sharedStrings\.xml$/i)[0];
  const sharedXml = sharedName ? stripNs(await read(sharedName)) : null;
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m =>
      [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map(t => decodeEntities(t[1])).join(''))
    : [];
  // Sheet file names vary between exporters; take every worksheet in natural order.
  const sheets = find(/(^|\/)worksheets\/[^/]+\.xml$/i)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let best = [], bestHasHeader = false;
  for (const name of sheets) {
    const rows = parseSheetXML(stripNs(await read(name)), shared);
    const hasHeader = findHeaderRow(rows) >= 0;
    if ((hasHeader && !bestHasHeader) || (hasHeader === bestHasHeader && rows.length > best.length)) {
      best = rows; bestHasHeader = hasHeader;
    }
  }
  return best;
}

// ---------- values ----------

export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).replace(/[‎‏‪-‮\s]/g, '');
  s = s.replace(/₪|ש["״]ח|NIS|ILS|[$€£]/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}

const pad = n => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1970 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fromSerial(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return validDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function parseDate(v) {
  if (typeof v === 'number') return v > 20000 && v < 80000 ? fromSerial(v) : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) return fromSerial(Number(s));
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?!\d)/);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += y > 70 ? 1900 : 2000;
    return validDate(y, +m[2], +m[1]);
  }
  return null;
}

// ---------- column detection ----------

const norm = s => String(s ?? '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Ordered from most to least preferred. "=" prefix means exact match.
const PATTERNS = {
  date: ['=תאריך', 'תאריך עסקה', 'תאריך רכישה', 'תאריך הפעולה', '=date', 'transaction date', 'תאריך ערך', 'תאריך'],
  description: ['שם בית העסק', 'שם בית עסק', 'תיאור', 'פרטים', 'הפעולה', 'description', 'details', 'merchant', 'payee'],
  debit: ['=חובה', '=בחובה', '=חיוב', '=debit', 'סכום בחובה', 'debit'],
  credit: ['=זכות', '=בזכות', '=credit', 'סכום בזכות', 'credit'],
  amount: ['סכום חיוב', 'סכום החיוב', 'סכום בש"ח', 'סכום בש״ח', '=סכום', 'סכום', '=amount', 'amount'],
};

function matches(cell, pattern) {
  return pattern.startsWith('=') ? cell === pattern.slice(1) : cell.includes(pattern);
}

export function detectColumns(header) {
  const cells = header.map(norm);
  const used = new Set();
  const map = {};
  for (const role of ['date', 'description', 'debit', 'credit', 'amount']) {
    map[role] = -1;
    outer: for (const p of PATTERNS[role]) {
      for (let i = 0; i < cells.length; i++) {
        if (!used.has(i) && cells[i] && matches(cells[i], p)
          && !(role !== 'date' && cells[i].includes('תאריך'))
          && !(role === 'amount' && /יתרה|balance|מקור|עסקה מקורי/.test(cells[i]))) {
          map[role] = i; used.add(i); break outer;
        }
      }
    }
  }
  if (map.debit >= 0 && map.credit >= 0) map.amount = -1; // prefer split columns
  // Credit-card exports list charges as positive numbers.
  map.invert = cells.some(c => c.includes('שם בית העסק') || c.includes('שם בית עסק') || c.includes('סכום חיוב'));
  return map;
}

export function findHeaderRow(rows) {
  let best = -1, bestScore = 1;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const m = detectColumns(rows[r]);
    const score = (m.date >= 0) + (m.description >= 0) + (m.amount >= 0 || m.debit >= 0 || m.credit >= 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

export function buildTransactions(rows, headerRow, map, { invert = false } = {}) {
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const date = parseDate(row[map.date]);
    if (!date) continue;
    let amount;
    if (map.amount >= 0) amount = parseAmount(row[map.amount]);
    else {
      const d = parseAmount(row[map.debit]), c = parseAmount(row[map.credit]);
      amount = d === null && c === null ? null : (c || 0) - Math.abs(d || 0);
    }
    if (amount === null || amount === 0) continue;
    if (invert) amount = -amount;
    const description = String(row[map.description] ?? '').replace(/\s+/g, ' ').trim() || '(ללא תיאור)';
    out.push({ date, description, amount: Math.round(amount * 100) / 100 });
  }
  return out;
}
