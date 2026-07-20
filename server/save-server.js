#!/usr/bin/env node
'use strict';

// Local companion service for the "LinkedIn: Hide Applied/Viewed Jobs"
// extension. Run this alongside the browser; the extension POSTs new
// applications here and this process appends them straight into the
// tracker workbook — no browser downloads, no visible notifications.
//
// Must match the extension's src/background.js: PORT and TOKEN below.
//
// There's one workbook, not two: it's both what the extension writes to
// (date/company/vacancy/link/source) *and* what you fill in by hand
// (CV version, response, interview, notes...). Unlike a naive "rebuild the
// whole workbook every time" approach, this reads the existing .xlsx,
// splices new <row>/<hyperlink> XML into it, and writes it back — so
// anything you've typed into it survives. The extension no longer holds
// the full application history in memory either; it only queues records
// it hasn't managed to append yet.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { exec } = require('child_process');

const PORT = 17845;
const TOKEN = 'lext-9f3c7a2b1e4d6f80';
const OUTPUT_PATH = path.join(__dirname, '..', 'Трекер откликов - AB тест.xlsx');

// Column layout of the "Отклики" sheet. A-D and F are ours (the extension
// writes them); E and G-L are yours (CV version, response, interview,
// notes...) — the append/patch/reconcile code below never touches those.
const COL = {
  DATE: 'A',
  COMPANY: 'B',
  TITLE: 'C',
  LINK: 'D',
  CV_VERSION: 'E', // yours
  SOURCE: 'F',
  RESPONSE: 'G', // yours
  RESPONSE_DATE: 'H', // yours
  INTERVIEW: 'I', // yours
  SECOND_STAGE: 'J', // yours
  OFFER: 'K', // yours
  NOTES: 'L', // yours
};

// cellXfs[4] in this workbook's styles.xml — a plain bordered data-row
// style (no fill), as opposed to index 1 (bold header) or 2 (the
// yellow "this is an example row" highlight). ponytail: coupled to this
// specific workbook's style table; if you ever rebuild styles.xml by hand,
// update this index to match.
const DATA_STYLE = 4;

// zip.js is an ES module; dynamic import() works from this CommonJS script
// regardless, and lets us reuse the exact same zip writer instead of
// duplicating it here. pathToFileURL handles the space in "LinkedIn Opera
// Applets" and Windows drive-letter paths correctly — a raw path string
// isn't a valid specifier.
let zipModulePromise = null;
function loadZipModule() {
  if (!zipModulePromise) zipModulePromise = import(pathToFileURL(path.join(__dirname, '..', 'src', 'zip.js')).href);
  return zipModulePromise;
}

// ---------------------------------------------------------------------
// Minimal ZIP reader (the writer in zip.js only ever stores, never
// compresses — but a file resaved by Excel will use DEFLATE, so this side
// needs to handle both).
// ---------------------------------------------------------------------

function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  const maxCommentLen = 65557; // 22-byte record + up to 65535-byte comment
  const searchStart = Math.max(0, buf.length - maxCommentLen);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('not a valid zip (EOCD not found)');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const CENTRAL_SIG = 0x02014b50;
  const entries = [];
  let pos = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error('malformed central directory entry');
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntryData(buf, entry) {
  const LOCAL_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== LOCAL_SIG) throw new Error('malformed local file header');
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// Returns a Map<partName, Buffer> for every part in the .xlsx, or null if
// the file doesn't exist yet.
function readXlsxParts(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  const parts = new Map();
  for (const entry of entries) {
    parts.set(entry.name, readZipEntryData(buf, entry));
  }
  return parts;
}

// ---------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function inlineStrCell(ref, text, styleIndex) {
  const s = styleIndex ? ` s="${styleIndex}"` : '';
  const t = text ? `<is><t xml:space="preserve">${escapeXml(text)}</t></is>` : '<is><t/></is>';
  return `<c r="${ref}" t="inlineStr"${s}>${t}</c>`;
}

// Job postings carry their id right in the URL we already store as a
// hyperlink — no need for a separate hidden id column to find a row again later.
function extractJobIdFromUrl(url) {
  if (!url) return null;
  let m = /\/jobs\/view\/(\d+)/.exec(url);
  if (m) return { source: 'LinkedIn', jobId: m[1] };
  m = /[?&]jk=([0-9a-f]+)/i.exec(url);
  if (m) return { source: 'Indeed', jobId: m[1] };
  return null;
}

function findWorksheetPartName(parts) {
  if (parts.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  // Fallback for a file Excel has resaved and renamed internally: resolve
  // the first <sheet>'s r:id through workbook.xml.rels.
  const workbookXml = parts.get('xl/workbook.xml')?.toString('utf8');
  const relsXml = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (workbookXml && relsXml) {
    const sheetMatch = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbookXml);
    if (sheetMatch) {
      const relMatch = new RegExp(`<Relationship[^>]*Id="${sheetMatch[1]}"[^>]*Target="([^"]+)"`).exec(relsXml);
      if (relMatch) return `xl/${relMatch[1].replace(/^\.?\//, '')}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

function relsPartNameFor(worksheetPartName) {
  const idx = worksheetPartName.lastIndexOf('/');
  return `${worksheetPartName.slice(0, idx)}/_rels/${worksheetPartName.slice(idx + 1)}.rels`;
}

function parseMaxRowNumber(sheetXml) {
  let max = 1; // row 1 is always the header
  const re = /<row r="(\d+)"/g;
  let m;
  while ((m = re.exec(sheetXml))) {
    max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function parseMaxRid(relsXml) {
  if (!relsXml) return 0;
  let max = 0;
  const re = /Id="rId(\d+)"/g;
  let m;
  while ((m = re.exec(relsXml))) {
    max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// ref like "B12" -> { col: "B", row: 12 }
function parseHyperlinkRefs(sheetXml) {
  const refToRid = new Map();
  const re = /<hyperlink ref="([A-Z]+\d+)" r:id="(rId\d+)"\/>/g;
  let m;
  while ((m = re.exec(sheetXml))) {
    refToRid.set(m[1], m[2]);
  }
  return refToRid;
}

function parseRelationshipTargets(relsXml) {
  const ridToTarget = new Map();
  if (!relsXml) return ridToTarget;
  const re = /<Relationship Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = re.exec(relsXml))) {
    ridToTarget.set(m[1], m[2]);
  }
  return ridToTarget;
}

function emptyRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n</Relationships>`;
}

function insertRelationships(relsXml, relationships) {
  if (!relationships.length) return relsXml;
  const xml = relationships
    .map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(r.target)}" TargetMode="External"/>`)
    .join('');
  return relsXml.replace('</Relationships>', `${xml}</Relationships>`);
}

function insertHyperlinks(sheetXml, hyperlinkTags) {
  if (!hyperlinkTags.length) return sheetXml;
  const xml = hyperlinkTags.join('');
  if (sheetXml.includes('</hyperlinks>')) {
    return sheetXml.replace('</hyperlinks>', `${xml}</hyperlinks>`);
  }
  // No hyperlinks existed on this sheet before — the block has to go right
  // after </dataValidations> if present (schema order), else right after
  // </sheetData>.
  if (sheetXml.includes('</dataValidations>')) {
    return sheetXml.replace('</dataValidations>', `</dataValidations><hyperlinks>${xml}</hyperlinks>`);
  }
  return sheetXml.replace('</sheetData>', `</sheetData><hyperlinks>${xml}</hyperlinks>`);
}

function insertRows(sheetXml, rowsXml) {
  if (!rowsXml.length) return sheetXml;
  return sheetXml.replace('</sheetData>', `${rowsXml.join('')}</sheetData>`);
}

// ---------------------------------------------------------------------
// Cell-text reading — needed to find old rows that have a title/company
// but never got a hyperlink (e.g. recorded before the row's own href was
// available, or a hand-typed row). Cells might be inline strings (how this
// server always writes them) or shared strings (how Excel writes them when
// it resaves the file), so both need handling.
// ---------------------------------------------------------------------

function parseSharedStrings(parts) {
  const xml = parts.get('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += tm[1];
    strings.push(unescapeXml(text));
  }
  return strings;
}

// Returns [{ col, row, text }] for every cell in the sheet.
function parseAllCells(sheetXml, sharedStrings) {
  const cells = [];
  const re = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(sheetXml))) {
    const [, col, rowStr, attrs, content] = m;
    const typeMatch = /\bt="([^"]+)"/.exec(attrs);
    const type = typeMatch ? typeMatch[1] : 'n';
    let text = '';
    if (type === 'inlineStr' && content) {
      const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(content);
      text = tm ? unescapeXml(tm[1]) : '';
    } else if (type === 's' && content) {
      const vm = /<v>(\d+)<\/v>/.exec(content);
      text = vm ? sharedStrings[parseInt(vm[1], 10)] || '' : '';
    }
    cells.push({ col, row: parseInt(rowStr, 10), text });
  }
  return cells;
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Groups every A-L cell's text by row, keyed by row number.
function readRowTexts(sheetXml, sharedStrings) {
  const rows = new Map();
  for (const cell of parseAllCells(sheetXml, sharedStrings)) {
    if (!/^[A-L]$/.test(cell.col)) continue;
    if (!rows.has(cell.row)) rows.set(cell.row, {});
    rows.get(cell.row)[cell.col] = cell.text;
  }
  return rows;
}

// ---------------------------------------------------------------------
// Fresh-workbook bootstrap — only used if OUTPUT_PATH doesn't exist yet
// (first run for a new person using this extension, or the file got moved).
// Just copies a bundled blank copy of the real template: headers, the
// yellow "example row" for guidance, the CV/Да-Нет dropdowns, and the
// formula-driven "Статистика" sheet all come along for free — reproducing
// that by hand in XML would be a second copy of the same design to keep in
// sync forever.
// ---------------------------------------------------------------------

const TEMPLATE_PATH = path.join(__dirname, 'tracker-template.xlsx');

function buildFreshTrackerXlsx() {
  console.log(`[${new Date().toISOString()}] ${OUTPUT_PATH} not found — creating it from the bundled template`);
  return fs.readFileSync(TEMPLATE_PATH);
}

// ---------------------------------------------------------------------
// Missing-link discovery + backfill: an old row can have a title/company
// name with no hyperlink at all (recorded before the row's href was
// available, or typed in by hand) — this lets the content script recognize
// such a job by its exact title/company text while browsing and supply
// the missing link.
// ---------------------------------------------------------------------

function listMissingLinks() {
  const existingParts = readXlsxParts(OUTPUT_PATH);
  if (!existingParts) return [];

  const worksheetName = findWorksheetPartName(existingParts);
  const relsName = relsPartNameFor(worksheetName);
  const sheetXml = existingParts.get(worksheetName)?.toString('utf8');
  if (!sheetXml) return [];
  const sharedStrings = parseSharedStrings(existingParts);

  const refToRid = parseHyperlinkRefs(sheetXml);
  const rowTexts = readRowTexts(sheetXml, sharedStrings);

  const results = [];
  for (const [row, texts] of rowTexts.entries()) {
    if (row === 1) continue; // header
    const missingTitleUrl = !!texts[COL.TITLE] && !refToRid.has(`${COL.TITLE}${row}`);
    const missingCompanyUrl = !!texts[COL.COMPANY] && !refToRid.has(`${COL.COMPANY}${row}`);
    if (!missingTitleUrl && !missingCompanyUrl) continue;
    results.push({
      title: texts[COL.TITLE] || '',
      company: texts[COL.COMPANY] || '',
      source: texts[COL.SOURCE] || 'LinkedIn',
      missingTitleUrl,
      missingCompanyUrl,
    });
  }
  return results;
}

async function backfillLink({ title, titleUrl, company, companyUrl, source }) {
  const existingParts = readXlsxParts(OUTPUT_PATH);
  if (!existingParts) return false;

  const worksheetName = findWorksheetPartName(existingParts);
  const relsName = relsPartNameFor(worksheetName);
  let sheetXml = existingParts.get(worksheetName)?.toString('utf8');
  if (!sheetXml) return false;
  let relsXml = existingParts.get(relsName)?.toString('utf8') || null;
  const sharedStrings = parseSharedStrings(existingParts);

  const refToRid = parseHyperlinkRefs(sheetXml);
  const rowTexts = readRowTexts(sheetXml, sharedStrings);
  const wantSource = source || 'LinkedIn';
  const wantTitle = normalizeText(title);
  const wantCompany = normalizeText(company);

  let changed = false;
  let nextRid = parseMaxRid(relsXml);
  const newRelationships = [];

  for (const [row, texts] of rowTexts.entries()) {
    if (row === 1) continue;
    if (normalizeText(texts[COL.TITLE]) !== wantTitle) continue;
    if ((texts[COL.SOURCE] || 'LinkedIn') !== wantSource) continue;
    // If the row also has company text, require it to match too — guards
    // against two different jobs that happen to share a title. A row with
    // no company text at all can't be checked this way, so title alone
    // (plus source) is treated as good enough.
    if (texts[COL.COMPANY] && wantCompany && normalizeText(texts[COL.COMPANY]) !== wantCompany) continue;

    const titleRef = `${COL.TITLE}${row}`;
    if (titleUrl && texts[COL.TITLE] && !refToRid.has(titleRef)) {
      nextRid += 1;
      const id = `rId${nextRid}`;
      newRelationships.push({ id, target: titleUrl });
      sheetXml = insertHyperlinks(sheetXml, [`<hyperlink ref="${titleRef}" r:id="${id}"/>`]);
      const updated = replaceCellXml(sheetXml, titleRef, inlineStrCell(titleRef, texts[COL.TITLE], DATA_STYLE));
      if (updated) {
        sheetXml = updated;
        refToRid.set(titleRef, id);
        changed = true;
      }
    }

    const companyRef = `${COL.COMPANY}${row}`;
    if (companyUrl && texts[COL.COMPANY] && !refToRid.has(companyRef)) {
      nextRid += 1;
      const id = `rId${nextRid}`;
      newRelationships.push({ id, target: companyUrl });
      sheetXml = insertHyperlinks(sheetXml, [`<hyperlink ref="${companyRef}" r:id="${id}"/>`]);
      const updated = replaceCellXml(sheetXml, companyRef, inlineStrCell(companyRef, texts[COL.COMPANY], DATA_STYLE));
      if (updated) {
        sheetXml = updated;
        refToRid.set(companyRef, id);
        changed = true;
      }
    }
  }

  if (!changed) return false;
  if (newRelationships.length) {
    relsXml = insertRelationships(relsXml || emptyRelsXml(), newRelationships);
  }

  const { buildZip } = await loadZipModule();
  const encoder = new TextEncoder();
  const files = [];
  for (const [name, data] of existingParts.entries()) {
    if (name === worksheetName) {
      files.push({ name, data: encoder.encode(sheetXml) });
    } else if (name === relsName) {
      continue;
    } else {
      files.push({ name, data });
    }
  }
  if (relsXml) {
    files.push({ name: relsName, data: encoder.encode(relsXml) });
  }

  fs.writeFileSync(OUTPUT_PATH, buildZip(files));
  return true;
}

// ---------------------------------------------------------------------
// Hidden Companies sheet: a tab mirroring the "Hide this company" list.
// Unlike "Отклики", nothing here is meant to be hand-edited, so it's
// simplest to just rebuild it wholesale from the full list every time
// rather than diffing/patching it like the append/patch logic above.
// Its sheet number is resolved dynamically (not assumed to be sheet2) —
// this workbook's own sheet2 is "Статистика".
// ---------------------------------------------------------------------

function buildHiddenCompaniesSheetXml(companies) {
  const rows = [`<row r="1">${inlineStrCell('A1', 'Company', 1)}</row>`];
  companies.forEach((name, i) => {
    rows.push(`<row r="${i + 2}">${inlineStrCell(`A${i + 2}`, name)}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<cols><col min="1" max="1" width="40" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

function nextFreeWorksheetPart(parts) {
  let max = 0;
  for (const name of parts.keys()) {
    const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `xl/worksheets/sheet${max + 1}.xml`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSheetPartByName(sheetName, workbookXml, workbookRelsXml) {
  const m = new RegExp(`<sheet name="${escapeRegExp(sheetName)}"[^>]*r:id="(rId\\d+)"`).exec(workbookXml);
  if (!m) return null;
  const relM = new RegExp(`<Relationship Id="${m[1]}"[^>]*Target="([^"]+)"`).exec(workbookRelsXml);
  return relM ? `xl/${relM[1].replace(/^\.?\//, '')}` : null;
}

// Adds the "Hidden Companies" sheet's <sheet>/<Relationship>/<Override>
// entries the first time this runs; a no-op afterwards (found by sheet
// *name*, not by a hardcoded path — "sheet2.xml" already belongs to
// "Статистика" in this workbook).
function ensureHiddenSheetRegistered(parts) {
  let workbookXml = parts.get('xl/workbook.xml').toString('utf8');
  let workbookRelsXml = parts.get('xl/_rels/workbook.xml.rels').toString('utf8');
  let contentTypesXml = parts.get('[Content_Types].xml').toString('utf8');

  if (workbookXml.includes('name="Hidden Companies"')) {
    return { workbookXml, workbookRelsXml, contentTypesXml, sheetPart: findSheetPartByName('Hidden Companies', workbookXml, workbookRelsXml) };
  }

  const ridStr = `rId${parseMaxRid(workbookRelsXml) + 1}`;
  const sheetPart = nextFreeWorksheetPart(parts);
  const sheetFile = sheetPart.replace('xl/worksheets/', '');

  let maxSheetId = 0;
  const sheetIdRe = /sheetId="(\d+)"/g;
  let sm;
  while ((sm = sheetIdRe.exec(workbookXml))) maxSheetId = Math.max(maxSheetId, parseInt(sm[1], 10));

  workbookXml = workbookXml.replace('</sheets>', `<sheet name="Hidden Companies" sheetId="${maxSheetId + 1}" r:id="${ridStr}"/></sheets>`);
  workbookRelsXml = workbookRelsXml.replace(
    '</Relationships>',
    `<Relationship Id="${ridStr}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${sheetFile}"/></Relationships>`
  );
  contentTypesXml = contentTypesXml.replace(
    '</Types>',
    `<Override PartName="/${sheetPart}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
  );
  return { workbookXml, workbookRelsXml, contentTypesXml, sheetPart };
}

async function writeHiddenCompaniesSheet(companies) {
  let existingParts = readXlsxParts(OUTPUT_PATH);
  if (!existingParts) {
    fs.writeFileSync(OUTPUT_PATH, buildFreshTrackerXlsx());
    existingParts = readXlsxParts(OUTPUT_PATH);
  }

  const { workbookXml, workbookRelsXml, contentTypesXml, sheetPart } = ensureHiddenSheetRegistered(existingParts);
  if (!sheetPart) {
    console.error('could not resolve the Hidden Companies sheet part — skipping this write');
    return;
  }

  const encoder = new TextEncoder();
  const overrides = new Map([
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRelsXml],
    ['[Content_Types].xml', contentTypesXml],
    [sheetPart, buildHiddenCompaniesSheetXml(companies)],
  ]);

  const files = [];
  for (const [name, data] of existingParts.entries()) {
    files.push({ name, data: overrides.has(name) ? encoder.encode(overrides.get(name)) : data });
  }
  if (!existingParts.has(sheetPart)) {
    files.push({ name: sheetPart, data: encoder.encode(overrides.get(sheetPart)) });
  }

  const { buildZip } = await loadZipModule();
  fs.writeFileSync(OUTPUT_PATH, buildZip(files));
}

// ---------------------------------------------------------------------
// CV list: read-only. You maintain this sheet by hand (one CV per row, any
// text — a full descriptive name is fine); the content script shows that
// full text in its picker but only stores the leading "CV<n>" token into
// the "Версия CV" column, since that's what the Статистика sheet's
// COUNTIFS formulas match against literally.
// ---------------------------------------------------------------------

const CV_LIST_SHEET_NAME = 'List CVs';

function readCvList() {
  const parts = readXlsxParts(OUTPUT_PATH);
  if (!parts) return [];
  const workbookXml = parts.get('xl/workbook.xml')?.toString('utf8');
  const workbookRelsXml = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbookXml || !workbookRelsXml) return [];
  const sheetPart = findSheetPartByName(CV_LIST_SHEET_NAME, workbookXml, workbookRelsXml);
  const sheetXml = sheetPart && parts.get(sheetPart)?.toString('utf8');
  if (!sheetXml) return [];

  const sharedStrings = parseSharedStrings(parts);
  const cells = parseAllCells(sheetXml, sharedStrings)
    .filter((c) => c.col === 'A' && c.text.trim())
    .sort((a, b) => a.row - b.row);

  return cells.map(({ text }) => {
    const label = text.trim();
    const codeMatch = /^CV\d+/i.exec(label);
    return { label, code: codeMatch ? codeMatch[0].toUpperCase() : label };
  });
}

// ---------------------------------------------------------------------
// Append: build <row>/<hyperlink>/<Relationship> XML for each new record
// and splice it into the existing worksheet. `records` normally only
// carry date/company/companyUrl/title/titleUrl/source (that's all the
// extension knows) — the reconcile/backup path below additionally passes
// through cvVersion/response/responseDate/interview/secondStage/offer/notes
// when restoring a row that had those hand-filled in before it vanished.
// ---------------------------------------------------------------------

function buildRowsForAppend(records, startRow, startRid) {
  const rowsXml = [];
  const hyperlinkTags = [];
  const relationships = [];
  let rid = startRid;

  records.forEach((rec, i) => {
    const r = startRow + i;
    const cells = [inlineStrCell(`${COL.DATE}${r}`, rec.date || '', DATA_STYLE)];

    cells.push(inlineStrCell(`${COL.COMPANY}${r}`, rec.company || '', DATA_STYLE));
    if (rec.companyUrl) {
      rid += 1;
      const id = `rId${rid}`;
      relationships.push({ id, target: rec.companyUrl });
      hyperlinkTags.push(`<hyperlink ref="${COL.COMPANY}${r}" r:id="${id}"/>`);
    }

    cells.push(inlineStrCell(`${COL.TITLE}${r}`, rec.title || '', DATA_STYLE));
    if (rec.titleUrl) {
      rid += 1;
      const id = `rId${rid}`;
      relationships.push({ id, target: rec.titleUrl });
      hyperlinkTags.push(`<hyperlink ref="${COL.TITLE}${r}" r:id="${id}"/>`);
    }

    cells.push(inlineStrCell(`${COL.LINK}${r}`, rec.titleUrl || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.CV_VERSION}${r}`, rec.cvVersion || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.SOURCE}${r}`, rec.source || 'LinkedIn', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.RESPONSE}${r}`, rec.response || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.RESPONSE_DATE}${r}`, rec.responseDate || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.INTERVIEW}${r}`, rec.interview || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.SECOND_STAGE}${r}`, rec.secondStage || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.OFFER}${r}`, rec.offer || '', DATA_STYLE));
    cells.push(inlineStrCell(`${COL.NOTES}${r}`, rec.notes || '', DATA_STYLE));

    rowsXml.push(`<row r="${r}">${cells.join('')}</row>`);
  });

  return { rowsXml, hyperlinkTags, relationships };
}

async function appendRecords(records) {
  const existingParts = readXlsxParts(OUTPUT_PATH);

  if (!existingParts) {
    fs.writeFileSync(OUTPUT_PATH, buildFreshTrackerXlsx());
    return appendRecords(records); // now that it exists, splice in normally
  }

  const worksheetName = findWorksheetPartName(existingParts);
  const relsName = relsPartNameFor(worksheetName);

  let sheetXml = existingParts.get(worksheetName)?.toString('utf8');
  if (!sheetXml) throw new Error(`worksheet part ${worksheetName} missing from existing workbook`);
  let relsXml = existingParts.get(relsName)?.toString('utf8') || null;

  const nextRow = parseMaxRowNumber(sheetXml) + 1;
  const nextRid = parseMaxRid(relsXml);

  const { rowsXml, hyperlinkTags, relationships } = buildRowsForAppend(records, nextRow, nextRid);

  sheetXml = insertRows(sheetXml, rowsXml);
  sheetXml = insertHyperlinks(sheetXml, hyperlinkTags);
  if (relationships.length) {
    relsXml = insertRelationships(relsXml || emptyRelsXml(), relationships);
  }

  const { buildZip } = await loadZipModule();
  const encoder = new TextEncoder();
  const files = [];
  for (const [name, data] of existingParts.entries()) {
    if (name === worksheetName) {
      files.push({ name, data: encoder.encode(sheetXml) });
    } else if (name === relsName) {
      continue; // handled below, in case it's newly created
    } else {
      files.push({ name, data });
    }
  }
  if (relsXml) {
    files.push({ name: relsName, data: encoder.encode(relsXml) });
  }

  fs.writeFileSync(OUTPUT_PATH, buildZip(files));
}

// ---------------------------------------------------------------------
// Backup + self-heal: every 30 minutes, compare the live workbook against
// the last backup and re-append any row (identified by jobId, extracted
// from its own title hyperlink) that the backup has but the live file
// doesn't — including whatever you'd hand-filled into CV version/response/
// interview/second stage/offer/notes for that row — then refresh the
// backup. Guards against the live file ever getting wiped or overwritten
// out from under it (this exists because exactly that happened once,
// during dev testing against this same file).
// ponytail: a single rolling backup, not a timestamped history — good
// enough for "something clobbered the file since last cycle"; add
// rotation if one backup back isn't enough of a safety margin.
// ---------------------------------------------------------------------

const BACKUP_PATH = path.join(__dirname, '..', 'Трекер откликов - AB тест.backup.xlsx');

// `${source}:${jobId}` -> full record (every column), reconstructed from
// cell text + the hyperlink targets already parsed elsewhere in this file.
function extractRecordsFromParts(parts) {
  const records = new Map();
  const worksheetName = findWorksheetPartName(parts);
  const relsName = relsPartNameFor(worksheetName);
  const sheetXml = parts.get(worksheetName)?.toString('utf8');
  if (!sheetXml) return records;
  const relsXml = parts.get(relsName)?.toString('utf8') || null;
  const sharedStrings = parseSharedStrings(parts);
  const refToRid = parseHyperlinkRefs(sheetXml);
  const ridToTarget = parseRelationshipTargets(relsXml);
  const rowTexts = readRowTexts(sheetXml, sharedStrings);

  for (const [row, texts] of rowTexts.entries()) {
    if (row === 1) continue; // header
    const titleUrl = ridToTarget.get(refToRid.get(`${COL.TITLE}${row}`)) || '';
    const info = extractJobIdFromUrl(titleUrl);
    if (!info) continue; // no reliable jobId to key on — can't safely restore this row
    const source = texts[COL.SOURCE] || info.source;
    records.set(`${source}:${info.jobId}`, {
      date: texts[COL.DATE] || '',
      company: texts[COL.COMPANY] || '',
      companyUrl: ridToTarget.get(refToRid.get(`${COL.COMPANY}${row}`)) || '',
      title: texts[COL.TITLE] || '',
      titleUrl,
      cvVersion: texts[COL.CV_VERSION] || '',
      source,
      response: texts[COL.RESPONSE] || '',
      responseDate: texts[COL.RESPONSE_DATE] || '',
      interview: texts[COL.INTERVIEW] || '',
      secondStage: texts[COL.SECOND_STAGE] || '',
      offer: texts[COL.OFFER] || '',
      notes: texts[COL.NOTES] || '',
    });
  }
  return records;
}

async function reconcileAndBackup() {
  if (!fs.existsSync(OUTPUT_PATH)) return; // nothing to protect yet

  let currentParts;
  try {
    currentParts = readXlsxParts(OUTPUT_PATH);
  } catch (e) {
    console.error('backup/reconcile: live workbook unreadable, leaving backup untouched:', e);
    return; // don't overwrite a good backup with a broken read
  }

  let backupParts = null;
  if (fs.existsSync(BACKUP_PATH)) {
    try {
      backupParts = readXlsxParts(BACKUP_PATH);
    } catch (e) {
      backupParts = null;
    }
  }

  if (backupParts) {
    const currentRecords = extractRecordsFromParts(currentParts);
    const backupRecords = extractRecordsFromParts(backupParts);
    const missing = [];
    for (const [key, rec] of backupRecords.entries()) {
      if (!currentRecords.has(key)) missing.push(rec);
    }
    if (missing.length) {
      console.warn(`[${new Date().toISOString()}] restoring ${missing.length} row(s) present in backup but missing from ${OUTPUT_PATH}`);
      await appendRecords(missing);
    }
  }

  fs.copyFileSync(OUTPUT_PATH, BACKUP_PATH);
}

// ---------------------------------------------------------------------
// Patch: locate the row for a jobId (via its title hyperlink URL) and
// update the company cell in place. Silently no-ops if the row can't be
// found (e.g. still queued client-side, or file doesn't exist yet).
// ---------------------------------------------------------------------

function replaceCellXml(sheetXml, ref, newCellXml) {
  const re = new RegExp(`<c r="${ref}"(?:[^>]*/>|[^>]*>[\\s\\S]*?</c>)`);
  if (!re.test(sheetXml)) return null;
  return sheetXml.replace(re, newCellXml);
}

async function patchRecord({ jobId, source, company, companyUrl }) {
  const existingParts = readXlsxParts(OUTPUT_PATH);
  if (!existingParts) return false;

  const worksheetName = findWorksheetPartName(existingParts);
  const relsName = relsPartNameFor(worksheetName);
  let sheetXml = existingParts.get(worksheetName)?.toString('utf8');
  if (!sheetXml) return false;
  let relsXml = existingParts.get(relsName)?.toString('utf8') || null;

  const refToRid = parseHyperlinkRefs(sheetXml);
  const ridToTarget = parseRelationshipTargets(relsXml);

  // Find every row whose title hyperlink resolves to this job — a
  // reposted job can have more than one row across different dates, so
  // patch the most recent (highest row number).
  let targetRow = null;
  for (const [ref, rid] of refToRid.entries()) {
    if (!ref.startsWith(COL.TITLE)) continue;
    const target = ridToTarget.get(rid);
    const info = extractJobIdFromUrl(target);
    if (info && info.jobId === jobId && info.source === source) {
      const row = parseInt(ref.slice(COL.TITLE.length), 10);
      if (targetRow === null || row > targetRow) targetRow = row;
    }
  }
  if (targetRow === null) return false;

  let changed = false;
  let nextRid = parseMaxRid(relsXml);
  const newRelationships = [];

  if (company !== undefined || companyUrl !== undefined) {
    const companyRef = `${COL.COMPANY}${targetRow}`;
    const existingRid = refToRid.get(companyRef);
    if (companyUrl && !existingRid) {
      // Didn't have a company hyperlink before — add one.
      nextRid += 1;
      const id = `rId${nextRid}`;
      newRelationships.push({ id, target: companyUrl });
      sheetXml = insertHyperlinks(sheetXml, [`<hyperlink ref="${companyRef}" r:id="${id}"/>`]);
      const updated = replaceCellXml(sheetXml, companyRef, inlineStrCell(companyRef, company || '', DATA_STYLE));
      if (updated) {
        sheetXml = updated;
        changed = true;
      }
    } else if (companyUrl && existingRid) {
      // Already hyperlinked — just repoint the existing relationship's target.
      relsXml = (relsXml || emptyRelsXml()).replace(
        new RegExp(`(<Relationship Id="${existingRid}"[^>]*Target=")[^"]*(")`),
        `$1${escapeXml(companyUrl)}$2`
      );
      const updated = replaceCellXml(sheetXml, companyRef, inlineStrCell(companyRef, company || '', DATA_STYLE));
      if (updated) {
        sheetXml = updated;
        changed = true;
      }
    } else if (company !== undefined) {
      const updated = replaceCellXml(sheetXml, companyRef, inlineStrCell(companyRef, company || '', DATA_STYLE));
      if (updated) {
        sheetXml = updated;
        changed = true;
      }
    }
  }

  if (!changed) return false;
  if (newRelationships.length) {
    relsXml = insertRelationships(relsXml || emptyRelsXml(), newRelationships);
  }

  const { buildZip } = await loadZipModule();
  const encoder = new TextEncoder();
  const files = [];
  for (const [name, data] of existingParts.entries()) {
    if (name === worksheetName) {
      files.push({ name, data: encoder.encode(sheetXml) });
    } else if (name === relsName) {
      continue;
    } else {
      files.push({ name, data });
    }
  }
  if (relsXml) {
    files.push({ name: relsName, data: encoder.encode(relsXml) });
  }

  fs.writeFileSync(OUTPUT_PATH, buildZip(files));
  return true;
}

// ---------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------

function isFileLockedError(e) {
  return e && (e.code === 'EBUSY' || e.code === 'EPERM');
}

// Platform-specific shell-out to open a file/folder — the only OS-specific
// code in this whole server. Everything else (reading/appending/patching
// the workbook) is plain, portable Node.js.
function shellOpen(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err) => resolve(!err));
  });
}

function openPathCommand(target) {
  if (process.platform === 'win32') return `start "" "${target}"`;
  if (process.platform === 'darwin') return `open "${target}"`;
  return `xdg-open "${target}"`; // Linux desktops (requires xdg-utils, present on virtually all of them)
}

function revealPathCommand(target) {
  if (process.platform === 'win32') return `explorer.exe /select,"${target}"`;
  if (process.platform === 'darwin') return `open -R "${target}"`;
  // No universal "reveal and select" on Linux — opening the containing
  // folder in the default file manager is the closest equivalent.
  return `xdg-open "${path.dirname(target)}"`;
}

function openFolderCommand(dir) {
  if (process.platform === 'win32') return `explorer.exe "${dir}"`;
  if (process.platform === 'darwin') return `open "${dir}"`;
  return `xdg-open "${dir}"`;
}

// Opens the workbook in its default app (Excel), or — if it doesn't exist
// yet or the OS refuses to launch it — falls back to opening (and, when
// possible, highlighting the file within) its containing folder instead.
// Best-effort only: a failure here just means the popup's button did
// nothing, not something worth surfacing as a hard error.
async function openFileOrFolder() {
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(OUTPUT_PATH)) {
    await shellOpen(openFolderCommand(dir));
    return;
  }
  const opened = await shellOpen(openPathCommand(OUTPUT_PATH));
  if (!opened) {
    await shellOpen(revealPathCommand(OUTPUT_PATH));
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const knownRoute =
    (req.method === 'POST' && ['/append', '/patch', '/backfill-link', '/open', '/hidden-companies'].includes(req.url)) ||
    (req.method === 'GET' && ['/missing-links', '/cv-list'].includes(req.url));
  if (!knownRoute) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.headers['x-lext-token'] !== TOKEN) {
    res.writeHead(403);
    res.end();
    return;
  }

  let body = {};
  if (req.method === 'POST') {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      res.writeHead(400);
      res.end('invalid json');
      return;
    }
  }

  try {
    if (req.method === 'GET' && req.url === '/missing-links') {
      const missing = listMissingLinks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(missing));
    } else if (req.method === 'GET' && req.url === '/cv-list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readCvList()));
    } else if (req.url === '/append') {
      const records = Array.isArray(body.records) ? body.records : [];
      if (!records.length) {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      await appendRecords(records);
      console.log(`[${new Date().toISOString()}] appended ${records.length} row(s) to ${OUTPUT_PATH}`);
      res.writeHead(200);
      res.end('ok');
    } else if (req.url === '/patch') {
      const patched = await patchRecord(body);
      if (patched) {
        console.log(`[${new Date().toISOString()}] patched row for job ${body.source}:${body.jobId}`);
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('no matching row');
      }
    } else if (req.url === '/backfill-link') {
      const backfilled = await backfillLink(body);
      if (backfilled) {
        console.log(`[${new Date().toISOString()}] backfilled link(s) for "${body.title}"`);
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('no matching row');
      }
    } else if (req.url === '/hidden-companies') {
      const companies = Array.isArray(body.companies) ? body.companies : [];
      await writeHiddenCompaniesSheet(companies);
      console.log(`[${new Date().toISOString()}] wrote ${companies.length} hidden company name(s) to sheet`);
      res.writeHead(200);
      res.end('ok');
    } else {
      await openFileOrFolder();
      console.log(`[${new Date().toISOString()}] opened ${OUTPUT_PATH}`);
      res.writeHead(200);
      res.end('ok');
    }
  } catch (e) {
    if (isFileLockedError(e)) {
      console.warn(`[${new Date().toISOString()}] ${OUTPUT_PATH} is locked (probably open in Excel) — try again shortly`);
      res.writeHead(423); // Locked
      res.end('locked');
    } else {
      console.error('request failed:', e);
      res.writeHead(500);
      res.end(String(e));
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LinkedIn Opera Applets save-server listening on http://127.0.0.1:${PORT}`);
  console.log(`Writing to: ${OUTPUT_PATH}`);
  console.log(`Backing up to: ${BACKUP_PATH} every 30 minutes`);
  console.log('Leave this window open while you use the extension. Ctrl+C to stop.');
});

const BACKUP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  reconcileAndBackup().catch((e) => console.error('backup/reconcile failed:', e));
}, BACKUP_INTERVAL_MS);
// Also right after startup, so a freshly (re)started server has a backup
// on disk immediately rather than waiting the full 30 minutes.
setTimeout(() => {
  reconcileAndBackup().catch((e) => console.error('backup/reconcile failed:', e));
}, 5000);
