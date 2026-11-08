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
import { demoBattle, DUEL_TAIL_MS } from './demo-duel';
import {
  DEFAULT_ROULETTE_SPIN_MS, DEMO_FORMATS, ROULETTE_LEAD_MS, STAGE, beatSeed, seededRandom,
  type DemoBeat, type DemoFormat, type DemoScene
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
const NAME_COLORS = ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff9b', '#c79bff', '#ff9f6b', '#6bd7c2', '#a3b4ff'];
const DRAW_EPOCH = 1_700_000_000_000;

const COPY = {
  en: { chat: 'Stream chat', first: 'First message', deleted: '<message deleted>', banned: '{user} has been permanently banned.', live: 'LIVE', tagline: 'A Twitch chatbot that grows with you', cta: 'Free to start', companion: 'Stream Companion' },
  es: { chat: 'Chat del stream', first: 'Primer mensaje', deleted: '<mensaje eliminado>', banned: '{user} fue baneado permanentemente.', live: 'EN VIVO', tagline: 'Un chatbot de Twitch que crece contigo', cta: 'Empieza gratis', companion: 'Stream Companion' }
} as const;

export interface ChatLine {
  key: string; kind: 'viewer' | 'bot' | 'event' | 'notice'; at: number;
  user: string; text: string; color: string; badges: LucideIconData[]; badgeTones: string[]; first: boolean;
  icon: LucideIconData | null; deletedAt: number | null;
  highlight: { at: number; end: number; label: string } | null;
}
interface Segment { text: string; em: boolean }

const BADGE_ICONS: Record<string, [LucideIconData, string]> = {
  broadcaster: [Video, 'red'], mod: [Sword, 'green'], vip: [Gem, 'pink'], sub: [Star, 'violet'], verified: [BadgeCheck, 'violet'], bot: [Bot, 'bot']
};
const EVENT_ICONS: Record<string, LucideIconData> = { follow: Heart, sub: Star, bits: Gem, raid: Users, shield: ShieldCheck, info: Info };

/** `*word*` marks the words a caption colors. */
export function segments(text: string): Segment[] {
  return text.split(/(\*[^*]+\*)/).filter(Boolean).map((part) => (part.startsWith('*') && part.endsWith('*') && part.length > 2 ? { text: part.slice(1, -1), em: true } : { text: part, em: false }));
}
function nameColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * One video frame: a fake stream with the real overlay components on it, a Twitch-style chat, captions and brand
 * cards. Everything on screen is a function of the scene and `t` (ms), so any t renders the same frame.
 */
@Component({
  selector: 'app-demo-frame',
  imports: [LucideAngularModule, DemoClockDirective, DemoAlertComponent, DuelStageComponent, RouletteDisplayComponent, OverlaySceneRendererComponent],
  templateUrl: './demo-frame.component.html',
  styleUrl: './demo-frame.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-format]': 'format()', '[style.width.px]': 'size().width', '[style.height.px]': 'size().height' }
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
  /** A caption that starts where another is still showing replaces it: the older one fades out just before. */
  readonly captions = computed(() => {
    const t = this.t(), fallback = this.format() === 'vertical' ? 'top' : 'bottom';
    const all = this.beatsOf('caption').map((beat) => ({ beat, place: (beat.props['place'] as string) ?? fallback }));
    return all
      .map((c) => {
        const next = all.find((o) => o.place === c.place && o.beat.at > c.beat.at && o.beat.at < c.beat.end);
        const end = next ? next.beat.at : c.beat.end;
        return { ...c, end, exit: Math.max(0, end - c.beat.at - 300), parts: segments(String(c.beat.props['text'])) };
      })
      .filter((c) => t >= c.beat.at && t < c.end);
  });
  readonly cards = computed(() => [...this.active('intro'), ...this.active('outro')]);
  readonly ringTargets = computed(() => this.active('highlight').filter((b) => b.props['target'] === 'chat' || b.props['target'] === 'stream'));

  readonly lines = computed<ChatLine[]>(() => {
    const t = this.t(), scene = this.scene(), copy = this.copy();
    const byId = new Map<string, ChatLine>(), lines: ChatLine[] = [];
    const ordered = [...scene.beats].sort((a, b) => a.at - b.at || a.index - b.index);
    for (const beat of ordered) {
      if (beat.at > t) break;
      const p = beat.props;
      if (beat.do === 'chat' || beat.do === 'bot') {
        const bot = beat.do === 'bot';
        const badges = (bot ? ['bot'] : ((p['badges'] as string[]) ?? [])).filter((b) => BADGE_ICONS[b]);
        const user = bot ? scene.bot : String(p['user']);
        const line: ChatLine = {
          key: beat.id, kind: bot ? 'bot' : 'viewer', at: beat.at, user, text: String(p['text']),
          color: bot ? '#c4b5fd' : typeof p['color'] === 'string' ? p['color'] : nameColor(user),
          badges: badges.map((b) => BADGE_ICONS[b][0]), badgeTones: badges.map((b) => BADGE_ICONS[b][1]),
          first: p['first'] === true, icon: null, deletedAt: null, highlight: null
        };
        byId.set(beat.id, line);
        lines.push(line);
      } else if (beat.do === 'event') {
        lines.push({ key: beat.id, kind: 'event', at: beat.at, user: '', text: String(p['text']), color: '', badges: [], badgeTones: [], first: false,
          icon: EVENT_ICONS[(p['icon'] as string) ?? 'info'] ?? Info, deletedAt: null, highlight: null });
      } else if (beat.do === 'delete') {
        const target = byId.get(String(p['target']));
        if (target && target.deletedAt === null) target.deletedAt = beat.at;
      } else if (beat.do === 'ban') {
        const target = byId.get(String(p['target']));
        if (!target) continue;
        for (const line of lines) if (line.kind === 'viewer' && line.user === target.user && line.deletedAt === null) line.deletedAt = beat.at;
        const notice = typeof p['notice'] === 'string' && p['notice'] ? p['notice'] : copy.banned.replace('{user}', target.user);
        lines.push({ key: beat.id, kind: 'notice', at: beat.at, user: '', text: notice, color: '', badges: [], badgeTones: [], first: false, icon: null, deletedAt: null, highlight: null });
      } else if (beat.do === 'highlight') {
        const target = byId.get(String(p['target']));
        if (target) target.highlight = { at: beat.at, end: beat.end, label: String(p['label'] ?? '') };
      }
    }
    for (const line of lines) if (line.highlight && t >= line.highlight.end) line.highlight = null;
    return lines.slice(-24);
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
