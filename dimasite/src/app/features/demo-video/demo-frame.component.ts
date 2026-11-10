import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BadgeCheck, Bot, Gem, Heart, Info, LucideAngularModule, LucideIconData, ShieldCheck, Star, Sword, Users, Video } from 'lucide-angular';
import { DuelStageComponent } from '../widgets/duel/duel-stage.component';
import { RouletteDisplayComponent } from '../roulette/roulette-display.component';
import { slotsFor, type Roulette, type RouletteDraw } from '../roulette/roulette-api.service';
import { OverlaySceneRendererComponent } from '../overlays/overlay-scene-renderer.component';
import type { Snapshot } from '../overlays/overlay-api.service';
import type { OverlayRenderJob } from '../overlays/overlay-playback';
import type { OverlayWidget } from '../overlays/overlay.model';
import { DemoAlertComponent, ALERT_BOX } from './demo-alert.component';
import { DemoClockDirective } from './demo-clock.directive';
import { DemoGameComponent } from './demo-game.component';
import { DemoCamComponent } from './demo-cam.component';
import { demoBattle, duelOutcome } from './demo-duel';
import {
  DEFAULT_ROULETTE_SPIN_MS, DEMO_FORMATS, ROULETTE_LEAD_MS, STAGE, beatSeed, captionSpans, directorShots, seededRandom,
  type DemoAmbientLine, type DemoBeat, type DemoFormat, type DemoLook, type DemoScene, type DemoShotFocus
} from './demo-scene';

interface Rect { x: number; y: number; width: number; height: number }
const TTS_BOX: Rect = { x: 560, y: 760, width: 800, height: 210 };
const ROULETTE_BOX: Rect = { x: 1250, y: 60, width: 620, height: 620 };
const FOCUS: Record<string, Rect> = {
  full: { x: 0, y: 0, width: STAGE.width, height: STAGE.height },
  stream: { x: 0, y: 0, width: STAGE.width, height: STAGE.height },
  alert: pad(ALERT_BOX, 70),
  tts: pad(TTS_BOX, 70),
  // The duel overlay uses the whole canvas (names and HP bars sit at the edges), so it is never cropped.
  duel: { x: 0, y: 0, width: STAGE.width, height: STAGE.height },
  roulette: pad(ROULETTE_BOX, 50)
};
function pad(r: Rect, n: number): Rect { return { x: r.x - n, y: r.y - n, width: r.width + 2 * n, height: r.height + 2 * n }; }

const PRIZE_COLORS = ['#cbbaff', '#f4c968', '#ec9baf', '#8fd3c7', '#9cc3ff', '#f6a96b'];
/** Chat name colors per look: readable on that look's chat background. */
const NAME_COLORS: Record<DemoLook, readonly string[]> = {
  studio: ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff9b', '#c79bff', '#ff9f6b', '#6bd7c2', '#a3b4ff'],
  broadcast: ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff9b', '#c79bff', '#ff9f6b', '#6bd7c2', '#a3b4ff'],
  paper: ['#c2410c', '#1d4ed8', '#15803d', '#7e22ce', '#be123c', '#0f766e', '#a16207', '#4338ca'],
  signal: ['#c8ff2e', '#f4f4ef', '#c8ff2e', '#d9d9d2'],
  night: ['#f2f1f6', '#cdb6ff', '#a970ff', '#e4e2ec', '#b9a3f5'],
  site: ['#c4b5fd', '#86efac', '#fbbf24', '#f9a8d4', '#93c5fd', '#fca5a5', '#5eead4', '#fdba74']
};
const BOT_COLOR: Record<DemoLook, string> = { studio: '#c4b5fd', broadcast: '#c9a8ff', paper: '#6d28d9', signal: '#c8ff2e', night: '#a970ff', site: '#c4b5fd' };
const DRAW_EPOCH = 1_700_000_000_000;
/** More than the tallest chat box can show (the rest is above its top edge). */
const MAX_LINES = 32;

const COPY = {
  en: { chat: 'Stream chat', first: 'First message', deleted: '<message deleted>', banned: '{user} has been permanently banned.', live: 'LIVE', tagline: 'A Twitch chatbot that grows with you', cta: 'Free to start', companion: 'Stream Companion' },
  es: { chat: 'Chat del stream', first: 'Primer mensaje', deleted: '<mensaje eliminado>', banned: '{user} fue baneado permanentemente.', live: 'EN VIVO', tagline: 'Un chatbot de Twitch que crece contigo', cta: 'Empieza gratis', companion: 'Stream Companion' }
} as const;

export interface ChatLine {
  key: string; kind: 'viewer' | 'bot' | 'event' | 'notice'; at: number;
  user: string; text: string; color: string; badges: LucideIconData[]; badgeTones: string[]; first: boolean;
  /** Background chat (not part of the script). */
  crowd: boolean;
  icon: LucideIconData | null; deletedAt: number | null;
  highlight: { at: number; end: number; label: string } | null;
}
interface Segment { text: string; em: boolean }
/** A caption word (or the space after it), numbered so kinetic looks can bring words in one by one. */
interface Word { text: string; em: boolean; space: boolean; i: number }

const BADGE_ICONS: Record<string, [LucideIconData, string]> = {
  broadcaster: [Video, 'red'], mod: [Sword, 'green'], vip: [Gem, 'pink'], sub: [Star, 'violet'], verified: [BadgeCheck, 'violet'], bot: [Bot, 'bot']
};
const EVENT_ICONS: Record<string, LucideIconData> = { follow: Heart, sub: Star, bits: Gem, raid: Users, shield: ShieldCheck, info: Info };

/** `*word*` marks the words a caption colors. */
export function segments(text: string): Segment[] {
  return text.split(/(\*[^*]+\*)/).filter(Boolean).map((part) => (part.startsWith('*') && part.endsWith('*') && part.length > 2 ? { text: part.slice(1, -1), em: true } : { text: part, em: false }));
}
/** Split `*em*` segments into words and spaces; `i` counts words only. */
export function words(text: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  for (const part of segments(text)) {
    for (const token of part.text.split(/(\s+)/).filter(Boolean)) {
      const space = /^\s+$/.test(token);
      out.push({ text: space ? ' ' : token, em: part.em, space, i: space ? i : i++ });
    }
  }
  return out;
}
function nameColor(name: string, look: DemoLook): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const colors = NAME_COLORS[look];
  return colors[h % colors.length];
}
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** How long the last caption takes to fade under the closing card. */
const CAPTION_FADE_MS = 300;
/** How long a full-screen card takes to leave; the picture behind it settles into place over the same time. */
const CARD_EXIT_MS = 420;

/* The director's camera: where the whole picture (stream + chat) sits for each shot, per format.
   Scale `k` around the anchor (ax, ay), in frame px. Landscape has room to push in on the chat for real (the chat
   text is small there); a vertical frame is already as wide as the chat can get next to the app's own buttons, so
   it only leans in. `settle` is the slightly closer view a card hands over from / to. */
interface View { k: number; ax: number; ay: number }
const VIEWS: Record<DemoFormat, Record<DemoShotFocus | 'settle', View>> = {
  landscape: { wide: { k: 1, ax: 0, ay: 0 }, chat: { k: 1.25, ax: 960, ay: 540 }, settle: { k: 1.045, ax: 480, ay: 270 } },
  vertical: { wide: { k: 1, ax: 0, ay: 0 }, chat: { k: 1.03, ax: 14, ay: 824 }, settle: { k: 1.045, ax: 270, ay: 480 } }
};
/** Spring stiffness (1/s). Critically damped: no bounce, settles in about 0.75 s. */
const CAMERA_W = 8.5;
/** A ban lands with a small push of the camera (scale per second, gone in half a second). */
const KICK = 0.42;
type Vec3 = [number, number, number];
const pose = (v: View): Vec3 => [v.k, v.ax * (1 - v.k), v.ay * (1 - v.k)];
/** Critically damped spring: position and speed `dt` seconds after (x, v), heading for `target`. */
function spring(x: number, v: number, target: number, dt: number): [number, number] {
  const a = x - target, b = v + CAMERA_W * a, e = Math.exp(-CAMERA_W * dt);
  return [target + (a + b * dt) * e, (b - CAMERA_W * (a + b * dt)) * e];
}

/**
 * One video frame: a fake stream with the real overlay components on it, a Twitch-style chat, captions and brand
 * cards. Everything on screen is a function of the scene and `t` (ms), so any t renders the same frame.
 */
@Component({
  selector: 'app-demo-frame',
  imports: [NgTemplateOutlet, LucideAngularModule, DemoClockDirective, DemoGameComponent, DemoCamComponent, DemoAlertComponent, DuelStageComponent, RouletteDisplayComponent, OverlaySceneRendererComponent],
  templateUrl: './demo-frame.component.html',
  styleUrls: ['./demo-frame.component.css', './demo-looks.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-format]': 'format()', '[attr.data-look]': 'scene().look', '[style.width.px]': 'size().width', '[style.height.px]': 'size().height' }
})
export class DemoFrameComponent {
  readonly scene = input.required<DemoScene>();
  readonly format = input.required<DemoFormat>();
  readonly t = input.required<number>();
  readonly alertReady = output<string>();

  readonly icons = { bot: Bot };
  readonly size = computed(() => DEMO_FORMATS[this.format()]);
  readonly copy = computed(() => COPY[this.scene().lang]);
  readonly segments = segments;
  readonly words = words;
  /** The logo in ink for the light (print) look, white everywhere else. */
  /** Running scene time for the technical looks, e.g. T+03.40. */
  readonly timecode = computed(() => `T+${(this.t() / 1000).toFixed(2).padStart(5, '0')}`);
  readonly label = computed(() => ['DomDimaBot', this.scene().title].filter(Boolean).join('  ×  '));
  readonly mark = computed(() => (this.scene().look === 'paper' ? '/assets/brand/mark-on-light.png' : '/assets/brand/mark-on-dark.png'));
  readonly stage = STAGE;
  readonly ttsBox = TTS_BOX;
  readonly alertBox = ALERT_BOX;
  readonly rouletteBox = ROULETTE_BOX;

  private readonly beats = computed(() => this.scene().beats);
  private beatsOf(kind: string): DemoBeat[] { return this.beats().filter((b) => b.do === kind); }
  readonly alerts = computed(() => this.beatsOf('alert'));
  readonly duels = computed(() => this.beatsOf('duel').map((beat) => ({ beat, battle: demoBattle(beatSeed(this.scene().seed, beat.index)) })));
  readonly roulettes = computed(() => this.beatsOf('roulette').map((beat) => this.rouletteFor(beat)));

  /** Active = on screen at t. */
  private active(kind: string): DemoBeat[] { const t = this.t(); return this.beatsOf(kind).filter((b) => t >= b.at && t < b.end); }
  /** Duel results by beat id, for bot lines that announce them. */
  private readonly duelResults = computed(() => new Map(this.duels().map((d) => [d.beat.id, duelOutcome(d.battle, { left: this.str(d.beat, 'left'), right: this.str(d.beat, 'right') })])));
  /** Captions hold until the next one in their place (or a card) replaces them; see captionSpans. */
  private readonly spans = computed(() => captionSpans(this.scene(), this.format()).filter((c) => c.end > c.beat.at));
  readonly captions = computed(() => {
    const t = this.t();
    const spans = this.spans();
    return spans
      .map((c) => ({
        ...c,
        // Caption to caption is a cut inside the same band: the band stays, only the words change.
        swap: spans.some((o) => o !== c && o.place === c.place && o.end === c.beat.at),
        cut: spans.some((o) => o !== c && o.place === c.place && o.beat.at === c.end)
      }))
      // A caption replaced by a card keeps fading under it for a moment.
      .filter((c) => t >= c.beat.at && t < (c.cut ? c.end : c.end + CAPTION_FADE_MS))
      .map((c) => ({ ...c, exit: !c.cut && Number.isFinite(c.end) ? c.end - c.beat.at : 1e9, words: words(String(c.beat.props['text'])) }));
  });
  /** Landscape captions take the band under the stream, so the channel row fades out when the first one arrives. */
  readonly infoCoveredAt = computed(() => {
    if (this.format() !== 'landscape') return null;
    const starts = this.spans().filter((c) => c.place === 'bottom').map((c) => c.beat.at);
    return starts.length ? Math.min(...starts) : null;
  });
  /** The closing card stays to the last frame (a video shouldn't end by flashing the stream again). */
  readonly cards = computed(() => { const t = this.t(); return [...this.active('intro'), ...this.beatsOf('outro').filter((b) => t >= b.at)]; });
  readonly cardExitMs = CARD_EXIT_MS;
  /** How long a deleted message takes to change into its "message deleted" wording (see .ln__roll). */
  readonly rollMs = 320;

  /** Camera moves over the scene: shots from the director, the hand-over from/to the cards, and ban kicks. */
  private readonly cameraKeys = computed(() => {
    const scene = this.scene(), views = VIEWS[this.format()];
    if (scene.director === 'off') return null;
    const keys: { at: number; to?: Vec3; kick?: boolean }[] = directorShots(scene).map((s) => ({ at: s.at, to: pose(views[s.focus]) }));
    const intro = scene.beats.find((b) => b.do === 'intro' && b.at === 0);
    if (intro) keys.push({ at: Math.max(0, intro.end - CARD_EXIT_MS), to: pose(views.wide) });
    for (const b of scene.beats) {
      if (b.do === 'outro') keys.push({ at: b.at, to: pose(views.settle) });
      if (b.do === 'ban') keys.push({ at: b.at, kick: true });
    }
    return { start: pose(intro ? views.settle : views.wide), keys: keys.sort((a, b) => a.at - b.at) };
  });
  /** The picture's transform at t: every move is a spring that carries its speed into the next one. */
  readonly world = computed(() => {
    const camera = this.cameraKeys(), t = this.t();
    if (!camera) return null;
    const { width, height } = this.size();
    let x = [...camera.start] as Vec3, v: Vec3 = [0, 0, 0], target = camera.start, at = 0;
    const advance = (until: number) => {
      const dt = Math.max(0, until - at) / 1000;
      for (let i = 0; i < 3; i++) [x[i], v[i]] = spring(x[i], v[i], target[i], dt);
      at = Math.max(at, until);
    };
    for (const key of camera.keys) {
      if (key.at > t) break;
      advance(key.at);
      if (key.to) target = key.to;
      // A kick pushes in around the middle of the frame.
      if (key.kick) { v[0] += KICK; v[1] -= KICK * (width / 2); v[2] -= KICK * (height / 2); }
    }
    advance(t);
    return `translate(${x[1].toFixed(3)}px, ${x[2].toFixed(3)}px) scale(${x[0].toFixed(5)})`;
  });
  readonly ringTargets = computed(() => this.active('highlight').filter((b) => b.props['target'] === 'chat' || b.props['target'] === 'stream'));

  /** Script beats and background chat in one time order (script first at the same ms). */
  private readonly chatTimeline = computed(() => {
    const scene = this.scene();
    const entries: { at: number; order: number; beat?: DemoBeat; crowd?: DemoAmbientLine }[] = [
      ...scene.beats.map((beat) => ({ at: beat.at, order: beat.index, beat })),
      ...scene.ambient.map((crowd, i) => ({ at: crowd.at, order: 1e6 + i, crowd }))
    ];
    return entries.sort((a, b) => a.at - b.at || a.order - b.order);
  });

  readonly lines = computed<ChatLine[]>(() => {
    const t = this.t(), scene = this.scene(), copy = this.copy();
    const byId = new Map<string, ChatLine>(), lines: ChatLine[] = [];
    const base = { crowd: false, first: false, icon: null, deletedAt: null, highlight: null };
    for (const entry of this.chatTimeline()) {
      if (entry.at > t) break;
      if (entry.crowd) {
        const c = entry.crowd;
        lines.push({ ...base, key: c.key, kind: 'viewer', at: c.at, user: c.user, text: c.text, color: nameColor(c.user, scene.look), crowd: true,
          badges: c.sub ? [BADGE_ICONS['sub'][0]] : [], badgeTones: c.sub ? [BADGE_ICONS['sub'][1]] : [] });
        continue;
      }
      const beat = entry.beat!, p = beat.props;
      if (beat.do === 'chat' || beat.do === 'bot') {
        const bot = beat.do === 'bot';
        const badges = (bot ? ['bot'] : ((p['badges'] as string[]) ?? [])).filter((b) => BADGE_ICONS[b]);
        const user = bot ? scene.bot : String(p['user']);
        const result = bot && typeof p['duel'] === 'string' ? this.duelResults().get(p['duel']) : undefined;
        const text = result ? String(p['text']).replaceAll('{winner}', result.winner).replaceAll('{loser}', result.loser).replaceAll('{hp}', String(result.hp)) : String(p['text']);
        const line: ChatLine = {
          ...base, key: beat.id, kind: bot ? 'bot' : 'viewer', at: beat.at, user, text,
          color: bot ? BOT_COLOR[scene.look] : typeof p['color'] === 'string' ? p['color'] : nameColor(user, scene.look),
          badges: badges.map((b) => BADGE_ICONS[b][0]), badgeTones: badges.map((b) => BADGE_ICONS[b][1]), first: p['first'] === true
        };
        byId.set(beat.id, line);
        lines.push(line);
      } else if (beat.do === 'event') {
        lines.push({ ...base, key: beat.id, kind: 'event', at: beat.at, user: '', text: String(p['text']), color: '', badges: [], badgeTones: [],
          icon: EVENT_ICONS[(p['icon'] as string) ?? 'info'] ?? Info });
      } else if (beat.do === 'delete') {
        const target = byId.get(String(p['target']));
        if (target && target.deletedAt === null) target.deletedAt = beat.at;
      } else if (beat.do === 'ban') {
        const target = byId.get(String(p['target']));
        if (!target) continue;
        for (const line of lines) if (line.kind === 'viewer' && line.user === target.user && line.deletedAt === null) line.deletedAt = beat.at;
        const notice = typeof p['notice'] === 'string' && p['notice'] ? p['notice'] : copy.banned.replace('{user}', target.user);
        lines.push({ ...base, key: beat.id, kind: 'notice', at: beat.at, user: '', text: notice, color: '', badges: [], badgeTones: [] });
      } else if (beat.do === 'highlight') {
        const target = byId.get(String(p['target']));
        if (target) target.highlight = { at: beat.at, end: beat.end, label: String(p['label'] ?? '') };
      }
    }
    for (const line of lines) if (line.highlight && t >= line.highlight.end) line.highlight = null;
    return lines.slice(-MAX_LINES);
  });

  /** TTS cards go through the real renderer with a TTS widget, like an OBS source that doesn't own the audio. */
  private readonly ttsWidget: OverlayWidget = { id: 'demo-tts', kind: 'tts', x: TTS_BOX.x, y: TTS_BOX.y, width: TTS_BOX.width, height: TTS_BOX.height, visible: true, locked: false, showTtsText: true };
  readonly ttsScene: Snapshot = { width: STAGE.width, height: STAGE.height, widgets: [this.ttsWidget], designs: [], waitFor: ['tts'] };
  readonly stageViewport = { width: STAGE.width, height: STAGE.height };
  readonly ttsJobs = computed<OverlayRenderJob[]>(() =>
    this.active('tts').filter((beat) => beat.props['showText'] !== false).map((beat) => ({
      event: { id: 5000 + beat.index, kind: 'tts', text: `${beat.props['user']}: ${beat.props['text']}`, tts: { speechID: beat.id, ownerClientId: null, durationMs: beat.end - beat.at } },
      widgets: [{ ...this.ttsWidget, showTtsText: true }], snapshot: this.ttsScene, playbackKey: 5000 + beat.index
    }))
  );

  readonly streamScale = computed(() => this.streamBox().width / STAGE.width);
  readonly streamBox = computed<Rect>(() => (this.format() === 'vertical' ? { x: 0, y: 150, width: 540, height: 304 } : { x: 16, y: 16, width: 656, height: 369 }));

  /** Camera: zooms the stream toward an actor, easing between camera beats. */
  readonly camera = computed(() => {
    const t = this.t();
    const view = (focus: string, zoom: number) => {
      const r = FOCUS[focus] ?? FOCUS['full'];
      const k = Math.min(zoom, Math.max(1, Math.min(STAGE.width / r.width, STAGE.height / r.height)));
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return {
        k,
        x: Math.min(0, Math.max(STAGE.width - STAGE.width * k, STAGE.width / 2 - k * cx)),
        y: Math.min(0, Math.max(STAGE.height - STAGE.height * k, STAGE.height / 2 - k * cy))
      };
    };
    let current = { k: 1, x: 0, y: 0 };
    for (const beat of this.beatsOf('camera')) {
      if (beat.at > t) break;
      const target = view(String(beat.props['focus']), typeof beat.props['zoom'] === 'number' ? beat.props['zoom'] : 2.2);
      const span = Math.max(1, beat.end - beat.at), p = ease(Math.min(1, (t - beat.at) / span));
      current = { k: current.k + (target.k - current.k) * p, x: current.x + (target.x - current.x) * p, y: current.y + (target.y - current.y) * p };
    }
    return `translate(${current.x}px, ${current.y}px) scale(${current.k})`;
  });

  str(beat: DemoBeat, key: string): string { const v = beat.props[key]; return typeof v === 'string' ? v : ''; }
  duelElapsed(beat: DemoBeat, duration: number): number { return Math.max(0, Math.min(duration, this.t() - beat.at)); }
  shown(beat: DemoBeat): boolean { return this.t() >= beat.at && this.t() < beat.end; }
  /** Fully opaque 0..1 progress of a beat. */
  progress(beat: DemoBeat): number { return Math.min(1, Math.max(0, (this.t() - beat.at) / Math.max(1, beat.end - beat.at))); }

  private rouletteFor(beat: DemoBeat) {
    const p = beat.props, items = (p['items'] as string[]) ?? [];
    const ids = items.map((_, i) => `p${i + 1}`);
    const roulette: Roulette = {
      id: `demo-${beat.id}`, alias: 'demo', name: String(p['title'] ?? ''), design: 'wheel', cardSize: 'medium', colors: PRIZE_COLORS,
      durationSeconds: ((p['spin'] as number) ?? DEFAULT_ROULETTE_SPIN_MS) / 1000,
      items: ids.map((id, i) => ({ id, label: items[i], multiplier: 1, weight: 1, copies: [`${id}-1`] })),
      order: ids.map((id) => `${id}-1`),
      settings: { insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: 'keep' }
    } as Roulette;
    const slots = slotsFor(roulette);
    const pick = typeof p['winner'] === 'number' ? p['winner'] : Math.floor(seededRandom(beatSeed(this.scene().seed, beat.index))() * items.length);
    const winner = slots.find((s) => s.itemId === ids[pick]) ?? slots[0];
    const spin = (p['spin'] as number) ?? DEFAULT_ROULETTE_SPIN_MS;
    const draw: RouletteDraw = {
      id: `demo-${beat.id}`, rouletteId: roulette.id, startedAt: DRAW_EPOCH, endsAt: DRAW_EPOCH + spin, completedAt: null,
      winner, slots, design: 'wheel', cardSize: 'medium', colors: PRIZE_COLORS
    } as RouletteDraw;
    return { beat, roulette, draw, spinAt: beat.at + ROULETTE_LEAD_MS };
  }
  /** The spin starts after a short wait; the overlay's own progress follows serverTime, which follows t. */
  rouletteDraw(r: { draw: RouletteDraw; spinAt: number }): RouletteDraw | null { return this.t() >= r.spinAt ? r.draw : null; }
  rouletteTime(r: { spinAt: number }): number { return DRAW_EPOCH + Math.max(0, this.t() - r.spinAt); }
}
