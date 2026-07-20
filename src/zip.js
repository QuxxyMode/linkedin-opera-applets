// Minimal ZIP (store/no-compression) writer — no external dependencies.
// Sufficient for building .xlsx packages, which are plain ZIP archives.

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * @param {{name: string, data: Uint8Array}[]} files
 * @returns {Uint8Array}
 */
export function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const records = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 filenames
    dv.setUint16(8, 0, true); // stored, no compression
    dv.setUint16(10, 0, true); // time
    dv.setUint16(12, 0x21, true); // date: 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    localParts.push(header, data);
    records.push({ nameBytes, crc, size: data.length, offset });
    offset += header.length + data.length;
  }

  const centralStart = offset;
  for (const r of records) {
    const central = new Uint8Array(46 + r.nameBytes.length);
    const dv = new DataView(central.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, r.crc, true);
    dv.setUint32(20, r.size, true);
    dv.setUint32(24, r.size, true);
    dv.setUint16(28, r.nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, r.offset, true);
    central.set(r.nameBytes, 46);
    centralParts.push(central);
    offset += central.length;
  }
  const centralSize = offset - centralStart;

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, records.length, true);
  dv.setUint16(10, records.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralStart, true);
  dv.setUint16(20, 0, true);

  const total = offset + eocd.length;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) { result.set(part, pos); pos += part.length; }
  for (const part of centralParts) { result.set(part, pos); pos += part.length; }
  result.set(eocd, pos);
  return result;
}
