import { Schema, Types, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import Users from '../schemas/users.schema.js';
import { assetQuota, withAssetLibrary } from '../assets/library.js';
import { OverlayError, Studio } from '../overlays/store.js';
import type { OverlayScene, OverlayWidget } from '../overlays/model.js';
import { CUSTOM_WIDGET_LIMITS, CUSTOM_WIDGET_PLAN_LIMITS, PACKAGE_FILES, type CustomWidgetPlan, PackageFormatError, checkOverrides, inferManifest, readPackage, type PackageInput, type WidgetManifest,
  type ExternalMedia, type FieldIssue, type JsonObject, type PackageFile, type PackageSource, type WidgetField } from './format.js';
import { deleteKeys, describeFiles, putFiles, readFile, type PackageFiles, type StoredFile } from './files.js';


export class CustomWidgetError extends OverlayError { constructor(message: string, status = 400, readonly code?: string) { super(message, status); } }

/** One immutable version of a widget's files plus what was read from them. */
export interface WidgetRevision {
  revision: number; files: PackageFiles; fields: WidgetField[]; data: JsonObject;
  externalMedia: ExternalMedia[]; author?: string; createdAt: Date;
  /** From widget.json, or inferred from StreamElements code. Older revisions get it on first read. */
  manifest?: WidgetManifest;
}
/**
 * `custom_widgets`: one document per imported widget. `revisions` keeps the latest revision plus any
 * older one a published overlay still uses; Studio drafts always follow the latest revision.
 * The package's `data` holds the starting setting values (from data.txt); each overlay layer keeps
 * only the settings changed in Studio, in `config.values`.
 */
interface StoredWidget {
  _id: string; owner: string; name: string;
  /** The runtime API the code was written for. Imports use the StreamElements API. */
  engine: 'streamelements';
  revision: number; revisions: WidgetRevision[]; createdAt: Date; updatedAt: Date;
  /** Copied StreamElements files, shared by all revisions: base64url(url) → { url, assetId } (see media.ts). */
  media?: Record<string, { url: string; assetId: string }>;
}
const schema = new Schema<StoredWidget>({ _id: String, owner: String, name: String, engine: String, revision: Number,
  revisions: [Schema.Types.Mixed], createdAt: Date, updatedAt: Date, media: Schema.Types.Mixed }, { versionKey: false, collection: 'custom_widgets', minimize: false });
schema.index({ owner: 1, createdAt: 1 });
export const CustomWidgets = model<StoredWidget>('CustomWidget', schema);

export interface WidgetUse { sceneId: string; sceneName: string; draft: boolean; published: boolean }
export interface CustomWidgetView {
  id: string; name: string; engine: WidgetManifest['engine']; revision: number; author?: string;
  fields: WidgetField[]; data: JsonObject; externalMedia: ExternalMedia[]; manifest: WidgetManifest | null; media: Record<string, string>;
  files: Record<PackageFile, { bytes: number; sha256: string }>;
  createdAt: string; updatedAt: string; usedIn: WidgetUse[];
}
export interface CustomWidgetList { enabled: boolean; planTier: CustomWidgetPlan; limit: number; used: number; widgets: CustomWidgetView[] }

const db = () => getMongoDBConnection('custom-widgets');
/** Copied media as remote URL → asset ID. */
export function mediaUrls(raw: StoredWidget['media']): Record<string, string> {
  return Object.fromEntries(Object.values(raw ?? {}).filter(entry => entry && typeof entry.url === 'string' && typeof entry.assetId === 'string').map(entry => [entry.url, entry.assetId]));
}
const latest = (doc: Pick<StoredWidget, 'revision' | 'revisions'>) => doc.revisions.find(r => r.revision === doc.revision)!;
const isCustom = (widget: OverlayWidget) => widget.kind === 'custom';
const widgetIdOf = (widget: OverlayWidget) => typeof widget.config?.['widgetId'] === 'string' ? widget.config['widgetId'] as string : '';
const validId = (id: string) => /^[a-f0-9]{24}$/.test(id);

function usage(scenes: OverlayScene[], id: string): WidgetUse[] {
  return scenes.map(scene => ({ sceneId: scene.id, sceneName: scene.name,
    draft: scene.widgets.some(w => isCustom(w) && widgetIdOf(w) === id),
    published: !!scene.published?.widgets.some(w => isCustom(w) && widgetIdOf(w) === id) })).filter(use => use.draft || use.published);
}
function view(doc: StoredWidget, scenes: OverlayScene[]): CustomWidgetView {
  const current = latest(doc);
  return { id: doc._id, name: doc.name, engine: current.manifest?.engine ?? doc.engine, revision: doc.revision, ...(current.author ? { author: current.author } : {}),
    fields: current.fields, data: current.data, externalMedia: current.externalMedia, manifest: current.manifest ?? null, media: mediaUrls(doc.media),
    files: Object.fromEntries(PACKAGE_FILES.map(file => [file, { bytes: current.files[file].bytes, sha256: current.files[file].sha256 }])) as CustomWidgetView['files'],
    createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString(), usedIn: usage(scenes, doc._id) };
}
async function scenesOf(owner: string): Promise<OverlayScene[]> { return (await Studio.findById(owner).lean())?.scenes ?? []; }
async function plan(owner: string) {
  const planTier = (await assetQuota(owner)).planTier as CustomWidgetPlan;
  return { planTier, limit: CUSTOM_WIDGET_PLAN_LIMITS[planTier] };
}
function source(raw: unknown): PackageInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CustomWidgetError('Choose the widget files to import');
  const files = raw as Record<string, unknown>;
  for (const key of Object.keys(files)) if (!(PACKAGE_FILES as readonly string[]).includes(key) && key !== 'manifest') throw new CustomWidgetError('Unknown widget file: ' + key.slice(0, 20));
  const result = Object.fromEntries(PACKAGE_FILES.map(file => {
    const text = files[file] ?? '';
    if (typeof text !== 'string') throw new CustomWidgetError(`The ${file} file must be text`);
    return [file, text];
  })) as PackageInput;
  if (files['manifest'] !== undefined && files['manifest'] !== '') {
    if (typeof files['manifest'] !== 'string') throw new CustomWidgetError('widget.json must be text');
    result.manifest = files['manifest'];
  }
  return result;
}
function readSource(files: PackageInput) {
  try { return readPackage(files); }
  catch (error) { if (error instanceof PackageFormatError) throw new CustomWidgetError(error.message, 400, error.code); throw error; }
}
function widgetName(raw: unknown, fallback: string | undefined): string {
  if (raw === undefined || raw === null || raw === '') return fallback || 'Imported widget';
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > CUSTOM_WIDGET_LIMITS.name) throw new CustomWidgetError(`Use a name up to ${CUSTOM_WIDGET_LIMITS.name} characters`);
  return raw.trim();
}
async function owned(owner: string, id: string): Promise<StoredWidget> {
  if (!validId(id)) throw new CustomWidgetError('Custom widget not found', 404);
  const doc = await CustomWidgets.findOne({ _id: id, owner }).lean<StoredWidget>();
  if (!doc) throw new CustomWidgetError('Custom widget not found', 404);
  return doc;
}
function revisionKeys(revisions: WidgetRevision[]): Set<string> { return new Set(revisions.flatMap(r => [...PACKAGE_FILES.map(file => r.files[file].key), ...(r.files.manifest ? [r.files.manifest.key] : [])])); }
function newRevision(revision: number, files: PackageFiles, summary: ReturnType<typeof readPackage>): WidgetRevision {
  return { revision, files, fields: summary.fields, data: summary.data, externalMedia: summary.externalMedia, manifest: summary.manifest, ...(summary.author ? { author: summary.author } : {}), createdAt: new Date() };
}

export async function listWidgets(owner: string): Promise<CustomWidgetList> {
  await db();
  const { planTier, limit } = await plan(owner);
  const [docs, scenes] = await Promise.all([CustomWidgets.find({ owner }).sort({ createdAt: 1 }).lean<StoredWidget[]>(), scenesOf(owner)]);
  return { enabled: true, planTier, limit, used: docs.length, widgets: docs.map(doc => view(doc, scenes)) };
}

/** Imports a widget package as revision 1. Files go to S3 first; a failed insert removes them again. */
export async function createWidget(owner: string, body: Record<string, unknown>): Promise<{ widget: CustomWidgetView; issues: FieldIssue[] }> {
  const files = source(body.files), summary = readSource(files), name = widgetName(body.name, summary.name);
  await db();
  return withAssetLibrary(owner, async () => {
    const { planTier, limit } = await plan(owner);
    if (await CustomWidgets.countDocuments({ owner }) >= limit) {
      throw new CustomWidgetError(`Your plan includes ${limit} custom widget${limit === 1 ? '' : 's'}. Delete one or upgrade to import more.`, 403, planTier === 'pro' ? 'limit' : 'plan_limit');
    }
    const id = new Types.ObjectId().toHexString(), refs = describeFiles(owner, id, files), now = new Date();
    await putFiles(refs, files);
    const doc: StoredWidget = { _id: id, owner, name, engine: 'streamelements', revision: 1, revisions: [newRevision(1, refs, summary)], createdAt: now, updatedAt: now };
    try { await CustomWidgets.create(doc); }
    catch (error) { await deleteKeys(revisionKeys(doc.revisions)); throw error; }
    return { widget: view(doc, await scenesOf(owner)), issues: summary.issues };
  });
}

/** Replaces a widget's files with a new revision. Drafts use it right away; published overlays keep theirs until republished. */
export async function replaceFiles(owner: string, id: string, body: Record<string, unknown>): Promise<{ widget: CustomWidgetView; issues: FieldIssue[] }> {
  const files = source(body.files), summary = readSource(files);
  await db();
  return withAssetLibrary(owner, async () => {
    const doc = await owned(owner, id), revision = doc.revision + 1, refs = describeFiles(owner, id, files);
    const name = body.name === undefined ? doc.name : widgetName(body.name, doc.name);
    await putFiles(refs, files);
    const next = newRevision(revision, refs, summary), updatedAt = new Date();
    const result = await CustomWidgets.updateOne({ _id: id, owner, revision: doc.revision }, { $set: { name, revision, updatedAt }, $push: { revisions: next } });
    if (!result.modifiedCount) {
      const kept = revisionKeys(doc.revisions);
      await deleteKeys([...revisionKeys([next])].filter(key => !kept.has(key)));
      throw new CustomWidgetError('This widget changed while you were updating it. Try again.', 409);
    }
    await pruneRevisions(owner, id);
    return { widget: view({ ...doc, name, revision, revisions: [...doc.revisions, next], updatedAt }, await scenesOf(owner)), issues: summary.issues };
  });
}

export async function renameWidget(owner: string, id: string, body: Record<string, unknown>): Promise<CustomWidgetView> {
  await db();
  return withAssetLibrary(owner, async () => {
    const doc = await owned(owner, id), name = widgetName(body.name, doc.name), updatedAt = new Date();
    await CustomWidgets.updateOne({ _id: id, owner }, { $set: { name, updatedAt } });
    return view({ ...doc, name, updatedAt }, await scenesOf(owner));
  });
}

/** Deleting is refused while any overlay (draft or published) still uses the widget. */
export async function deleteWidget(owner: string, id: string): Promise<{ deleted: true }> {
  await db();
  return withAssetLibrary(owner, async () => {
    const doc = await owned(owner, id), uses = usage(await scenesOf(owner), id);
    if (uses.length) throw new CustomWidgetError(`Remove this widget from ${uses.map(use => `"${use.sceneName}"`).join(', ')} and publish first.`, 409, 'in_use');
    await CustomWidgets.deleteOne({ _id: id, owner });
    await deleteKeys(revisionKeys(doc.revisions));
    return { deleted: true };
  });
}

/** Original file text, for export and (later) the code editor and widget engine. */
export async function widgetFile(owner: string, id: string, file: string, revision?: unknown): Promise<string> {
  if (!(PACKAGE_FILES as readonly string[]).includes(file) && file !== 'manifest') throw new CustomWidgetError('Unknown widget file', 404);
  await db();
  const doc = await owned(owner, id);
  const wanted = revision === undefined ? doc.revision : Number(revision);
  const found = doc.revisions.find(r => r.revision === wanted);
  if (!found) throw new CustomWidgetError('That version of the widget is no longer stored', 404);
  const ref = found.files[file as StoredFile];
  if (!ref) throw new CustomWidgetError('This widget has no widget.json', 404);
  return readFile(ref);
}

/** What the runtime needs to run one revision: code, settings schema, starting values, manifest and copied media. */
export interface WidgetBundle {
  widgetId: string; revision: number; engine: WidgetManifest['engine']; manifest: WidgetManifest;
  html: string; css: string; js: string; fields: WidgetField[]; data: JsonObject; media: Record<string, string>;
  channel: { id: string; login: string; name: string };
}
const channels = new Map<string, { at: number; value: WidgetBundle['channel'] }>();
async function channelInfo(owner: string): Promise<WidgetBundle['channel']> {
  const cached = channels.get(owner);
  if (cached && Date.now() - cached.at < 600_000) return cached.value;
  const user = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: owner } } }).select('accounts').lean();
  const name = String(user?.accounts?.find(account => account.type === 'twitch' && account.id === owner)?.name ?? '');
  const value = { id: owner, login: name.toLowerCase(), name };
  channels.set(owner, { at: Date.now(), value });
  if (channels.size > 1000) channels.delete(channels.keys().next().value!);
  return value;
}
async function bundleOf(doc: StoredWidget, found: WidgetRevision): Promise<WidgetBundle> {
  const [html, css, js] = await Promise.all((['html', 'css', 'js'] as const).map(file => readFile(found.files[file])));
  const manifest = found.manifest ?? inferManifest({ html, js });
  if (!found.manifest) await CustomWidgets.updateOne({ _id: doc._id, 'revisions.revision': found.revision }, { $set: { 'revisions.$.manifest': manifest } });
  return { widgetId: doc._id, revision: found.revision, engine: manifest.engine, manifest, html, css, js, fields: found.fields, data: found.data, media: mediaUrls(doc.media), channel: await channelInfo(doc.owner) };
}
/** Owner editor: latest revision unless one is given. */
export async function widgetBundle(owner: string, id: string, revision?: unknown): Promise<WidgetBundle> {
  await db();
  const doc = await owned(owner, id);
  const wanted = revision === undefined || revision === '' ? doc.revision : Number(revision);
  const found = doc.revisions.find(r => r.revision === wanted);
  if (!found) throw new CustomWidgetError('That version of the widget is no longer stored', 404);
  return bundleOf(doc, found);
}
/** OBS: only a revision that this published overlay pins for a visible layer. */
export async function publishedBundle(owner: string, widgets: OverlayWidget[], id: string, revision: number): Promise<WidgetBundle> {
  if (!widgets.some(w => w.visible && isCustom(w) && widgetIdOf(w) === id && w.config?.['revision'] === revision)) throw new CustomWidgetError('Widget unavailable', 404);
  await db();
  const doc = await owned(owner, id);
  const found = doc.revisions.find(r => r.revision === revision);
  if (!found) throw new CustomWidgetError('Widget unavailable', 404);
  return bundleOf(doc, found);
}
/** Manifests of published widget revisions, cached (revisions never change). */
const manifestCache = new Map<string, WidgetManifest>();
/** Visible custom layers of a published snapshot: widget, engine and what each one uses. */
export async function publishedLayers(owner: string, widgets: OverlayWidget[]): Promise<Map<string, { widgetId: string; engine: WidgetManifest['engine']; uses: Set<string> }>> {
  const layers = widgets.filter(w => w.visible && isCustom(w) && validId(widgetIdOf(w)) && typeof w.config?.['revision'] === 'number');
  const missing = layers.filter(w => !manifestCache.has(`${widgetIdOf(w)}:${w.config!['revision']}`));
  if (missing.length) {
    await db();
    const docs = await CustomWidgets.find({ _id: { $in: [...new Set(missing.map(widgetIdOf))] }, owner }).lean<StoredWidget[]>();
    for (const layer of missing) {
      const doc = docs.find(d => d._id === widgetIdOf(layer)), found = doc?.revisions.find(r => r.revision === layer.config!['revision']);
      if (!doc || !found) continue;
      manifestCache.set(`${doc._id}:${found.revision}`, found.manifest ?? (await bundleOf(doc, found)).manifest);
      if (manifestCache.size > 5000) manifestCache.delete(manifestCache.keys().next().value!);
    }
  }
  const result = new Map<string, { widgetId: string; engine: WidgetManifest['engine']; uses: Set<string> }>();
  for (const layer of layers) {
    const manifest = manifestCache.get(`${widgetIdOf(layer)}:${layer.config!['revision']}`);
    if (manifest) result.set(layer.id, { widgetId: widgetIdOf(layer), engine: manifest.engine, uses: new Set(manifest.uses) });
  }
  return result;
}
/** Whether a copied media asset belongs to a widget pinned by this published snapshot (public asset route). */
export async function publishedMediaAsset(owner: string, widgets: OverlayWidget[], assetId: string): Promise<boolean> {
  const ids = [...new Set(widgets.filter(w => w.visible && isCustom(w) && validId(widgetIdOf(w))).map(widgetIdOf))];
  if (!ids.length) return false;
  await db();
  return (await CustomWidgets.find({ _id: { $in: ids }, owner }).select('media').lean<StoredWidget[]>()).some(doc => Object.values(mediaUrls(doc.media)).includes(assetId));
}

/** Whether an asset is a file copied for one of the channel's custom widgets (Studio previews get longer links for these). */
export async function widgetMediaAsset(owner: string, assetId: string): Promise<boolean> {
  await db();
  return (await CustomWidgets.find({ owner }).select('media').lean<StoredWidget[]>()).some(doc => Object.values(mediaUrls(doc.media)).includes(assetId));
}

async function layerDocs(owner: string, layers: OverlayWidget[]): Promise<Map<string, StoredWidget>> {
  const ids = [...new Set(layers.map(widgetIdOf))];
  if (ids.some(id => !validId(id))) throw new CustomWidgetError('Invalid custom widget layer');
  await db();
  return new Map((await CustomWidgets.find({ _id: { $in: ids }, owner }).lean<StoredWidget[]>()).map(doc => [doc._id, doc]));
}
/**
 * Studio save: every custom layer must point at one of the channel's widgets, and its changed
 * settings must fit the widget's latest fields. Settings removed by new files are dropped; drafts
 * never pin a revision.
 */
export async function checkCustomLayers(owner: string, scenes: OverlayScene[]): Promise<void> {
  const layers = scenes.flatMap(scene => scene.widgets).filter(isCustom);
  if (!layers.length) return;
  const docs = await layerDocs(owner, layers);
  for (const layer of layers) {
    const doc = docs.get(widgetIdOf(layer));
    if (!doc) throw new CustomWidgetError('A custom widget in this overlay was deleted. Remove its layer and save again.', 404, 'missing_widget');
    const checked = checkOverrides(latest(doc).fields, layer.config?.['values']);
    if ('error' in checked) throw new CustomWidgetError(`${doc.name}: ${checked.error}`, 400, 'invalid_value');
    layer.config = { widgetId: doc._id, ...(Object.keys(checked.values).length ? { values: checked.values } : {}) };
  }
}
/** Studio publish: pin each custom layer in the published copy to the widget's current revision. */
export async function pinCustomLayers(owner: string, widgets: OverlayWidget[]): Promise<void> {
  const layers = widgets.filter(isCustom);
  if (!layers.length) return;
  const docs = await layerDocs(owner, layers);
  for (const layer of layers) {
    const doc = docs.get(widgetIdOf(layer));
    if (!doc) throw new CustomWidgetError('A custom widget in this overlay was deleted. Remove its layer before publishing.', 404, 'missing_widget');
    const checked = checkOverrides(latest(doc).fields, layer.config?.['values']);
    if ('error' in checked) throw new CustomWidgetError(`${doc.name}: ${checked.error}`, 400, 'invalid_value');
    layer.config = { widgetId: doc._id, revision: doc.revision, ...(Object.keys(checked.values).length ? { values: checked.values } : {}) };
  }
}
/** Drops revisions that are neither the latest nor used by a published overlay, and their unshared files. */
export async function pruneRevisions(owner: string, onlyId?: string): Promise<void> {
  await db();
  const docs = await CustomWidgets.find(onlyId ? { _id: onlyId, owner } : { owner }).lean<StoredWidget[]>();
  if (!docs.some(doc => doc.revisions.length > 1)) return;
  const scenes = await scenesOf(owner);
  const pinned = new Set(scenes.flatMap(scene => scene.published?.widgets ?? []).filter(isCustom).map(w => `${widgetIdOf(w)}:${w.config?.['revision']}`));
  for (const doc of docs) {
    const kept = doc.revisions.filter(r => r.revision === doc.revision || pinned.has(`${doc._id}:${r.revision}`));
    if (kept.length === doc.revisions.length) continue;
    const result = await CustomWidgets.updateOne({ _id: doc._id, owner, revision: doc.revision }, { $set: { revisions: kept } });
    if (!result.modifiedCount) continue;
    const keep = revisionKeys(kept);
    await deleteKeys([...revisionKeys(doc.revisions)].filter(key => !keep.has(key)));
  }
}
