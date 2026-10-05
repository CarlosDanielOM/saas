import { validKeyframes } from './keyframes.js';
import { randomBytes } from 'node:crypto';
import { Schema, model } from 'mongoose';
import Users from '../schemas/users.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { CLIP_DESIGN_VARIANTS, ALERT_TRANSITIONS, ALERT_LOOPS, ALERT_EVENTS, EVENT_KINDS, type AlertLayout, type AlertVariant, type AlertDesign, type OverlayScene, type OverlayWidget, makeDesign, makeScene } from './model.js';
import { initialQueueState, type QueueState } from './controls.js';
import { parseTemplate } from './ast.js';

export class OverlayError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface StudioState { schemaVersion: 1; revision: number; scenes: OverlayScene[]; designs: AlertDesign[] }
interface Stored extends StudioState { _id: string; controls?: QueueState }
const schema = new Schema<Stored>({ _id: String, schemaVersion: Number, revision: Number, scenes: [Schema.Types.Mixed], designs: [Schema.Types.Mixed], controls: Schema.Types.Mixed }, { versionKey: false, collection: 'overlay_studios' });
schema.index({ 'scenes.publicId': 1 }, { unique: true });
export const Studio = model<Stored>('OverlayStudio', schema);
export const token = () => randomBytes(24).toString('hex');
export async function requireOverlayAccount(channel: string) {
  await getMongoDBConnection('overlay-studio');
  if (!await Users.exists({ accounts: { $elemMatch: { type: 'twitch', id: channel } } })) throw new OverlayError('Overlay account unavailable', 403);
}
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
    if (!(nested ? ['text', 'image', 'video', 'animation', 'shape'] : ['tts', 'clip', 'trigger', 'alert', 'text', 'image', 'video', 'shape']).includes(kind)) throw new OverlayError('Invalid layer type');
    const item: OverlayWidget = { id: id(w.id), kind, x: number(w.x, -16000, 16000), y: number(w.y, -16000, 16000), width: number(w.width, 20, 16000), height: number(w.height, 20, 16000), visible: boolean(w.visible), locked: boolean(w.locked) };
    if (w.keyframes !== undefined) {
      if (!nested || !validKeyframes(w.keyframes)) throw new OverlayError('Invalid object keyframes');
      // Rebuild the accepted data rather than storing unrecognized client fields.
      item.keyframes = Object.fromEntries(Object.entries(w.keyframes).map(([phase, sequence]) => [phase, { tracks: sequence.tracks.map(track => ({ property: track.property, points: track.points.map(({offset, value, easing}) => ({offset, value, easing})) })) }]));
    }
    if (w.motion !== undefined) {
      if (!nested) throw new OverlayError('Object animations require an alert design');
      const motion = object(w.motion);
      if (!ALERT_TRANSITIONS.includes(motion.enter as never) || !ALERT_TRANSITIONS.includes(motion.exit as never) || !ALERT_LOOPS.includes(motion.loop as never)) throw new OverlayError('Invalid object animation');
      item.motion = { enter: motion.enter as NonNullable<OverlayWidget['motion']>['enter'], exit: motion.exit as NonNullable<OverlayWidget['motion']>['exit'], loop: motion.loop as NonNullable<OverlayWidget['motion']>['loop'],
        delay: number(motion.delay, 0, 120), enterDuration: number(motion.enterDuration, .1, 5), exitDuration: number(motion.exitDuration, .1, 5), loopDuration: number(motion.loopDuration, .2, 10) };
    }
    if (w.name !== undefined) item.name = typeof w.name === 'string' && w.name.length <= 80 ? w.name : string(w.name, 80);
    if (w.clipDesign !== undefined) {
      if (kind !== 'clip' || !CLIP_DESIGN_VARIANTS.includes(w.clipDesign as never)) throw new OverlayError('Invalid clip design');
      item.clipDesign = w.clipDesign as OverlayWidget['clipDesign'];
    }
    if (w.triggerIds !== undefined) {
      if (kind !== 'trigger') throw new OverlayError('Trigger filters require a trigger widget');
      item.triggerIds = list(w.triggerIds, 1000).map(value => {
        if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new OverlayError('Invalid trigger selection');
        return value;
      });
      if (new Set(item.triggerIds).size !== item.triggerIds.length) throw new OverlayError('Duplicate trigger selection');
    }
    if (w.triggerPlacement !== undefined) {
      if (nested || kind !== 'trigger') throw new OverlayError('Trigger placement requires a trigger widget');
      const placement = object(w.triggerPlacement);
      if (placement.mode !== 'fixed' && placement.mode !== 'random') throw new OverlayError('Invalid trigger placement');
      item.triggerPlacement = { mode: placement.mode, margin: number(placement.margin, 0, 500) };
    }
    if (kind === 'alert') { item.designId = id(w.designId); item.events = list(w.events, 4).map(e => { if (!ALERT_EVENTS.includes(e as never)) throw new OverlayError('Invalid event'); return e as typeof ALERT_EVENTS[number]; }); }
    if (kind === 'text') { item.text = typeof w.text === 'string' ? w.text : ''; if (nested) { try { parseTemplate(item.text); } catch (e) { throw new OverlayError((e as Error).message); } } }
    if (w.assetId) {
      if (!['image', 'video'].includes(kind) || !/^[a-f0-9]{24}$/.test(String(w.assetId))) throw new OverlayError('Invalid design asset');
      item.assetId = id(w.assetId);
    } else if (w.mediaUrl) { const url = string(w.mediaUrl, 2048); if (!/^https:\/\//i.test(url) || new URL(url).username || new URL(url).password) throw new OverlayError('Media requires an HTTPS URL'); item.mediaUrl = url; }
    if (w.color) { if (!/^#[0-9a-f]{6}$/i.test(String(w.color))) throw new OverlayError('Invalid color'); item.color = String(w.color); }
    if (w.fontSize !== undefined) item.fontSize = number(w.fontSize, 8, 300);
    for (const [key, choices] of Object.entries({ fontFamily: ['sans', 'serif', 'mono'], fontWeight: [400, 700], textAlign: ['left', 'center', 'right'], shape: ['rectangle', 'ellipse'] })) {
      if (w[key] !== undefined) { if (!(choices as unknown[]).includes(w[key])) throw new OverlayError('Invalid object style'); Object.assign(item, { [key]: w[key] }); }
    }
    if (w.italic !== undefined) item.italic = boolean(w.italic);
    for (const [key, max] of [['borderWidth', 40], ['radius', 500], ['opacity', 1]] as const) if (w[key] !== undefined) item[key] = number(w[key], 0, max);
    if (w.borderColor !== undefined) item.borderColor = color(w.borderColor);
    if (w.shadow !== undefined) { const shadow = object(w.shadow); item.shadow = { color: color(shadow.color), blur: number(shadow.blur, 0, 100), x: number(shadow.x, -100, 100), y: number(shadow.y, -100, 100) }; }
    return item;
  }));
}
function color(value: unknown): string { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new OverlayError('Invalid color'); return value; }
function alertLayout(raw: unknown): AlertLayout {
  const layout = object(raw), result: AlertLayout = { duration: number(layout.duration, 1, 120), widgets: widgets(layout.widgets, true) };
  if (layout.sound !== undefined) {
    const sound = object(layout.sound);
    if (typeof sound.assetId !== 'string' || !/^[a-f0-9]{24}$/.test(sound.assetId)) throw new OverlayError('Invalid alert sound');
    result.sound = { assetId: sound.assetId, ...(sound.name === undefined ? {} : { name: string(sound.name, 120) }),
      volume: number(sound.volume, 0, 1), delay: number(sound.delay, 0, 120), fadeIn: number(sound.fadeIn, 0, 10), fadeOut: number(sound.fadeOut, 0, 10) };
  }
  return result;
}
export function validateState(raw: unknown, previous: StudioState): Pick<StudioState, 'scenes' | 'designs'> {
  const body = object(raw);
  const designs = unique(list(body.designs, 50).map(raw => {
    const d = object(raw); const events = object(d.events); const old = previous.designs.find(x => x.id === d.id);
    const design: AlertDesign = { id: id(d.id), name: string(d.name, 80), ...canvas(d), revision: (old?.revision ?? 0) + 1, events: {} as AlertDesign['events'] };
    for (const kind of ALERT_EVENTS) design.events[kind] = alertLayout(events[kind]);
    if (d.variants !== undefined) {
      const variants = object(d.variants); design.variants = {};
      if (Object.keys(variants).some(key => !['sub', 'bits', 'raid'].includes(key))) throw new OverlayError('Invalid variant event');
      for (const kind of ['sub', 'bits', 'raid'] as const) if (variants[kind] !== undefined) {
        design.variants[kind] = unique(list(variants[kind], 10).map(raw => {
          const v = object(raw);
          const result: AlertVariant = { id: id(v.id), name: string(v.name, 80), enabled: boolean(v.enabled), layout: alertLayout(v.layout) };
          if (kind === 'sub') {
            if (!['1000', '2000', '3000'].includes(v.tier as string) || v.min !== undefined || v.max !== undefined) throw new OverlayError('Choose a subscription tier');
            result.tier = v.tier as AlertVariant['tier'];
          } else {
            if (v.tier !== undefined) throw new OverlayError('Invalid amount rule');
            for (const key of ['min', 'max'] as const) if (v[key] !== undefined) {
              result[key] = number(v[key], 0, 1000000000);
              if (!Number.isInteger(result[key])) throw new OverlayError('Use a whole amount');
            }
            if (result.min === undefined || (result.max !== undefined && result.max < result.min)) throw new OverlayError('Invalid amount range');
          }
          return result;
        }));
      }
    }
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
  await requireOverlayAccount(channel); let stored = await Studio.findById(channel).lean();
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
  await requireOverlayAccount(state._id);
  const scene = state.scenes.find(s => s.publicId === publicId)!;
  if (!scene.published) throw new OverlayError('This overlay has not been published', 404);
  return { channel: state._id, publicId, revision: scene.revision, snapshot: scene.published, controls: { ...initialQueueState(), ...state.controls } };
}
