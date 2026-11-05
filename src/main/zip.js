// Minimal, dependency-free zip reader (stored + deflate) with hard limits, used
// to import skill packages. Zip64, encryption and other methods are rejected.

const zlib = require('node:zlib');

const LIMITS = { zipBytes: 20 * 1024 * 1024, entries: 500, fileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };

function safeName(raw) {
  const name = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store') return null;
  return parts.join('/');
}

/** @returns {{name: string, data: Buffer}[]} files only (directories are skipped) */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('This is not a valid zip file');
  if (buf.length > LIMITS.zipBytes) throw new Error('That zip is too large (20 MB max)');

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
  if (count > LIMITS.entries) throw new Error(`That zip has too many files (${LIMITS.entries} max)`);

  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue; // directory
    const name = safeName(rawName);
    if (!name) continue; // unsafe or junk entry: ignore rather than extract
    if (flags & 1) throw new Error('Encrypted zips are not supported');
    if (size > LIMITS.fileBytes) throw new Error(`"${name}" is too large (2 MB max per file)`);
    total += size;
    if (total > LIMITS.totalBytes) throw new Error('The zip expands to too much data (20 MB max)');

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('The zip is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.fileBytes });
    else throw new Error(`"${name}" uses an unsupported compression method`);
    out.push({ name, data });
  }
  return out;
}

module.exports = { readZip, LIMITS };
