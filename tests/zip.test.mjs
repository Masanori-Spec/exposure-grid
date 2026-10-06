import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync, createInflateRaw, constants } from 'node:zlib';
import { Duplex } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { readZip, writeZip, ZIP_LIMITS } from '../src/zip.mjs';
import { LIMITS, loadProject, retimeProject, exportEntries, ProfileError } from '../src/core.mjs';
import { loadBundle } from '../src/bundle.mjs';

const text = value => new TextEncoder().encode(value);
const empty = new Uint8Array();
const decode = value => new TextDecoder().decode(value);
// Independent bit-by-bit fixture checksum, not the production table algorithm.
function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}
function join(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let p = 0;
  for (const part of parts) { result.set(part, p); p += part.length; }
  return result;
}
function extra(id, payload = empty) {
  const bytes = new Uint8Array(4 + payload.length), view = new DataView(bytes.buffer);
  view.setUint16(0, id, true); view.setUint16(2, payload.length, true); bytes.set(payload, 4);
  return bytes;
}
function unicodeExtra(original, alternate = original) {
  const payload = new Uint8Array(5 + alternate.length), view = new DataView(payload.buffer);
  payload[0] = 1; view.setUint32(1, crc32(original), true); payload.set(alternate, 5);
  return extra(0x7075, payload);
}
/** Independent fixture writer; overrides intentionally construct malicious ZIPs. */
function fixture(entries = [{ name: 'a.csv', data: text('hello') }], options = {}) {
  const locals = [], centrals = [];
  let offset = (options.prefix ?? empty).length;
  for (const entry of entries) {
    const data = entry.data ?? empty, name = entry.nameBytes ?? text(entry.name ?? 'a.csv');
    const localName = entry.localNameBytes ?? name, method = entry.method ?? 0, flags = entry.flags ?? 0;
    const compressed = entry.compressed ?? (method === 8 ? new Uint8Array(deflateRawSync(data, entry.deflateOptions)) : data);
    const crc = entry.crc ?? crc32(data), size = entry.size ?? data.length, compressedSize = entry.compressedSize ?? compressed.length;
    const version = entry.version ?? 20, localExtra = entry.localExtra ?? empty, centralExtra = entry.centralExtra ?? empty;
    const local = new Uint8Array(30 + localName.length + localExtra.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, entry.localVersion ?? version, true);
    lv.setUint16(6, entry.localFlags ?? flags, true); lv.setUint16(8, entry.localMethod ?? method, true);
    lv.setUint32(14, entry.localCRC ?? (flags & 8 ? 0 : crc), true);
    lv.setUint32(18, entry.localCompressedSize ?? (flags & 8 ? 0 : compressedSize), true);
    lv.setUint32(22, entry.localSize ?? (flags & 8 ? 0 : size), true);
    lv.setUint16(26, localName.length, true); lv.setUint16(28, localExtra.length, true);
    local.set(localName, 30); local.set(localExtra, 30 + localName.length);
    let descriptor = empty;
    if (flags & 8 && entry.descriptor !== false) {
      const signed = entry.descriptor !== 'unsigned';
      descriptor = new Uint8Array(signed ? 16 : 12); const dv = new DataView(descriptor.buffer), start = signed ? 4 : 0;
      if (signed) dv.setUint32(0, entry.descriptorSignature ?? 0x08074b50, true);
      dv.setUint32(start, entry.descriptorCRC ?? crc, true);
      dv.setUint32(start + 4, entry.descriptorCompressedSize ?? compressedSize, true);
      dv.setUint32(start + 8, entry.descriptorSize ?? size, true);
    }
    locals.push(local, compressed, descriptor, entry.gap ?? empty);
    const comment = entry.comment ?? empty;
    const central = new Uint8Array(46 + name.length + centralExtra.length + comment.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, entry.madeBy ?? 0x0314, true); cv.setUint16(6, version, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, method, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, centralExtra.length, true); cv.setUint16(32, comment.length, true);
    cv.setUint16(34, entry.disk ?? 0, true); cv.setUint32(38, entry.attributes ?? 0, true);
    cv.setUint32(42, entry.offset ?? offset, true); central.set(name, 46); central.set(centralExtra, 46 + name.length);
    central.set(comment, 46 + name.length + centralExtra.length); centrals.push(central);
    offset += local.length + compressed.length + descriptor.length + (entry.gap ?? empty).length;
  }
  if (options.reverseCentral) centrals.reverse();
  const suffix = options.centralSuffix ?? empty;
  const central = join(...centrals, suffix), comment = options.comment ?? empty;
  const end = new Uint8Array(22 + comment.length), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(4, options.disk ?? 0, true); view.setUint16(6, options.centralDisk ?? 0, true);
  view.setUint16(8, options.diskCount ?? options.count ?? entries.length, true); view.setUint16(10, options.count ?? entries.length, true);
  view.setUint32(12, options.centralSize ?? central.length, true); view.setUint32(16, options.centralStart ?? offset, true);
  view.setUint16(20, comment.length, true); end.set(comment, 22);
  return join(options.prefix ?? empty, ...locals, central, end, options.trailing ?? empty);
}
async function rejectsZIP(bytes, code) {
  await assert.rejects(readZip(bytes), error => error instanceof ProfileError && (!code || error.code === code));
}

// Hand-authored RFC1951 fixtures, independent of zlib and the production parser.
// Numbers are LSB-first; canonical Huffman codes are written MSB-first.
function bitWriter() {
  const bytes = []; let position = 0;
  const bit = value => { const index = position >>> 3; bytes[index] = (bytes[index] ?? 0) | (value << (position++ & 7)); };
  return {
    number(value, count) { for (let i = 0; i < count; i++) bit((value >>> i) & 1); },
    code(value, count) { for (let i = count - 1; i >= 0; i--) bit((value >>> i) & 1); },
    finish() { return Uint8Array.from(bytes); },
  };
}
function writeSymbol(writer, lengths, symbol) {
  // Sort the alphabet and advance canonical codes, rather than using the
  // production decoder's count/offset representation.
  const ordered = Array.from(lengths, (length, value) => ({ length, value }))
    .filter(item => item.length).sort((a, b) => a.length - b.length || a.value - b.value);
  let code = 0, previous = 0;
  for (const item of ordered) {
    code *= 2 ** (item.length - previous);
    if (item.value === symbol) { writer.code(code, item.length); return; }
    code++; previous = item.length;
  }
  throw new Error('Fixture symbol absent from tree');
}
const fixtureFixedLengths = Uint8Array.from({ length: 288 }, (_, value) => value <= 143 ? 8 : value <= 255 ? 9 : value <= 279 ? 7 : 8);
function fixedStream(write, final = 1) {
  const writer = bitWriter(); writer.number(final, 1); writer.number(1, 2);
  write(writer, value => writeSymbol(writer, fixtureFixedLengths, value));
  return writer.finish();
}
function dynamicBlock(writer, literals, distances, write = () => {}, final = 1) {
  writer.number(final, 1); writer.number(2, 2);
  writer.number(literals.length - 257, 5); writer.number(distances.length - 1, 5); writer.number(15, 4);
  // Complete four-bit tree for code-length symbols 0–15. Repeat symbols absent.
  for (const value of [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])
    writer.number(value < 16 ? 4 : 0, 3);
  for (const length of [...literals, ...distances]) writer.code(length, 4);
  write(value => writeSymbol(writer, literals, value), value => writeSymbol(writer, distances, value));
}
function dynamicStream(literals, distances, write) {
  const writer = bitWriter(); dynamicBlock(writer, literals, distances, write); return writer.finish();
}
function repeatedTreeStream(sequence, distanceCount, write = () => {}) {
  const writer = bitWriter(), codeLengths = new Uint8Array(19);
  codeLengths[0] = 2; codeLengths[1] = 2; codeLengths[16] = 2; codeLengths[17] = 3; codeLengths[18] = 3;
  writer.number(1, 1); writer.number(2, 2); writer.number(0, 5); writer.number(distanceCount - 1, 5); writer.number(14, 4);
  for (const value of [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1]) writer.number(codeLengths[value], 3);
  for (const [value, extra = 0] of sequence) {
    writeSymbol(writer, codeLengths, value);
    if (value >= 16) writer.number(extra, value === 16 ? 2 : value === 17 ? 3 : 7);
  }
  write(writer); return writer.finish();
}

test('stored writer round-trips exact binary bytes and deterministic standard headers', async () => {
  const entries = [{ name: 'scene.csv', data: text('123456789') }, { name: 'scene.frames/a.png', data: Uint8Array.of(0, 255, 10, 128) }];
  const bytes = writeZip(entries), view = new DataView(bytes.buffer);
  assert.deepEqual(await readZip(bytes), entries);
  assert.deepEqual(writeZip(entries), bytes);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
});
test('independent standard stored, empty-file, and empty-archive fixtures are accepted', async () => {
  const entries = [{ name: 'a.csv', data: text('hello') }, { name: 'empty.json', data: empty }];
  assert.deepEqual(await readZip(fixture(entries)), entries);
  assert.deepEqual(await readZip(fixture([])), []);
  assert.deepEqual(await readZip(writeZip([])), []);
});
test('deflate supports fixed, dynamic, and uncompressed blocks', async () => {
  const data = text(Array.from({ length: 5000 }, (_, i) => `row${i % 217}: ${i * i}\n`).join(''));
  for (const deflateOptions of [{ level: 0 }, { strategy: constants.Z_FIXED }, { level: 9 }]) {
    const entries = await readZip(fixture([{ name: 'scene.csv', data, method: 8, deflateOptions }]));
    assert.deepEqual(entries, [{ name: 'scene.csv', data }]);
  }
});
test('stored and deflated signed/unsigned descriptors and nonzero matching local fields are accepted', async () => {
  for (const method of [0, 8]) for (const descriptor of ['signed', 'unsigned']) {
    const data = text('abc');
    assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, method, flags: 8, descriptor, localCRC: crc32(data), localSize: data.length }])), [{ name: 'a.csv', data }]);
  }
});
test('directories are validated and removed regardless of record order', async () => {
  const file = { name: 'scene.frames/a.png', data: Uint8Array.of(1, 2) };
  for (const records of [[{ name: 'scene.frames/', attributes: 0x41ed0010 }, file], [file, { name: 'scene.frames/', attributes: 0x41ed0010, method: 8 }]]) {
    assert.deepEqual(await readZip(fixture(records)), [file]);
  }
  assert.deepEqual(await readZip(writeZip([{ name: 'scene.frames/', data: empty }, file])), [file]);
});
test('central records need not follow physical order', async () => {
  const entries = [{ name: 'a.csv', data: text('a') }, { name: 'b.json', data: text('b') }];
  assert.deepEqual(await readZip(fixture(entries, { reverseCentral: true })), entries.toReversed());
});
test('ordinary ZIP and entry comments and timestamp/UID extras are ignored safely', async () => {
  const metadata = join(extra(0x5455, Uint8Array.of(1, 0, 0, 0, 0)), extra(0x7875, Uint8Array.of(1, 1, 0, 1, 0)));
  const result = await readZip(fixture([{ name: 'a.csv', data: text('abc'), localExtra: metadata, centralExtra: metadata, comment: text('entry') }], { comment: text('archive') }));
  assert.equal(decode(result[0].data), 'abc');
});
test('Unicode flag accepts ASCII names and matching Unicode path metadata', async () => {
  const name = text('scene.frames/a.png'), metadata = unicodeExtra(name);
  for (const flags of [0, 0x0800]) {
    assert.equal((await readZip(fixture([{ nameBytes: name, flags, localExtra: metadata, centralExtra: metadata }])))[0].name, 'scene.frames/a.png');
  }
});
test('all valid archives are independent of caller mutation while inflating', async () => {
  const data = text('abc'.repeat(10000)), bytes = fixture([{ name: 'a.csv', data, method: 8 }]);
  const result = readZip(bytes); bytes.fill(0);
  assert.deepEqual((await result)[0].data, data);
});
test('typed-array subviews are read correctly and returned stored bytes do not alias input', async () => {
  const bytes = fixture(), wrapped = join(Uint8Array.of(255, 255), bytes, Uint8Array.of(255));
  const result = await readZip(wrapped.subarray(2, 2 + bytes.length));
  wrapped.fill(0); assert.equal(decode(result[0].data), 'hello');
});

for (const name of ['../a.csv', 'a/../b.csv', '/a.csv', '\\a.csv', 'a\\b.csv', 'C:/a.csv', 'C:a.csv', 'a\0.csv', './a.csv', 'a//b.csv', 'a/.', 'a/..', '/', 'a..csv', 'a. ', 'NUL.csv', 'com1.png', 'a/']) {
  test(`unsafe or nonempty directory path is rejected: ${JSON.stringify(name)}`, async () => {
    await rejectsZIP(fixture([{ name, data: text('x') }]));
    assert.throws(() => writeZip([{ name, data: text('x') }]), ProfileError);
  });
}
test('path length, segment length, and depth are bounded before work', async () => {
  for (const name of ['a'.repeat(121), Array(10).fill('a').join('/'), 'a'.repeat(ZIP_LIMITS.nameBytes + 1)])
    await rejectsZIP(fixture([{ name }]), 'ZIP_PATH');
});
test('NUL, controls, high ASCII and malformed/unsupported UTF-8 never become paths', async () => {
  for (const [nameBytes, flags] of [[Uint8Array.of(97, 0, 98), 0x800], [Uint8Array.of(97, 10, 98), 0], [Uint8Array.of(0xff), 0], [Uint8Array.of(0xc3, 0x28), 0x800], [text('日本.csv'), 0x800], [text('\ufeffa.csv'), 0x800]])
    await rejectsZIP(fixture([{ nameBytes, flags }]));
});
test('Unicode path aliases and invalid CRC/version are rejected in either header', async () => {
  const name = text('a.csv');
  const invalidCRC = unicodeExtra(name); invalidCRC[5] ^= 1;
  const invalidVersion = unicodeExtra(name); invalidVersion[4] = 2;
  for (const metadata of [unicodeExtra(name, text('../a.csv')), unicodeExtra(name, text('b.csv')), unicodeExtra(name, text('日本.csv')), invalidCRC, invalidVersion])
    for (const location of ['localExtra', 'centralExtra']) await rejectsZIP(fixture([{ nameBytes: name, [location]: metadata }]));
});
for (const names of [
  ['a.csv', 'a.csv'], ['a.csv', 'A.csv'], ['dir/', 'dir/'], ['Dir/', 'dir/'],
  ['dir', 'dir/a.csv'], ['dir/a.csv', 'dir'], ['dir/', 'dir'], ['dir', 'dir/'],
  ['Dir/a.csv', 'dir/b.csv'], ['Dir/a.csv', 'dir/'], ['dir/', 'Dir/a.csv'],
]) {
  test(`duplicate or ambiguous paths rejected: ${names.join(', ')}`, async () => {
    const entries = names.map(name => ({ name, data: empty }));
    await rejectsZIP(fixture(entries), 'ZIP_DUPLICATE');
    assert.throws(() => writeZip(entries), error => error.code === 'ZIP_DUPLICATE');
  });
}
test('encrypted, patched, enhanced, reserved, and unsupported compression flags are rejected', async () => {
  for (const flags of [1, 0x10, 0x20, 0x40, 0x100, 0x1000, 0x2000, 0x4000, 0x8000, 2, 4])
    await rejectsZIP(fixture([{ name: 'a.csv', flags }]), 'ZIP_FEATURE');
  for (const method of [9, 12, 14, 93, 99]) await rejectsZIP(fixture([{ name: 'a.csv', method }]), 'ZIP_FEATURE');
  for (const flags of [2, 4, 6, 0x806]) assert.equal((await readZip(fixture([{ name: 'a.csv', method: 8, flags }]))).length, 1);
});
test('multi-disk headers are rejected in end and central directory', async () => {
  for (const options of [{ disk: 1 }, { centralDisk: 1 }, { diskCount: 0 }]) await rejectsZIP(fixture(undefined, options), 'ZIP_FEATURE');
  await rejectsZIP(fixture([{ name: 'a.csv', disk: 1 }]), 'ZIP_FEATURE');
});
test('ZIP64 sentinel fields, extended versions and ZIP64 extra fields are rejected', async () => {
  for (const key of ['size', 'compressedSize', 'offset', 'localSize', 'localCompressedSize']) await rejectsZIP(fixture([{ name: 'a.csv', [key]: 0xffffffff }]), 'ZIP_FEATURE');
  for (const key of ['centralSize', 'centralStart']) await rejectsZIP(fixture(undefined, { [key]: 0xffffffff }), 'ZIP_FEATURE');
  await rejectsZIP(fixture(undefined, { count: 0xffff }), 'ZIP_FEATURE');
  for (const version of [0, 9, 21, 45, 63]) await rejectsZIP(fixture([{ name: 'a.csv', version }]), 'ZIP_FEATURE');
  for (const key of ['localExtra', 'centralExtra']) await rejectsZIP(fixture([{ name: 'a.csv', [key]: extra(1, new Uint8Array(16)) }]), 'ZIP_FEATURE');
});
test('symlinks, devices, sockets, FIFOs, reparse points and volumes are rejected', async () => {
  for (const attributes of [0xa1ff0000, 0x21b60000, 0x61b60000, 0xc1b60000, 0x11b60000, 0x400, 0x08])
    for (const madeBy of [0x0314, 0x0014]) await rejectsZIP(fixture([{ name: 'a.csv', attributes, madeBy }]), 'ZIP_FEATURE');
  await rejectsZIP(fixture([{ name: 'dir', attributes: 0x41ed0010 }]), 'ZIP_FORMAT');
  await rejectsZIP(fixture([{ name: 'dir/', attributes: 0x81a40000 }]), 'ZIP_FORMAT');
});
test('directory records must contain no bytes and have zero checksum', async () => {
  await rejectsZIP(fixture([{ name: 'dir/', data: text('x') }]), 'ZIP_FORMAT');
  await rejectsZIP(fixture([{ name: 'dir/', crc: 1 }]), 'ZIP_FORMAT');
});
test('declared file and aggregate bombs are rejected before decompression', async () => {
  await rejectsZIP(fixture([{ name: 'a.csv', method: 8, size: LIMITS.fileBytes + 1 }]), 'ZIP_SIZE');
  await rejectsZIP(fixture([{ name: 'a.csv', method: 8, compressedSize: ZIP_LIMITS.compressedFileBytes + 1 }]), 'ZIP_SIZE');
  await rejectsZIP(fixture(Array.from({ length: 5 }, (_, i) => ({ name: `a${i}.csv`, method: 8, size: LIMITS.fileBytes }))), 'ZIP_TOTAL_SIZE');
});
test('actual inflation above and below claimed size is rejected without unbounded collection', async () => {
  const data = text('a'.repeat(1024 * 1024));
  await rejectsZIP(fixture([{ name: 'a.csv', method: 8, data, size: 1 }]), 'ZIP_SIZE');
  await rejectsZIP(fixture([{ name: 'a.csv', method: 8, data: text('abc'), size: 4 }]), 'ZIP_SIZE');
});
test('file count includes directories and writer has the same bound', async () => {
  await rejectsZIP(fixture(undefined, { count: ZIP_LIMITS.entries + 1 }), 'ZIP_COUNT');
  assert.throws(() => writeZip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `d${i}/`, data: empty }))), error => error.code === 'ZIP_COUNT');
});
test('CRC is verified for stored and deflated data', async () => {
  for (const method of [0, 8]) await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc'), method, crc: 42 }]), 'ZIP_CRC');
});
test('malformed, truncated, and trailing deflate bytes are rejected', async () => {
  const compressed = new Uint8Array(deflateRawSync(text('abc')));
  for (const bytes of [Uint8Array.of(7, 255, 255), compressed.slice(0, -1), join(compressed, Uint8Array.of(0)), join(compressed, compressed)])
    await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc'), method: 8, compressed: bytes }]), 'ZIP_DEFLATE');
});
test('hand-authored streams accept ignored padding, empty trees, singleton codes and deep Huffman codes', async () => {
  const singleEnd = new Uint8Array(257); singleEnd[256] = 1;
  const literalOnly = new Uint8Array(257); literalOnly[65] = 1; literalOnly[256] = 1;
  const withMatch = new Uint8Array(258); withMatch[65] = 1; withMatch[256] = 2; withMatch[257] = 2;
  const deepTree = new Uint8Array(257);
  for (let i = 0; i < 15; i++) deepTree[i] = i + 1;
  deepTree[256] = 15;
  const fixedPadding = fixedStream((writer, symbol) => { symbol(65); symbol(256); });
  fixedPadding[fixedPadding.length - 1] |= 0xfc; // Only the high six unused bits.
  const streams = [
    [Uint8Array.of(0xf9, 1, 0, 254, 255, 65), text('A')], // Stored alignment bits ignored.
    [fixedPadding, text('A')],
    [dynamicStream(singleEnd, Uint8Array.of(0), literal => literal(256)), empty],
    [dynamicStream(literalOnly, Uint8Array.of(0), literal => { literal(65); literal(256); }), text('A')],
    [dynamicStream(withMatch, Uint8Array.of(1), (literal, distance) => { literal(65); literal(257); distance(0); literal(256); }), text('AAAA')],
    [dynamicStream(deepTree, Uint8Array.of(0), literal => { literal(14); literal(0); literal(13); literal(256); }), Uint8Array.of(14, 0, 13)],
  ];
  for (const [compressed, data] of streams) {
    assert.deepEqual(new Uint8Array(inflateRawSync(compressed)), data, 'independent zlib oracle accepts fixture');
    assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, compressed, method: 8 }])), [{ name: 'a.csv', data }]);
    for (let i = 0; i < compressed.length; i++)
      await rejectsZIP(fixture([{ name: 'a.csv', data, compressed: compressed.subarray(0, i), method: 8 }]), 'ZIP_DEFLATE');
  }
});
test('dynamic code-length repeats may cross tree boundaries but must not start without a predecessor or overflow', async () => {
  const valid = [
    // 255 zero lengths, literal255=1, then repeat1 across EOB and both distances.
    [repeatedTreeStream([[18, 127], [18, 106], [1], [16]], 2, writer => { writer.code(0, 1); writer.code(1, 1); }), Uint8Array.of(255)],
    // Repeat17 also works: 138+110+8 zeros, a one-bit EOB and no distances.
    [repeatedTreeStream([[18, 127], [18, 99], [17, 5], [1], [0]], 1, writer => writer.code(0, 1)), empty],
  ];
  for (const [compressed, data] of valid) {
    assert.deepEqual(new Uint8Array(inflateRawSync(compressed)), data);
    assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, compressed, method: 8 }])), [{ name: 'a.csv', data }]);
  }
  const invalid = [
    [[16, 0]], // No preceding length to copy.
    [[18, 127], [18, 127]], // 276 values, but only 258 declared.
    [[18, 127], [18, 100], [17, 7]], // 259 values.
    [[18, 127], [18, 106], [1], [16, 3]], // Six copies overrun the tail.
  ];
  const original = globalThis.DecompressionStream; let calls = 0;
  try {
    globalThis.DecompressionStream = class { constructor() { calls++; return new TransformStream({ transform() {} }); } };
    for (const sequence of invalid)
      await rejectsZIP(fixture([{ name: 'a.csv', data: empty, compressed: repeatedTreeStream(sequence, 1), method: 8 }]), 'ZIP_DEFLATE');
    assert.equal(calls, 0);
  } finally { globalThis.DecompressionStream = original; }
});
test('backreferences may overlap, cross blocks, and reach the full 32768-byte window', async () => {
  const first = new Uint8Array(32768);
  const header = Uint8Array.of(0, 0, 128, 255, 127); // Non-final stored block.
  const last = fixedStream((writer, literal) => {
    literal(285); writer.code(29, 5); writer.number(8191, 13); literal(256);
  });
  const compressed = join(header, first, last), data = new Uint8Array(32768 + 258);
  assert.deepEqual(new Uint8Array(inflateRawSync(compressed)), data);
  assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, compressed, method: 8 }])), [{ name: 'a.csv', data }]);
});
test('reserved symbols, absent final blocks, invalid distances and invalid dynamic trees fail before native inflation', async () => {
  const missingEnd = new Uint8Array(257); missingEnd[65] = 1; missingEnd[66] = 1;
  const oversubscribed = new Uint8Array(257); oversubscribed[65] = 1; oversubscribed[66] = 1; oversubscribed[256] = 1;
  const incomplete = new Uint8Array(257); incomplete[65] = 2; incomplete[256] = 2;
  const literalOnly = new Uint8Array(257); literalOnly[65] = 1; literalOnly[256] = 1;
  const withMatch = new Uint8Array(258); withMatch[65] = 1; withMatch[256] = 2; withMatch[257] = 2;
  const singleEnd = new Uint8Array(257); singleEnd[256] = 1;
  const invalid = [
    Uint8Array.of(0, 0, 0, 255, 255), // Non-final stored block with no following header.
    fixedStream((writer, literal) => literal(256), 0),
    ...[286, 287].map(value => fixedStream((writer, literal) => literal(value))),
    fixedStream((writer, literal) => { literal(257); writer.code(0, 5); }),
    fixedStream((writer, literal) => { literal(65); literal(257); writer.code(1, 5); }),
    ...[30, 31].map(value => fixedStream((writer, literal) => { literal(65); literal(257); writer.code(value, 5); })),
    dynamicStream(missingEnd, Uint8Array.of(0)),
    dynamicStream(oversubscribed, Uint8Array.of(0)),
    dynamicStream(incomplete, Uint8Array.of(0)),
    dynamicStream(literalOnly, Uint8Array.of(2)),
    dynamicStream(literalOnly, Uint8Array.of(1, 1, 1)),
    dynamicStream(withMatch, Uint8Array.of(0), literal => { literal(65); literal(257); }),
  ];
  // A one-bit singleton leaves code 1 invalid, including the singleton EOB.
  const badSingleton = bitWriter();
  dynamicBlock(badSingleton, singleEnd, Uint8Array.of(0)); badSingleton.code(1, 1); invalid.push(badSingleton.finish());
  for (const count of [287, 288]) {
    const writer = bitWriter(); writer.number(1, 1); writer.number(2, 2); writer.number(count - 257, 5); writer.number(0, 5); writer.number(0, 4);
    invalid.push(writer.finish());
  }
  for (const lengths of [[0, 0, 0, 0], [1, 1, 1, 1], [2, 0, 0, 0]]) {
    const writer = bitWriter(); writer.number(1, 1); writer.number(2, 2); writer.number(0, 5); writer.number(0, 5); writer.number(0, 4);
    for (const length of lengths) writer.number(length, 3);
    invalid.push(writer.finish());
  }
  const original = globalThis.DecompressionStream; let calls = 0;
  try {
    globalThis.DecompressionStream = class {
      constructor() { calls++; return new TransformStream({ transform() {} }); }
    };
    for (const compressed of invalid)
      await rejectsZIP(fixture([{ name: 'a.csv', data: text('AAAA'), compressed, method: 8 }]), 'ZIP_DEFLATE');
    assert.equal(calls, 0, 'a completely tolerant native decoder cannot mask malformed framing');
  } finally { globalThis.DecompressionStream = original; }
});
test('large literal walks yield before native inflation begins', async () => {
  const original = globalThis.DecompressionStream, data = new Uint8Array(65536).fill(65);
  const compressed = fixedStream((writer, literal) => {
    // Fixed code for ASCII A, avoiding repeated fixture-tree construction.
    for (let i = 0; i < data.length; i++) writer.code(0x71, 8);
    literal(256);
  });
  let timerRan = false, sawNative = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    globalThis.DecompressionStream = class {
      constructor(format) { assert(timerRan, 'framing must let pending UI tasks run first'); sawNative = true; return new original(format); }
    };
    assert.deepEqual((await readZip(fixture([{ name: 'a.csv', data, compressed, method: 8 }])))[0].data, data);
    assert(sawNative);
  } finally { clearTimeout(timer); globalThis.DecompressionStream = original; }
});
test('deflate structural budget is shared across entries and resets between imports', async () => {
  const literals = new Uint8Array(257); literals[256] = 1;
  const perBlockCost = 1 + 257 + 1 + 19;
  const count = Math.floor(ZIP_LIMITS.deflateStructures / perBlockCost / 2) + 1;
  const writer = bitWriter();
  for (let i = 0; i < count; i++) dynamicBlock(writer, literals, Uint8Array.of(0), literal => literal(256), i === count - 1 ? 1 : 0);
  const compressed = writer.finish();
  const one = fixture([{ name: 'a.csv', compressed, method: 8 }]);
  assert.deepEqual(await readZip(one), [{ name: 'a.csv', data: empty }]);
  assert.deepEqual(await readZip(one), [{ name: 'a.csv', data: empty }]);
  await rejectsZIP(fixture([{ name: 'a.csv', compressed, method: 8 }, { name: 'b.csv', compressed, method: 8 }]), 'ZIP_COMPLEXITY');
});
test('all central/local critical fields must agree', async () => {
  for (const override of [{ localNameBytes: text('b.csv') }, { localNameBytes: text('aa.csv') }, { localCRC: 1 }, { localCompressedSize: 1 }, { localSize: 1 }, { localMethod: 8 }, { localFlags: 0x0800 }, { localVersion: 10 }])
    await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc'), ...override }]), 'ZIP_FORMAT');
  await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc'), method: 0, size: 2 }]), 'ZIP_FORMAT');
});
test('descriptor CRC, sizes, signature, presence, and local fields are checked', async () => {
  for (const override of [{ descriptorCRC: 1 }, { descriptorSize: 1 }, { descriptorCompressedSize: 1 }, { descriptorSignature: 1 }, { descriptor: false }, { localCRC: 1 }, { localSize: 1 }, { localCompressedSize: 1 }])
    await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc'), method: 8, flags: 8, ...override }]), 'ZIP_FORMAT');
});
test('overlapping and repeated local offsets are rejected', async () => {
  for (const offset of [0, 1, 20, 0xfffffffe])
    await rejectsZIP(fixture([{ name: 'a.csv', data: text('abc') }, { name: 'b.csv', data: text('def'), offset }]), 'ZIP_FORMAT');
});
test('prefixes, gaps, unlisted local records, central junk and trailing data are rejected', async () => {
  await rejectsZIP(fixture(undefined, { prefix: text('MZ executable prefix') }), 'ZIP_FORMAT');
  await rejectsZIP(fixture([{ name: 'a.csv', gap: Uint8Array.of(0) }]), 'ZIP_FORMAT');
  await rejectsZIP(fixture(undefined, { centralSuffix: Uint8Array.of(0) }), 'ZIP_FORMAT');
  await rejectsZIP(fixture(undefined, { trailing: Uint8Array.of(0) }), 'ZIP_FORMAT');
  for (const options of [{ count: 0 }, { count: 2 }, { centralStart: 1 }, { centralSize: 1 }]) await rejectsZIP(fixture(undefined, options), 'ZIP_FORMAT');
  // A physically present entry absent from the central directory is never accepted.
  const bytes = fixture([{ name: 'a.csv' }, { name: 'b.csv' }]);
  const view = new DataView(bytes.buffer), end = bytes.length - 22, central = view.getUint32(end + 16, true);
  const withoutFirst = join(bytes.subarray(0, central), bytes.subarray(central + 51));
  const modified = new DataView(withoutFirst.buffer), newEnd = withoutFirst.length - 22;
  modified.setUint16(newEnd + 8, 1, true); modified.setUint16(newEnd + 10, 1, true); modified.setUint32(newEnd + 12, 51, true);
  await rejectsZIP(withoutFirst, 'ZIP_FORMAT');
});
test('all truncations of a valid archive are rejected', async () => {
  const bytes = fixture([{ name: 'a.csv', data: text('hello'), method: 8, flags: 8 }]);
  for (let size = 0; size < bytes.length; size++) await rejectsZIP(bytes.subarray(0, size));
});
test('truncated, repeated, link-bearing and unknown extra fields are rejected', async () => {
  for (const metadata of [Uint8Array.of(0x55), Uint8Array.of(0x55, 0x54, 9, 0), join(extra(0x5455), extra(0x5455)), extra(0x000d), extra(0x9901), extra(0x0017), extra(0xcafe)])
    for (const key of ['localExtra', 'centralExtra']) await rejectsZIP(fixture([{ name: 'a.csv', [key]: metadata }]));
});
test('EOCD-shaped bytes in opaque archive comments do not imply ambiguity', async () => {
  const fakeEnd = fixture([]);
  assert.equal(decode((await readZip(fixture(undefined, { comment: fakeEnd })))[0].data), 'hello');
});
test('stored writer round-trips opaque EOCD-shaped file bytes', async () => {
  const data = new Uint8Array(22), view = new DataView(data.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(20, 73, true);
  const entries = [{ name: 'a.bin', data }];
  assert.deepEqual(await readZip(writeZip(entries)), entries);
});
test('two structurally valid EOCD/central/local interpretations are still rejected', async () => {
  const inner = fixture([{ name: 'a.csv', data: text('inner'), flags: 8 }]);
  assert.equal(decode((await readZip(inner))[0].data), 'inner');
  // Both interpretations share a descriptor-style local header with zero sizes.
  // The outer file legitimately includes the inner descriptor, directory and EOCD.
  const localHeaderLength = 30 + text('a.csv').length;
  const outerTailLength = 16 + 46 + text('a.csv').length + 22;
  new DataView(inner.buffer).setUint16(inner.length - 2, outerTailLength, true);
  const ambiguous = fixture([{ name: 'a.csv', data: inner.subarray(localHeaderLength), flags: 8 }]);
  await assert.rejects(readZip(ambiguous), error => error.code === 'ZIP_FORMAT' && /genuinely ambiguous/.test(error.message));
});
function candidateStress(varyCounts) {
  const entries = Array.from({ length: ZIP_LIMITS.entries }, (_, i) => ({ name: `a${i}.bin`, data: empty }));
  const base = fixture(entries), baseView = new DataView(base.buffer);
  const centralStart = baseView.getUint32(base.length - 6, true);
  const candidateCount = varyCounts ? 16 : Math.floor(65535 / 22);
  const comment = new Uint8Array(candidateCount * 22), view = new DataView(comment.buffer);
  for (let i = 0; i < candidateCount; i++) {
    const offset = i * 22, count = entries.length - (varyCounts ? i : 0);
    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 8, count, true); view.setUint16(offset + 10, count, true);
    view.setUint32(offset + 12, base.length + offset - centralStart, true);
    view.setUint32(offset + 16, centralStart, true);
    view.setUint16(offset + 20, comment.length - offset - 22, true);
  }
  return { entries, bytes: fixture(entries, { comment }) };
}
test('thousands of false EOCDs share one cached directory span within the work budget', async () => {
  const { entries, bytes } = candidateStress(false);
  assert.deepEqual(await readZip(bytes), entries);
});
test('distinct alternate directory spans cannot exceed the aggregate validation budget', async () => {
  await rejectsZIP(candidateStress(true).bytes, 'ZIP_COMPLEXITY');
});
test('invalid public API types and writer sizes fail predictably', async () => {
  for (const value of [null, [], new ArrayBuffer(22), 'zip']) await rejectsZIP(value, 'ZIP_FORMAT');
  for (const value of [null, {}, 'zip']) assert.throws(() => writeZip(value), ProfileError);
  for (const entry of [null, {}, { name: 'a.csv', data: [] }, { name: 'a.csv', data: new Uint8Array(LIMITS.fileBytes + 1) }])
    assert.throws(() => writeZip([entry]), ProfileError);
});
test('missing browser decompression produces a specific support error; stored ZIP still works', async () => {
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await rejectsZIP(fixture([{ name: 'a.csv', method: 8 }]), 'ZIP_SUPPORT');
    assert.equal((await readZip(fixture())).length, 1);
    globalThis.DecompressionStream = class { constructor() { throw new TypeError('unsupported'); } };
    await rejectsZIP(fixture([{ name: 'a.csv', method: 8 }]), 'ZIP_SUPPORT');
  } finally { globalThis.DecompressionStream = original; }
});
test('tolerant native inflaters still accept valid deflate and never receive invalid framing', async () => {
  const original = globalThis.DecompressionStream;
  let calls = 0;
  try {
    globalThis.DecompressionStream = class {
      constructor(format) {
        assert.equal(format, 'deflate-raw'); calls++;
        // Node's raw zlib stream ignores extra bytes, like older native browsers.
        return Duplex.toWeb(createInflateRaw());
      }
    };
    const data = text('abc'.repeat(10000));
    for (const deflateOptions of [{ level: 0 }, { strategy: constants.Z_FIXED }, { level: 9 }])
      assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, method: 8, deflateOptions }])), [{ name: 'a.csv', data }]);
    const callsBefore = calls, compressed = new Uint8Array(deflateRawSync(data));
    assert.deepEqual(new Uint8Array(inflateRawSync(join(compressed, compressed))), data, 'the regression fixture really is tolerated by zlib');
    for (const bytes of [Uint8Array.of(7), compressed.slice(0, -1), join(compressed, Uint8Array.of(0)), join(compressed, compressed)])
      await rejectsZIP(fixture([{ name: 'a.csv', data, method: 8, compressed: bytes }]), 'ZIP_DEFLATE');
    assert.equal(calls, callsBefore, 'invalid framing must be rejected before constructing the native inflater');
    assert.deepEqual(await readZip(writeZip([{ name: 'a.csv', data }])), [{ name: 'a.csv', data }]);
  } finally { globalThis.DecompressionStream = original; }
});
test('native read errors, incorrect output sizes, and wrong decoded bytes remain guarded', async () => {
  const original = globalThis.DecompressionStream, bytes = fixture([{ name: 'a.csv', data: text('A'), method: 8 }]);
  try {
    globalThis.DecompressionStream = class {
      constructor() { return new TransformStream({ transform() { throw new TypeError('native decode failed'); } }); }
    };
    await rejectsZIP(bytes, 'ZIP_DEFLATE');
    for (const output of [empty, text('AB'), text('B')]) {
      globalThis.DecompressionStream = class {
        constructor() { return new TransformStream({ transform() {}, flush(controller) { controller.enqueue(output); } }); }
      };
      await rejectsZIP(bytes, output.length === 1 ? 'ZIP_CRC' : 'ZIP_SIZE');
    }
  } finally { globalThis.DecompressionStream = original; }
});
test('simulated native acceptance of every byte sequence cannot bypass framing validation', async () => {
  const original = globalThis.DecompressionStream, data = text('A');
  let calls = 0;
  try {
    globalThis.DecompressionStream = class {
      constructor() {
        calls++;
        return new TransformStream({ transform() {}, flush(controller) { controller.enqueue(data); } });
      }
    };
    const valid = Uint8Array.of(1, 1, 0, 254, 255, 65);
    for (const compressed of [...Array.from({ length: valid.length }, (_, i) => valid.slice(0, i)),
      Uint8Array.of(7), Uint8Array.of(1, 1, 0, 0, 0, 65),
      Uint8Array.of(0, 1, 0, 254, 255, 65), join(valid, Uint8Array.of(0)), join(valid, valid)])
      await rejectsZIP(fixture([{ name: 'a.csv', data, method: 8, compressed }]), 'ZIP_DEFLATE');
    assert.equal(calls, 0);
    assert.deepEqual(await readZip(fixture([{ name: 'a.csv', data, method: 8, compressed: valid }])), [{ name: 'a.csv', data }]);
    assert.equal(calls, 1);
  } finally { globalThis.DecompressionStream = original; }
});
test('concurrent imports and native constructor changes do not share mutable framing state', async () => {
  const original = globalThis.DecompressionStream;
  let firstCalls = 0, secondCalls = 0;
  try {
    globalThis.DecompressionStream = class { constructor(format) { firstCalls++; return new original(format); } };
    const bytes = fixture([{ name: 'a.csv', data: text('abc'), method: 8 }]);
    const results = await Promise.all([readZip(bytes), readZip(bytes)]);
    assert.equal(firstCalls, 2);
    assert.equal(decode(results[0][0].data), 'abc');
    globalThis.DecompressionStream = class { constructor(format) { secondCalls++; return new original(format); } };
    assert.equal(decode((await readZip(bytes))[0].data), 'abc');
    assert.equal(secondCalls, 1);
  } finally { globalThis.DecompressionStream = original; }
});
test('ZIP layer retains every product file including review JSON for strict wrapper validation', async () => {
  const entries = [{ name: 'a.csv', data: text('csv') }, { name: 'a.review.json', data: text('{}') }, { name: 'unexpected.json', data: text('{}') }];
  assert.deepEqual(await readZip(writeZip(entries)), entries);
});
test('full source ZIP → strict core → retime → stored ZIP preserves timing and PNG bytes', async () => {
  const names = ['source.csv', ...['A', 'B', 'C', 'X', 'Y'].map(name => `source.frames/${name}.png`)];
  const originals = await Promise.all(names.map(async name => ({ name, data: new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url))) })));
  const compressed = fixture([{ name: 'source.frames/', data: empty }, ...originals.map(entry => ({ ...entry, method: 8, flags: 8 }))]);
  const source = loadProject(await readZip(compressed)), converted = retimeProject(source, 24);
  const outputEntries = await readZip(writeZip(await exportEntries(converted, 'retimed24')));
  // This test knows the exact receipt entry; production wrappers must validate it.
  const receipt = outputEntries.find(entry => entry.name === 'retimed24.review.json');
  assert.equal(JSON.parse(decode(receipt.data)).schema, 'exposure-grid-review/v1');
  const reloaded = loadProject(outputEntries.filter(entry => entry !== receipt));
  assert.equal(reloaded.fps, 24); assert.equal(reloaded.frameCount, 48);
  assert.deepEqual(reloaded.layers, converted.layers);
  for (const [name, bytes] of reloaded.images) assert.deepEqual(bytes, source.images.get(name));
});
test('valid PNG with EOCD-shaped ancillary bytes survives full ZIP/bundle/export/reimport', async () => {
  const names = ['source.csv', ...['A', 'B', 'C', 'X', 'Y'].map(name => `source.frames/${name}.png`)];
  const originals = await Promise.all(names.map(async name => ({ name, data: new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url))) })));
  const target = originals.find(entry => entry.name === 'source.frames/Y.png'), originalPNG = target.data;
  const payload = new Uint8Array(22), payloadView = new DataView(payload.buffer);
  payloadView.setUint32(0, 0x06054b50, true);
  const ancillaryPNG = () => {
    const chunk = new Uint8Array(12 + payload.length), view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length); chunk.set(text('egRd'), 4); chunk.set(payload, 8);
    view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    return join(originalPNG.subarray(0, -12), chunk, originalPNG.subarray(-12));
  };
  target.data = ancillaryPNG();
  const initialEntries = await exportEntries(retimeProject(loadProject(originals), 24), 'retimed24');
  const initialZIP = writeZip(initialEntries);
  let localOffset = 0;
  for (const entry of initialEntries) {
    if (entry.name === 'retimed24.frames/Y.png') break;
    localOffset += 30 + text(entry.name).length + entry.data.length;
  }
  const fakeEndOffset = localOffset + 30 + text('retimed24.frames/Y.png').length + originalPNG.length - 12 + 8;
  const fakeCommentLength = initialZIP.length - fakeEndOffset - 22;
  assert(fakeCommentLength >= 0 && fakeCommentLength <= 65535);
  payloadView.setUint16(20, fakeCommentLength, true); target.data = ancillaryPNG();
  const imported = await loadBundle(await readZip(fixture(originals.map(entry => ({ ...entry, method: 8 })))));
  const outputEntries = await exportEntries(retimeProject(imported.project, 24), 'retimed24');
  const outputZIP = writeZip(outputEntries), outputView = new DataView(outputZIP.buffer);
  assert.equal(outputView.getUint32(fakeEndOffset, true), 0x06054b50);
  assert.equal(fakeEndOffset + 22 + outputView.getUint16(fakeEndOffset + 20, true), outputZIP.length);
  const reloaded = await loadBundle(await readZip(outputZIP));
  assert.equal(reloaded.previousReceipt, true); assert.equal(reloaded.project.fps, 24); assert.equal(reloaded.project.frameCount, 48);
  assert.deepEqual(reloaded.project.images.get('Y.png'), target.data);
});
test('writer rejects the total package limit and excessive names', () => {
  const data = new Uint8Array(LIMITS.fileBytes);
  assert.throws(() => writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `a${i}.csv`, data }))), error => error.code === 'ZIP_TOTAL_SIZE');
  assert.throws(() => writeZip([{ name: 'a'.repeat(ZIP_LIMITS.nameBytes + 1), data: empty }]), error => error.code === 'ZIP_PATH');
});
test('mutated headers never leak native RangeErrors or silently corrupt data', async () => {
  const originals = [{ name: 'a.csv', data: text('abc') }, { name: 'dir/b.png', data: Uint8Array.of(0, 10, 255) }];
  const valid = fixture(originals.map(entry => ({ ...entry, method: 8, flags: 8 })));
  let seed = 0x1badb002, rejected = 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 400; i++) {
    const bytes = new Uint8Array(valid), index = random() % bytes.length;
    bytes[index] ^= 1 << (random() % 8);
    try {
      const entries = await readZip(bytes);
      assert.deepEqual(entries, originals); // Only unused metadata can change safely.
    } catch (error) {
      assert(error instanceof ProfileError, `Unexpected ${error.name} after mutation at ${index}`);
      rejected++;
    }
  }
  assert(rejected > 200);
});
