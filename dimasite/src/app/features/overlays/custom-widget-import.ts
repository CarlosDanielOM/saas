import { MANIFEST_FILE, PACKAGE_FILES, PackageFormatError, RESERVED_FIELDS, groupFields, isStreamElementsHost, matchPackageFiles, parseWidgetIni, readPackage,
  type ExternalMedia, type FieldIssue, type JsonObject, type PackageFile, type PackageInput, type WidgetField, type WidgetManifest } from './custom-widget-format.generated';
import { ZipError, blobBytes, blobText, readZip } from './custom-widget-zip';

export interface PickedFile { path: string; blob: Blob }
export interface ImportPart { file: PackageFile; name: string | null; bytes: number }
export interface ImportSummary {
  settings: number; groups: number; issues: FieldIssue[]; remote: ExternalMedia[]; streamElements: ExternalMedia[]; manifest: WidgetManifest; author?: string;
  /** Values the widget reads that the settings panel doesn't show (see `builtInValues`). */
  builtIn: string[];
}
/** What the import dialog shows before anything is uploaded. */
export interface ImportDraft {
  source: PackageInput | null;
  parts: ImportPart[];
  suggestedName: string;
  summary: ImportSummary | null;
  /** i18n key suffix for a problem that blocks the import. */
  error: '' | 'noFiles' | 'noCode' | 'zip' | 'zipEncrypted' | 'zipTooLarge' | 'format';
  errorDetail: string;
}

const TEXT_FILE = /\.(txt|html?|css|js|json|ini)$/i;
const empty = (error: ImportDraft['error'], errorDetail = ''): ImportDraft => ({ source: null, parts: [], suggestedName: '', summary: null, error, errorDetail });
const stem = (path: string) => path.split('/').pop()!.replace(/\.[^.]+$/, '');
const folder = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** Reads picked files, a folder or one .zip into a package. Missing parts become empty files. */
export async function readImport(picked: readonly PickedFile[]): Promise<ImportDraft> {
  let entries: { path: string; text: string }[] = [];
  let fallbackName = '';
  const zip = picked.length === 1 && /\.zip$/i.test(picked[0].path) ? picked[0] : null;
  if (zip) {
    fallbackName = stem(zip.path);
    try {
      const decoder = new TextDecoder();
      entries = (await readZip(await blobBytes(zip.blob))).filter(entry => TEXT_FILE.test(entry.name)).map(entry => ({ path: entry.name, text: decoder.decode(entry.data) }));
    } catch (error) {
      const code = error instanceof ZipError ? error.message : '';
      return empty(code === 'encrypted' ? 'zipEncrypted' : code === 'too-large' || code === 'too-many-files' ? 'zipTooLarge' : 'zip');
    }
  } else {
    const texts = picked.filter(file => TEXT_FILE.test(file.path) && file.blob.size <= 2_000_000);
    entries = await Promise.all(texts.map(async file => ({ path: file.path.replace(/^\/+/, ''), text: await blobText(file.blob) })));
    const folders = [...new Set(entries.map(entry => folder(entry.path)).filter(Boolean))];
    if (folders.length === 1) fallbackName = folders[0].split('/').pop()!;
  }
  if (!entries.length) return empty('noFiles');
  // A widget.ini decides the folder and file names; otherwise names are matched loosely.
  const ini = entries.find(entry => /(^|\/)widget\.ini$/i.test(entry.path));
  const scope = ini ? entries.filter(entry => folder(entry.path) === folder(ini.path)) : entries;
  const names = matchPackageFiles(scope.map(entry => entry.path), ini ? parseWidgetIni(ini.text) : undefined);
  if (!fallbackName && ini && folder(ini.path)) fallbackName = folder(ini.path).split('/').pop()!;
  const source = {} as PackageInput, parts: ImportPart[] = [];
  for (const file of PACKAGE_FILES) {
    const entry = names[file] ? scope.find(item => item.path === names[file]) : undefined;
    source[file] = entry?.text ?? '';
    parts.push({ file, name: entry ? entry.path.split('/').pop()! : null, bytes: entry ? new TextEncoder().encode(entry.text).length : 0 });
  }
  const manifest = scope.find(entry => entry.path.split('/').pop()!.toLowerCase() === MANIFEST_FILE);
  if (manifest) source.manifest = manifest.text;
  if (!source.html.trim() && !source.css.trim() && !source.js.trim()) return { ...empty('noCode'), source, parts };
  try {
    const pkg = readPackage(source);
    const groups = groupFields(pkg.fields);
    return { source, parts, error: '', errorDetail: '',
      suggestedName: (pkg.name || fallbackName || '').slice(0, 80),
      summary: { settings: groups.reduce((sum, group) => sum + group.fields.length, 0), groups: groups.length, issues: pkg.issues,
        remote: pkg.externalMedia, streamElements: pkg.externalMedia.filter(item => isStreamElementsHost(item.host)), manifest: pkg.manifest, ...(pkg.author ? { author: pkg.author } : {}),
        builtIn: builtInValues(pkg.fields, pkg.data) } };
  } catch (error) {
    // The files stay available (the code editor loads them to be fixed); importing still needs them to parse.
    return { ...empty('format', error instanceof PackageFormatError ? error.message : String(error)), source, parts, suggestedName: fallbackName };
  }
}

/**
 * Keys the widget reads but the streamer can't change in Studio: `hidden` fields and data.txt values without a field.
 * The widget's name and author fields are left out (they're shown as the name and author already).
 */
export function builtInValues(fields: readonly WidgetField[], data: Readonly<JsonObject>): string[] {
  const known = new Set(fields.map(field => field.key)), meta = new Set<string>([RESERVED_FIELDS.name, RESERVED_FIELDS.author]);
  const keys = [...fields.filter(field => field.type === 'hidden').map(field => field.key), ...Object.keys(data).filter(key => !known.has(key))];
  return [...new Set(keys)].filter(key => !meta.has(key));
}

/** Files from a drop: DataTransfer items can hold folders, which are walked recursively. */
export async function droppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  const roots = [...transfer.items].map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  if (!roots.length) return [...transfer.files].map(file => ({ path: file.name, blob: file }));
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 300) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: prefix + entry.name, blob: file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      }
    }
  };
  for (const root of roots) await walk(root, '');
  return out;
}
export const pickedFromInput = (files: FileList | null): PickedFile[] =>
  [...(files ?? [])].map(file => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, blob: file }));
