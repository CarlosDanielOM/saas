import { randomBytes } from 'node:crypto';
import { Schema, model } from 'mongoose';
import Users from '../schemas/users.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { ALERT_EVENTS, EVENT_KINDS, type AlertDesign, type OverlayScene, type OverlayWidget, makeDesign, makeScene } from './model.js';
import { parseTemplate } from './ast.js';

export class OverlayError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface StudioState { schemaVersion: 1; revision: number; scenes: OverlayScene[]; designs: AlertDesign[] }
interface Stored extends StudioState { _id: string }
const schema = new Schema<Stored>({ _id: String, schemaVersion: Number, revision: Number, scenes: [Schema.Types.Mixed], designs: [Schema.Types.Mixed] }, { versionKey: false, collection: 'overlay_studios' });
schema.index({ 'scenes.publicId': 1 }, { unique: true });
export const Studio = model<Stored>('OverlayStudio', schema);
export const token = () => randomBytes(24).toString('hex');
export async function hasPro(channel: string) { await getMongoDBConnection('overlay-studio'); return !!await Users.exists({ accounts: { $elemMatch: { type: 'twitch', id: channel } }, plan_tier: 'pro' }); }
export async function requirePro(channel: string) { if (!await hasPro(channel)) throw new OverlayError('Overlay Studio Alpha requires Pro', 403); }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OverlayError('Expected an object'); return value as Record<string, unknown>; }
export function string(value: unknown, max = 100): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new OverlayError('Invalid text'); return value; }
function id(value: unknown) { const result = string(value); if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new OverlayError('Invalid ID'); return result; }
function number(value: unknown, min: number, max: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new OverlayError('Invalid dimension or duration'); return value; }
function boolean(value: unknown) { if (typeof value !== 'boolean') throw new OverlayError('Expected a boolean'); return value; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new OverlayError('Too many or invalid items'); return value; }
function unique<T extends { id: string }>(items: T[]): T[] { if (new Set(items.map(x => x.id)).size !== items.length) throw new OverlayError('Duplicate ID'); return items; }
function canvas(v: Record<string, unknown>) { return { width: number(v.width, 100, 7680), height: number(v.height, 100, 7680) }; }
function widgets(value: unknown, nested: boolean): OverlayWidget[] {
  return unique(list(value, 60).map(raw => {
    const w = object(raw); const kind = string(w.kind) as OverlayWidget['kind'];
    if (!(nested ? ['text', 'image', 'video', 'animation'] : ['tts', 'clip', 'trigger', 'alert', 'text', 'image', 'video']).includes(kind)) throw new OverlayError('Invalid layer type');
    const item: OverlayWidget = { id: id(w.id), kind, x: number(w.x, -16000, 16000), y: number(w.y, -16000, 16000), width: number(w.width, 20, 16000), height: number(w.height, 20, 16000), visible: boolean(w.visible), locked: boolean(w.locked) };
    if (w.name !== undefined) item.name = typeof w.name === 'string' && w.name.length <= 80 ? w.name : string(w.name, 80);
    if (kind === 'alert') { item.designId = id(w.designId); item.events = list(w.events, 4).map(e => { if (!ALERT_EVENTS.includes(e as never)) throw new OverlayError('Invalid event'); return e as typeof ALERT_EVENTS[number]; }); }
    if (kind === 'text') { item.text = typeof w.text === 'string' ? w.text : ''; if (nested) { try { parseTemplate(item.text); } catch (e) { throw new OverlayError((e as Error).message); } } }
    if (w.assetId) {
      if (!['image', 'video'].includes(kind) || !/^[a-f0-9]{24}$/.test(String(w.assetId))) throw new OverlayError('Invalid design asset');
      item.assetId = id(w.assetId);
    } else if (w.mediaUrl) { const url = string(w.mediaUrl, 2048); if (!/^https:\/\//i.test(url) || new URL(url).username || new URL(url).password) throw new OverlayError('Media requires an HTTPS URL'); item.mediaUrl = url; }
    if (w.color) { if (!/^#[0-9a-f]{6}$/i.test(String(w.color))) throw new OverlayError('Invalid color'); item.color = String(w.color); }
    if (w.fontSize !== undefined) item.fontSize = number(w.fontSize, 8, 300);
    return item;
  }));
}
export function validateState(raw: unknown, previous: StudioState): Pick<StudioState, 'scenes' | 'designs'> {
  const body = object(raw);
  const designs = unique(list(body.designs, 50).map(raw => {
    const d = object(raw); const events = object(d.events); const old = previous.designs.find(x => x.id === d.id);
    const design: AlertDesign = { id: id(d.id), name: string(d.name, 80), ...canvas(d), revision: (old?.revision ?? 0) + 1, events: {} as AlertDesign['events'] };
    for (const kind of ALERT_EVENTS) { const layout = object(events[kind]); design.events[kind] = { duration: number(layout.duration, 1, 120), widgets: widgets(layout.widgets, true) }; }
    return design;
  }));
  const scenes = unique(list(body.scenes, 25).map(raw => {
    const s = object(raw); const old = previous.scenes.find(x => x.id === s.id);
    const scene: OverlayScene = { id: id(s.id), name: string(s.name, 80), ...canvas(s), widgets: widgets(s.widgets, false),
      waitFor: [...new Set(list(s.waitFor, 7).map(e => { if (!EVENT_KINDS.includes(e as never)) throw new OverlayError('Invalid wait category'); return e as typeof EVENT_KINDS[number]; }))],
      publicId: old?.publicId ?? token(), revision: old?.revision ?? 0, ...(old?.published ? { published: old.published } : {}) };
    if (scene.widgets.some(w => w.kind === 'alert' && !designs.some(d => d.id === w.designId))) throw new OverlayError('Alert design is missing');
    return scene;
  }));
  if (!scenes.length || !designs.length) throw new OverlayError('Keep at least one overlay and alert design');
  if (Buffer.byteLength(JSON.stringify({ scenes, designs })) > 4 * 1024 * 1024) throw new OverlayError('Overlay storage limit reached');
  return { scenes, designs };
}
export async function load(channel: string): Promise<StudioState> {
  await requirePro(channel); let stored = await Studio.findById(channel).lean();
  if (!stored) {
    const design = makeDesign('starter', 'My alerts'); design.events.bits.widgets[1].text = '$(user) sent $(cheer.amount) bits';
    design.events.raid.widgets[1].text = '$(raid.channel) arrived with $(raid.viewers) viewers';
    const scene = makeScene('main', 'My overlay', design.id); scene.publicId = token();
    try { await Studio.create({ _id: channel, schemaVersion: 1, revision: 0, scenes: [scene], designs: [design] }); } catch (e) { if ((e as { code?: number }).code !== 11000) throw e; }
    stored = await Studio.findById(channel).lean();
  }
  return { schemaVersion: 1, revision: stored!.revision, scenes: stored!.scenes, designs: stored!.designs };
}
export async function change(channel: string, revision: number, operation: (state: StudioState) => void | Promise<void>): Promise<StudioState> {
  const state = await load(channel); if (!Number.isInteger(revision) || revision !== state.revision) throw new OverlayError('The draft changed. Reload before saving.', 409);
  await operation(state);
  const result = await Studio.updateOne({ _id: channel, revision }, { $set: { scenes: state.scenes, designs: state.designs }, $inc: { revision: 1 } });
  if (!result.modifiedCount) throw new OverlayError('The draft changed. Reload before saving.', 409);
  return { ...state, revision: revision + 1 };
}
export async function publicState(publicId: string) {
  if (!/^[a-f0-9]{48}$/.test(publicId)) throw new OverlayError('Overlay not found', 404);
  await getMongoDBConnection('overlay-public');
  const state = await Studio.findOne({ 'scenes.publicId': publicId }).lean();
  if (!state) throw new OverlayError('Overlay not found', 404);
  await requirePro(state._id);
  const scene = state.scenes.find(s => s.publicId === publicId)!;
  if (!scene.published) throw new OverlayError('This overlay has not been published', 404);
  return { channel: state._id, publicId, revision: scene.revision, snapshot: scene.published };
}
