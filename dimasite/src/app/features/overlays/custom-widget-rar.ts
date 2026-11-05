import { ZipError, type ZipEntry } from './custom-widget-zip';

/** Same limits as .zip packages; the archive itself is capped too (it is read into memory). */
const MAX_ENTRIES = 300, MAX_TOTAL_BYTES = 8_000_000, MAX_ARCHIVE_BYTES = 20_000_000;
const TEXT_FILE = /\.(txt|html?|css|js|json|ini)$/i;
let wasmBinary: Promise<ArrayBuffer> | undefined;

/**
 * Text files of a .rar widget package (many StreamElements widgets ship as .rar). unrar runs as WebAssembly and both
 * are loaded only when a .rar is picked. Sizes are checked from the headers before anything is extracted, then again
 * on the extracted data. Errors use the zip reader's codes ('encrypted', 'too-large', 'too-many-files', 'corrupt').
 */
export async function readRar(input: ArrayBuffer): Promise<ZipEntry[]> {
  if (input.byteLength > MAX_ARCHIVE_BYTES) throw new ZipError('too-large');
  wasmBinary ??= fetch(new URL('assets/widget-runtime/unrar.wasm', document.baseURI).href)
    .then(response => { if (!response.ok) throw new Error('unrar unavailable'); return response.arrayBuffer(); });
  wasmBinary.catch(() => { wasmBinary = undefined; });
  const [{ createExtractorFromData }, wasm] = await Promise.all([import('node-unrar-js'), wasmBinary]);
  try {
    const extractor = await createExtractorFromData({ wasmBinary: wasm, data: input });
    const list = extractor.getFileList();
    // Multi-part archives can't be read from one file; encrypted headers can't be listed.
    if (list.arcHeader.flags.volume) throw new ZipError('multipart');
    if (list.arcHeader.flags.headerEncrypted) throw new ZipError('encrypted');
    const headers = [];
    for (const header of list.fileHeaders) { headers.push(header); if (headers.length > MAX_ENTRIES) throw new ZipError('too-many-files'); }
    const wanted = headers.filter(header => !header.flags.directory && TEXT_FILE.test(header.name));
    if (wanted.some(header => header.flags.encrypted)) throw new ZipError('encrypted');
    // Every entry counts (like .zip): in solid archives, reaching a file means unpacking the ones before it.
    if (headers.reduce((total, header) => total + header.unpSize, 0) > MAX_TOTAL_BYTES) throw new ZipError('too-large');
    const names = new Set(wanted.map(header => header.name));
    const entries: ZipEntry[] = [];
    let total = 0;
    for (const file of extractor.extract({ files: header => names.has(header.name) }).files) {
      if (!file.extraction) continue;
      total += file.extraction.length;
      if (total > MAX_TOTAL_BYTES) throw new ZipError('too-large');
      entries.push({ name: file.fileHeader.name.replace(/\\/g, '/'), data: file.extraction });
    }
    return entries;
  } catch (error) {
    if (error instanceof ZipError) throw error;
    // unrar reports archives with encrypted headers as missing a password.
    throw new ZipError(/password/i.test(String((error as { reason?: string; message?: string })?.reason ?? (error as Error)?.message ?? '')) ? 'encrypted' : 'corrupt');
  }
}
