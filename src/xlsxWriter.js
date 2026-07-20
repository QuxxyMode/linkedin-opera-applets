// Builds a minimal but valid .xlsx workbook (OOXML SpreadsheetML) with
// hyperlinked job title / company columns, using only the built-in ZIP writer.
import { buildZip } from './zip.js';

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Applied Jobs" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

function inlineStrCell(ref, text, styleIndex) {
  const s = styleIndex ? ` s="${styleIndex}"` : '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function buildSheetAndRels(records) {
  const rows = [];
  const hyperlinks = [];
  const relationships = [];
  let rId = 1;

  rows.push(
    `<row r="1">${inlineStrCell('A1', 'Date', 1)}${inlineStrCell('B1', 'Job Title', 1)}${inlineStrCell('C1', 'Company', 1)}${inlineStrCell('D1', 'Location', 1)}${inlineStrCell('E1', 'Source', 1)}</row>`
  );

  records.forEach((rec, i) => {
    const r = i + 2;
    const cells = [inlineStrCell(`A${r}`, rec.date || '')];

    cells.push(inlineStrCell(`B${r}`, rec.title || '', rec.titleUrl ? 2 : 0));
    if (rec.titleUrl) {
      const id = `rId${rId++}`;
      relationships.push({ id, target: rec.titleUrl });
      hyperlinks.push(`<hyperlink ref="B${r}" r:id="${id}"/>`);
    }

    cells.push(inlineStrCell(`C${r}`, rec.company || '', rec.companyUrl ? 2 : 0));
    if (rec.companyUrl) {
      const id = `rId${rId++}`;
      relationships.push({ id, target: rec.companyUrl });
      hyperlinks.push(`<hyperlink ref="C${r}" r:id="${id}"/>`);
    }

    cells.push(inlineStrCell(`D${r}`, rec.location || ''));
    cells.push(inlineStrCell(`E${r}`, rec.source || 'LinkedIn'));

    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  });

  const hyperlinksXml = hyperlinks.length ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="55" customWidth="1"/><col min="3" max="3" width="32" customWidth="1"/><col min="4" max="4" width="30" customWidth="1"/><col min="5" max="5" width="14" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData>
${hyperlinksXml}
</worksheet>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(r.target)}" TargetMode="External"/>`).join('\n')}
</Relationships>`;

  return { sheetXml, relsXml, hasRelationships: relationships.length > 0 };
}

/**
 * @param {{date: string, title: string, titleUrl: string, company: string, companyUrl: string, location: string, source: string}[]} records
 * @returns {Uint8Array}
 */
export function buildAppliedJobsXlsx(records) {
  const encoder = new TextEncoder();
  const { sheetXml, relsXml, hasRelationships } = buildSheetAndRels(records);

  const files = [
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: encoder.encode(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml) },
  ];
  if (hasRelationships) {
    files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: encoder.encode(relsXml) });
  }

  return buildZip(files);
}
