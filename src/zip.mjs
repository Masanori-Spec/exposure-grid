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
 * Raw-deflate framing is checked independently of the native inflater, whose
 * tolerance for incomplete or trailing streams varies by runtime. The framing
 * walk counts output without materializing it, caps aggregate structural work,
 * and periodically yields so adversarial input cannot monopolize the UI thread.
 */
import { LIMITS, ProfileError, safeBasename } from './core.mjs';

export const ZIP_LIMITS = Object.freeze({
  entries: LIMITS.files,
  nameBytes: 1024,
  depth: 8,
  archiveBytes: LIMITS.totalBytes + 8 * 1024 * 1024,
  compressedFileBytes: LIMITS.fileBytes + 65536,
  directoryChecks: LIMITS.files * 8,
  // Aggregate block headers plus declared tree entries, allowing ordinary
  // multi-block streams and one full dynamic tree for every allowed ZIP entry.
  deflateStructures: LIMITS.files * 1024,
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

// RFC 1951 §§3.1–3.2: https://www.rfc-editor.org/rfc/rfc1951
// Canonical trees use at most 288 symbols, not a 2^15 table per block. Empty
// distance trees are legal for all-literal blocks. Otherwise an incomplete tree
// is legal only for the single one-bit symbol case, never for code lengths.
function deflateTree(lengths, kind) {
  const counts = new Uint16Array(16), first = new Uint16Array(16), offsets = new Uint16Array(16);
  let maximum = 0, total = 0;
  for (const length of lengths) if (length) { counts[length]++; maximum = Math.max(maximum, length); total++; }
  if (!total) {
    if (kind === 'distance') return null;
    fail('ZIP_DEFLATE', 'ZIP deflate Huffman tree is empty');
  }
  let remaining = 1, code = 0, offset = 0;
  for (let length = 1; length <= 15; length++) {
    remaining = remaining * 2 - counts[length];
    if (remaining < 0) fail('ZIP_DEFLATE', 'ZIP deflate Huffman tree is oversubscribed');
    code = (code + counts[length - 1]) * 2;
    first[length] = code; offsets[length] = offset; offset += counts[length];
  }
  if (remaining && (kind === 'codes' || maximum !== 1))
    fail('ZIP_DEFLATE', 'ZIP deflate Huffman tree is incomplete');
  const symbols = new Uint16Array(total), next = new Uint16Array(offsets);
  for (let symbol = 0; symbol < lengths.length; symbol++)
    if (lengths[symbol]) symbols[next[lengths[symbol]]++] = symbol;
  return { counts, first, offsets, symbols, maximum };
}
const fixedLiterals = deflateTree(Uint8Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8), 'literal');
const fixedDistances = deflateTree(new Uint8Array(32).fill(5), 'distance');
const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
async function validateDeflate(compressed, size, name, budget) {
  let bit = 0, output = 0, final = 0;
  const bitLength = compressed.length * 8;
  const malformed = () => fail('ZIP_DEFLATE', `ZIP deflate stream is invalid or truncated: ${name}`);
  const read = count => {
    if (bit + count > bitLength) malformed();
    const byte = bit >>> 3, shift = bit & 7;
    bit += count;
    return ((compressed[byte] | compressed[byte + 1] << 8 | compressed[byte + 2] << 16) >>> shift) & ((1 << count) - 1);
  };
  const symbol = tree => {
    if (!tree) malformed();
    let code = 0;
    for (let length = 1; length <= tree.maximum; length++) {
      code = code * 2 + read(1);
      const index = code - tree.first[length];
      if (index >= 0 && index < tree.counts[length]) return tree.symbols[tree.offsets[length] + index];
    }
    malformed();
  };
  const addOutput = count => {
    output += count;
    if (output > size) fail('ZIP_SIZE', `ZIP expands beyond its declared size: ${name}`);
  };
  const chargeStructure = count => {
    budget.structures += count; budget.slice += count;
    if (budget.structures > ZIP_LIMITS.deflateStructures)
      fail('ZIP_COMPLEXITY', 'ZIP deflate has too many blocks or Huffman tree entries; repackage as an ordinary ZIP');
  };
  // Literal/length work is bounded by the already capped decoded size. Empty
  // blocks and dynamic tree work use a separate archive-wide hard budget. Each
  // slice has at most 16384 symbols/tree entries (each symbol needs <=15 bits).
  const yieldThread = async () => { budget.slice = 0; await new Promise(resolve => setTimeout(resolve, 0)); };
  while (!final) {
    chargeStructure(1);
    final = read(1);
    const type = read(2);
    if (type === 3) malformed();
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const length = read(16), complement = read(16);
      if ((length ^ complement) !== 0xffff || bit + length * 8 > bitLength) malformed();
      bit += length * 8; addOutput(length);
    } else {
      let literals = fixedLiterals, distances = fixedDistances;
      if (type === 2) {
        const literalCount = read(5) + 257, distanceCount = read(5) + 1, codeCount = read(4) + 4;
        if (literalCount > 286) malformed();
        chargeStructure(literalCount + distanceCount + codeCount);
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < codeCount; i++) codeLengths[codeLengthOrder[i]] = read(3);
        const codes = deflateTree(codeLengths, 'codes');
        const lengths = new Uint8Array(literalCount + distanceCount);
        for (let i = 0; i < lengths.length;) {
          const value = symbol(codes);
          if (value < 16) { lengths[i++] = value; continue; }
          if (value === 16 && !i) malformed();
          const count = value === 16 ? read(2) + 3 : value === 17 ? read(3) + 3 : read(7) + 11;
          if (i + count > lengths.length) malformed();
          lengths.fill(value === 16 ? lengths[i - 1] : 0, i, i + count); i += count;
        }
        if (!lengths[256]) malformed();
        literals = deflateTree(lengths.subarray(0, literalCount), 'literal');
        distances = deflateTree(lengths.subarray(literalCount), 'distance');
      }
      while (true) {
        if (++budget.slice >= 16384) await yieldThread();
        const value = symbol(literals);
        if (value === 256) break;
        if (value < 256) { addOutput(1); continue; }
        if (value > 285) malformed();
        const length = lengthBase[value - 257] + read(lengthExtra[value - 257]);
        const distanceCode = symbol(distances);
        if (distanceCode > 29) malformed();
        const distance = distanceBase[distanceCode] + read(distanceExtra[distanceCode]);
        if (distance > output) malformed();
        addOutput(length);
      }
    }
    if (budget.slice >= 16384) await yieldThread();
  }
  // Unused high bits of the final byte are padding, but every additional whole
  // byte is trailing data, including another complete raw-deflate stream.
  if (Math.ceil(bit / 8) !== compressed.length) malformed();
  if (output !== size) fail('ZIP_SIZE', `ZIP decoded size does not match: ${name}`);
}

async function inflateBounded(compressed, size, name, budget) {
  await validateDeflate(compressed, size, name, budget);
  const Constructor = globalThis.DecompressionStream;
  if (typeof Constructor !== 'function')
    fail('ZIP_SUPPORT', 'This browser cannot unpack deflated ZIPs; use a stored ZIP or a newer browser');
  let stream;
  try { stream = new Constructor('deflate-raw'); }
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
  const entries = [], deflateBudget = { structures: 0, slice: 0 };
  for (const record of records) {
    const compressed = bytes.subarray(record.dataStart, record.dataEnd);
    const data = record.method === 0 ? new Uint8Array(compressed) : await inflateBounded(compressed, record.size, record.name, deflateBudget);
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
