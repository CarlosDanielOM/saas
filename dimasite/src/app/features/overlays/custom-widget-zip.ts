/**
 * Minimal zip support for widget packages: reads stored and deflated entries (the browser's
 * DecompressionStream does the inflating) and writes stored entries. No zip64, no encryption.
 */
export interface ZipEntry { name: string; data: Uint8Array }
export class ZipError extends Error {}

/** Blob contents; falls back to FileReader where Blob lacks arrayBuffer() (older engines, jsdom). */
export function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob); });
}
export async function blobText(blob: Blob): Promise<string> { return new TextDecoder().decode(await blobBytes(blob)); }

const MAX_ENTRIES = 300;
const MAX_TOTAL_BYTES = 8_000_000;

export async function readZip(input: ArrayBuffer): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(input), view = new DataView(input);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ZipError('not-zip');
  const count = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES) throw new ZipError('too-many-files');
  const entries: ZipEntry[] = [];
  let offset = directory, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new ZipError('corrupt');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()!.startsWith('._')) continue;
    if (flags & 1) throw new ZipError('encrypted');
    if (compressed === 0xffffffff || size === 0xffffffff) throw new ZipError('zip64');
    total += size; if (total > MAX_TOTAL_BYTES) throw new ZipError('too-large');
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new ZipError('corrupt');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    if (method === 0) entries.push({ name, data: raw.slice() });
    else if (method === 8) entries.push({ name, data: await inflate(raw, size) });
    else throw new ZipError('unsupported-compression');
  }
  return entries;
}

async function inflate(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Response(raw as BodyInit).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > expected || length > MAX_TOTAL_BYTES) { await reader.cancel(); throw new ZipError('too-large'); }
    parts.push(value);
  }
  const out = new Uint8Array(length); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a zip of stored (uncompressed) files. */
export function writeZip(files: { name: string; text: string }[]): Blob {
  const encoder = new TextEncoder(), locals: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), data = encoder.encode(file.text), crc = crc32(data);
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint16(8, 0, true);
    lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const entry = new Uint8Array(46 + name.length), cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); entry.set(name, 46);
    locals.push(local, data); central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end] as BlobPart[], { type: 'application/zip' });
}
