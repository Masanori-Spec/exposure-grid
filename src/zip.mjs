/** Original ExposureGrid source. No project-wide open-source license selected.
 * Offline, bounded ZIP subset. Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * Supports stored/deflated single-volume ZIPs, signed/unsigned data descriptors,
 * ordinary timestamp/UID metadata and optional directory records. Paths use the
 * same conservative ASCII basename profile as the core (including UTF-8 ZIPs).
 * Rejects ZIP64, encryption, links/special files, non-ASCII paths, unknown extra
 * fields, self-extracting prefixes, padding and trailing data. No filesystem,
 * network, executable-content handling, or product-specific file filtering.
 * EOCD candidate scans cache directory spans and cap aggregate header checks;
 * intentionally complex alternate-directory layouts fail closed.
 */
import { LIMITS, ProfileError, safeBasename } from './core.mjs';

export const ZIP_LIMITS = Object.freeze({
  entries: LIMITS.files,
  nameBytes: 1024,
  depth: 8,
  archiveBytes: LIMITS.totalBytes + 8 * 1024 * 1024,
  compressedFileBytes: LIMITS.fileBytes + 65536,
  directoryChecks: LIMITS.files * 8,
});
const fail = (code, message) => { throw new ProfileError(code, message); };
const signatures = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, descriptor: 0x08074b50 };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validName(name) {
  if (typeof name !== 'string' || !name.length || name.length > ZIP_LIMITS.nameBytes)
    fail('ZIP_PATH', 'ZIP paths must be bounded, safe relative ASCII names');
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  if (parts.length > ZIP_LIMITS.depth || parts.some(part => !safeBasename(part)))
    fail('ZIP_PATH', 'ZIP paths must use safe relative ASCII basenames');
  return { directory, parts };
}
function decodeName(bytes, flags) {
  let name;
  if (flags & 0x0800) {
    try { name = decoder.decode(bytes); }
    catch { fail('ZIP_ENCODING', 'ZIP filename is not valid UTF-8'); }
  } else {
    if (bytes.some(byte => byte > 127)) fail('ZIP_ENCODING', 'Only ASCII ZIP paths are supported');
    name = String.fromCharCode(...bytes);
  }
  if (bytes.some(byte => byte > 127)) fail('ZIP_ENCODING', 'Only ASCII ZIP paths are supported');
  validName(name);
  return name;
}
// Include implicit parents: Foo/a.png and foo/b.png are ambiguous too.
function registerName(paths, name) {
  const { directory, parts } = validName(name);
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('/');
    const key = path.toLowerCase(), last = i === parts.length - 1;
    const kind = !last || directory ? 'directory' : 'file';
    const existing = paths.get(key);
    if (existing && (existing.path !== path || existing.kind !== kind || (last && existing.explicit)))
      fail('ZIP_DUPLICATE', 'ZIP has duplicate, case-ambiguous, or conflicting file/directory paths');
    if (!existing) paths.set(key, { path, kind, explicit: last });
    else if (last) existing.explicit = true;
  }
  return directory;
}
function validateExtra(bytes, start, length, nameBytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + length, seen = new Set();
  while (start < end) {
    if (start + 4 > end) fail('ZIP_FORMAT', 'Truncated ZIP extra field');
    const id = view.getUint16(start, true), size = view.getUint16(start + 2, true);
    start += 4;
    if (start + size > end || seen.has(id)) fail('ZIP_FORMAT', 'Invalid or repeated ZIP extra field');
    seen.add(id);
    if (id === 0x0001) fail('ZIP_FEATURE', 'ZIP64 archives are unsupported');
    if (id === 0x7075) {
      // A Unicode path override must describe precisely the same safe path.
      if (size < 5 || bytes[start] !== 1 || view.getUint32(start + 1, true) !== crc32(nameBytes))
        fail('ZIP_ENCODING', 'Invalid ZIP Unicode path metadata');
      const alternate = decodeName(bytes.subarray(start + 5, start + size), 0x0800);
      if (alternate !== name) fail('ZIP_ENCODING', 'Conflicting ZIP Unicode path metadata');
    } else if (![0x5455, 0x000a, 0x5855, 0x7855, 0x7875, 0x6375].includes(id)) {
      fail('ZIP_FEATURE', 'Unsupported ZIP extra field; repackage as an ordinary ZIP');
    }
    start += size;
  }
}
function validateFeatures(version, flags, method) {
  if (version < 10 || version > 20) fail('ZIP_FEATURE', 'Unsupported ZIP format version (ZIP64 is unsupported)');
  if (method !== 0 && method !== 8) fail('ZIP_FEATURE', 'Only stored and deflated ZIP files are supported');
  const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
  if (flags & ~allowedFlags) fail('ZIP_FEATURE', 'Encrypted ZIPs and unsupported ZIP flags are rejected');
}
function validateAttributes(attributes, directory) {
  const type = (attributes >>> 16) & 0xf000;
  if (type !== 0 && type !== 0x8000 && type !== 0x4000)
    fail('ZIP_FEATURE', 'ZIP links and special files are unsupported');
  if (attributes & 0x0408) fail('ZIP_FEATURE', 'ZIP reparse points and volume entries are unsupported');
  if ((type === 0x4000 || (attributes & 0x10)) && !directory || type === 0x8000 && directory)
    fail('ZIP_FORMAT', 'ZIP directory attributes conflict with its path');
}
function validateSizes(record) {
  if ([record.compressedSize, record.size, record.offset].includes(0xffffffff))
    fail('ZIP_FEATURE', 'ZIP64 archives are unsupported');
  if (record.size > LIMITS.fileBytes || record.compressedSize > ZIP_LIMITS.compressedFileBytes)
    fail('ZIP_SIZE', 'ZIP entry exceeds the 32 MiB file limit');
  if (record.directory && (record.size !== 0 || record.crc !== 0))
    fail('ZIP_FORMAT', 'ZIP directory records must be empty');
  if (record.method === 0 && record.compressedSize !== record.size)
    fail('ZIP_FORMAT', 'Stored ZIP entry sizes disagree');
}
function sameBytes(a, b) { return a.length === b.length && a.every((byte, i) => byte === b[i]); }

async function inflateBounded(compressed, size, name) {
  if (typeof DecompressionStream !== 'function')
    fail('ZIP_SUPPORT', 'This browser cannot unpack deflated ZIPs; use a stored ZIP or a newer browser');
  let stream;
  try { stream = new DecompressionStream('deflate-raw'); }
  catch { fail('ZIP_SUPPORT', 'This browser cannot unpack deflated ZIPs; use a stored ZIP or a newer browser'); }
  const result = new Uint8Array(size);
  const reader = new Blob([compressed]).stream().pipeThrough(stream).getReader();
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (position + value.length > size) {
        await reader.cancel().catch(() => {});
        fail('ZIP_SIZE', `ZIP expands beyond its declared size: ${name}`);
      }
      result.set(value, position);
      position += value.length;
    }
    if (position !== size) fail('ZIP_SIZE', `ZIP decoded size does not match: ${name}`);
    return result;
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    fail('ZIP_DEFLATE', `ZIP deflate stream is invalid: ${name}`);
  } finally { reader.releaseLock(); }
}

// Find the directory's actual extent before interpreting names or local records.
// Fake EOCDs often share a real offset/count but claim different directory sizes.
// Cache that span, and bound work even when candidates vary their offset/count.
function directorySpan(bytes, view, start, count, scan) {
  const key = `${start}:${count}`;
  if (scan.spans.has(key)) return scan.spans.get(key);
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (++scan.checks > ZIP_LIMITS.directoryChecks)
      fail('ZIP_COMPLEXITY', 'ZIP has too many distinct directory interpretations; repackage as an ordinary ZIP');
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== signatures.central) {
      cursor = -1; break;
    }
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (cursor > bytes.length) { cursor = -1; break; }
  }
  scan.spans.set(key, cursor);
  return cursor;
}

// A byte signature is only a candidate. Opaque files and ZIP comments may contain
// EOCD-shaped bytes; validate the complete directory/local topology first.
function readRecords(bytes, view, end, scan) {
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true), centralStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count)
    fail('ZIP_FEATURE', 'Multi-disk ZIP archives are unsupported');
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff)
    fail('ZIP_FEATURE', 'ZIP64 archives are unsupported');
  if (count > ZIP_LIMITS.entries) fail('ZIP_COUNT', 'ZIP has too many entries (including directories)');
  if (centralStart + centralSize !== end) fail('ZIP_FORMAT', 'ZIP central directory is inconsistent');
  if (directorySpan(bytes, view, centralStart, count, scan) !== end)
    fail('ZIP_FORMAT', 'ZIP central directory size or entry count does not match');
  const paths = new Map(), records = [];
  let cursor = centralStart, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== signatures.central)
      fail('ZIP_FORMAT', 'ZIP central directory is truncated or inconsistent');
    const version = view.getUint16(cursor + 6, true), flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true), crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true), disk = view.getUint16(cursor + 34, true);
    const attributes = view.getUint32(cursor + 38, true), offset = view.getUint32(cursor + 42, true);
    if (disk !== 0) fail('ZIP_FEATURE', 'Multi-disk ZIP archives are unsupported');
    validateFeatures(version, flags, method);
    if (!nameLength || nameLength > ZIP_LIMITS.nameBytes) fail('ZIP_PATH', 'Unsupported ZIP filename length');
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) fail('ZIP_FORMAT', 'ZIP central directory entry is truncated');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes, flags), directory = registerName(paths, name);
    validateAttributes(attributes, directory);
    validateExtra(bytes, cursor + 46 + nameLength, extraLength, nameBytes, name);
    const record = { name, nameBytes, directory, version, flags, method, crc, compressedSize, size, offset };
    validateSizes(record);
    total += size;
    if (total > LIMITS.totalBytes) fail('ZIP_TOTAL_SIZE', 'ZIP expands beyond the 128 MiB package limit');
    records.push(record);
    cursor = next;
  }
  if (cursor !== end) fail('ZIP_FORMAT', 'ZIP central directory size or entry count does not match');
  // Every byte before the directory must belong to exactly one listed record.
  const physical = [...records].sort((a, b) => a.offset - b.offset);
  if (physical.length ? physical[0].offset !== 0 : centralStart !== 0)
    fail('ZIP_FORMAT', 'ZIP prefixes, unlisted entries, and self-extracting archives are unsupported');
  for (let i = 0; i < physical.length; i++) {
    const record = physical[i], p = record.offset;
    const boundary = i + 1 < physical.length ? physical[i + 1].offset : centralStart;
    if (p + 30 > boundary || boundary > centralStart || view.getUint32(p, true) !== signatures.local)
      fail('ZIP_FORMAT', 'ZIP local entries overlap or are inconsistent');
    if (view.getUint16(p + 4, true) !== record.version || view.getUint16(p + 6, true) !== record.flags || view.getUint16(p + 8, true) !== record.method)
      fail('ZIP_FORMAT', 'ZIP local and central versions, flags, or methods disagree');
    const localCRC = view.getUint32(p + 14, true), localCompressed = view.getUint32(p + 18, true), localSize = view.getUint32(p + 22, true);
    if (localCompressed === 0xffffffff || localSize === 0xffffffff) fail('ZIP_FEATURE', 'ZIP64 archives are unsupported');
    const descriptor = Boolean(record.flags & 8);
    for (const [local, central] of [[localCRC, record.crc], [localCompressed, record.compressedSize], [localSize, record.size]])
      if (local !== central && !(descriptor && local === 0)) fail('ZIP_FORMAT', 'ZIP local and central checksums or sizes disagree');
    const nameLength = view.getUint16(p + 26, true), extraLength = view.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLength + extraLength, dataEnd = dataStart + record.compressedSize;
    if (dataStart > boundary || dataEnd > boundary || !sameBytes(bytes.subarray(p + 30, p + 30 + nameLength), record.nameBytes))
      fail('ZIP_FORMAT', 'ZIP local names, sizes, or entry boundaries disagree');
    validateExtra(bytes, p + 30 + nameLength, extraLength, record.nameBytes, record.name);
    let descriptorStart = dataEnd;
    if (descriptor) {
      const length = boundary - dataEnd;
      if (length === 16 && view.getUint32(dataEnd, true) === signatures.descriptor) descriptorStart += 4;
      else if (length !== 12) fail('ZIP_FORMAT', 'ZIP data descriptor is missing or has an unsupported size');
      if (view.getUint32(descriptorStart, true) !== record.crc || view.getUint32(descriptorStart + 4, true) !== record.compressedSize || view.getUint32(descriptorStart + 8, true) !== record.size)
        fail('ZIP_FORMAT', 'ZIP data descriptor disagrees with the central directory');
    } else if (dataEnd !== boundary) fail('ZIP_FORMAT', 'ZIP entries overlap or contain unlisted data');
    record.dataStart = dataStart;
    record.dataEnd = dataEnd;
  }
  return records;
}

/** Read one complete ZIP snapshot. Directories are checked but not returned. */
export async function readZip(input) {
  if (!(input instanceof Uint8Array)) fail('ZIP_FORMAT', 'ZIP input must be bytes');
  if (input.length < 22 || input.length > ZIP_LIMITS.archiveBytes)
    fail('ZIP_SIZE', 'ZIP archive is empty, truncated, or exceeds the archive size limit');
  // Never retain a caller-owned mutable buffer across asynchronous decompression.
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer);
  const scan = { spans: new Map(), checks: 0 };
  let records, candidateError;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) {
    if (view.getUint32(p, true) !== signatures.end || p + 22 + view.getUint16(p + 20, true) !== bytes.length) continue;
    let candidate;
    try { candidate = readRecords(bytes, view, p, scan); }
    catch (error) {
      if (!(error instanceof ProfileError) || error.code === 'ZIP_COMPLEXITY') throw error;
      candidateError ??= error;
      continue;
    }
    if (records) fail('ZIP_FORMAT', 'ZIP has genuinely ambiguous end records');
    records = candidate;
  }
  if (!records) {
    if (candidateError) throw candidateError;
    fail('ZIP_FORMAT', 'ZIP end record is missing or has trailing data');
  }
  const entries = [];
  for (const record of records) {
    const compressed = bytes.subarray(record.dataStart, record.dataEnd);
    const data = record.method === 0 ? new Uint8Array(compressed) : await inflateBounded(compressed, record.size, record.name);
    if (crc32(data) !== record.crc) fail('ZIP_CRC', `ZIP checksum does not match: ${record.name}`);
    if (!record.directory) entries.push({ name: record.name, data });
  }
  return entries;
}

/** Deterministic standard stored ZIP, without compression, services, or metadata. */
export function writeZip(entries) {
  if (!Array.isArray(entries) || entries.length > ZIP_LIMITS.entries) fail('ZIP_COUNT', 'Unsupported ZIP entry count');
  const paths = new Map(), records = [];
  let total = 0, localSize = 0, centralSize = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') fail('ZIP_FORMAT', 'Invalid ZIP entry');
    const { name, data } = entry, directory = registerName(paths, name);
    if (!(data instanceof Uint8Array) || data.length > LIMITS.fileBytes) fail('ZIP_SIZE', 'Unsupported ZIP file size');
    if (directory && data.length) fail('ZIP_FORMAT', 'ZIP directory records must be empty');
    total += data.length;
    if (total > LIMITS.totalBytes) fail('ZIP_TOTAL_SIZE', 'ZIP exceeds the 128 MiB package limit');
    const nameBytes = encoder.encode(name);
    records.push({ nameBytes, data, directory, offset: localSize });
    localSize += 30 + nameBytes.length + data.length;
    centralSize += 46 + nameBytes.length;
  }
  const size = localSize + centralSize + 22;
  if (size > ZIP_LIMITS.archiveBytes) fail('ZIP_SIZE', 'ZIP exceeds the archive size limit');
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  const u16 = (p, value) => view.setUint16(p, value, true), u32 = (p, value) => view.setUint32(p, value, true);
  let central = localSize;
  for (const record of records) {
    const { nameBytes, data, directory, offset } = record;
    const crc = crc32(data);
    u32(offset, signatures.local); u16(offset + 4, 20); u16(offset + 6, 0x0800);
    u16(offset + 12, 0x0021); u32(offset + 14, crc); u32(offset + 18, data.length); u32(offset + 22, data.length);
    u16(offset + 26, nameBytes.length); bytes.set(nameBytes, offset + 30); bytes.set(data, offset + 30 + nameBytes.length);
    u32(central, signatures.central); u16(central + 4, 0x0314); u16(central + 6, 20); u16(central + 8, 0x0800);
    u16(central + 14, 0x0021); u32(central + 16, crc); u32(central + 20, data.length); u32(central + 24, data.length);
    u16(central + 28, nameBytes.length); u32(central + 38, directory ? (0x41ed0000 | 0x10) >>> 0 : 0x81a40000);
    u32(central + 42, offset); bytes.set(nameBytes, central + 46);
    central += 46 + nameBytes.length;
  }
  u32(central, signatures.end); u16(central + 8, records.length); u16(central + 10, records.length);
  u32(central + 12, centralSize); u32(central + 16, localSize);
  return bytes;
}
