import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { Gem, Gift, Heart, LucideAngularModule, Play, Rocket, Square, Star, type LucideIconData } from 'lucide-angular';

import { OverlaySceneRendererComponent } from '../../../overlays/overlay-scene-renderer.component';
import type { OverlayRenderJob, OverlayPlaybackId } from '../../../overlays/overlay-playback';
import type { Snapshot } from '../../../overlays/overlay-api.service';
import type { AlertEvent, OverlayWidget } from '../../../overlays/overlay.model';
import { LIBRARY_URLS } from '../../../overlays/overlay-library';
import {
  DEFAULT_ALERT_COPY, DEFAULT_ALERT_DURATION, DEFAULT_ALERT_KINDS, defaultAlertLayout, makeDefaultDesign,
  type DefaultAlertKind, type DefaultAlertLanguage
} from './default-alerts.design';

type Scene = 'dark' | 'bright';
const DESIGN_ID = 'dima-defaults';
/** The box every new overlay already has (the current starter scene): centred, 640×192. */
const BOX: OverlayWidget = { id: 'alert-1', kind: 'alert', x: 640, y: 450, width: 640, height: 192, visible: true, locked: false, designId: DESIGN_ID, events: ['sub', 'bits', 'follow', 'raid'] };
const EVENT: Record<DefaultAlertKind, AlertEvent> = { follow: 'follow', bits: 'bits', sub: 'sub', gift: 'sub', raid: 'raid' };

interface AlertInfo { kind: DefaultAlertKind; icon: LucideIconData; label: string; sound: string; note: string }
const INFO: AlertInfo[] = [
  { kind: 'follow', icon: Heart, label: 'Follow', sound: 'Two-note bell bloom, the softest one (follows are the most frequent).', note: 'Heart badge with a heartbeat, violet.' },
  { kind: 'bits', icon: Gem, label: 'Bits', sound: 'Crystal cascade: five quick gem plucks rising, one clear ping.', note: 'Gem badge, cyan. The amount sits in the stat box.' },
  { kind: 'sub', icon: Star, label: 'Sub', sound: 'Warm fanfare: soft boom, a pad chord and a rising bell line.', note: 'Star badge, gold like Premium, extra twinkles on the card.' },
  { kind: 'gift', icon: Gift, label: 'Gifted subs', sound: 'Ribbon swish, a little pop, a music-box run, then a warm chord.', note: 'Gift box that shakes, confetti, number of subs gifted.' },
  { kind: 'raid', icon: Rocket, label: 'Raid', sound: 'Three soft drum hits, a whoosh and a brass swell that lands on a bright chord.', note: 'Rocket, live red, speed lines, the raid’s viewer count.' }
];

/**
 * Proposal for the default alerts (follow, Bits, sub, gifted subs, raid). Plays them through the real
 * Overlay Studio renderer (the same component OBS runs), with their sounds, over a sample stream.
 */
@Component({
  selector: 'app-default-alerts-mock',
  imports: [OverlaySceneRendererComponent, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './default-alerts-mock.component.html',
  styleUrl: './default-alerts-mock.component.css'
})
export class DefaultAlertsMockComponent {
  readonly info = INFO;
  readonly playIcon = Play; readonly stopIcon = Square;
  readonly language = signal<DefaultAlertLanguage>('en');
  readonly scene = signal<Scene>('dark');
  readonly name = signal('LunaPlays');
  readonly bits = signal(500); readonly viewers = signal(42); readonly gifts = signal(5);
  readonly playing = signal<DefaultAlertKind | null>(null);
  readonly jobs = signal<readonly OverlayRenderJob[]>([]);
  readonly sequence = signal(false);
  readonly copy = computed(() => DEFAULT_ALERT_COPY[this.language()]);
  readonly duration = DEFAULT_ALERT_DURATION;
  private readonly snapshot: Snapshot = { width: 1920, height: 1080, widgets: [BOX], waitFor: [], designs: [makeDefaultDesign(DESIGN_ID, 'Dima defaults', 'en')] };
  readonly stage = this.snapshot;
  private counter = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: DefaultAlertKind[] = [];

  constructor() {
    const browser = isPlatformBrowser(inject(PLATFORM_ID));
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    // Warm the browser cache so the first play does not wait on the network (OBS preloads the same way).
    if (browser) for (const url of LIBRARY_URLS) void fetch(url).catch(() => {});
  }

  /** What the server would print for this sample event. */
  private render(template: string): string {
    const values: Record<string, string> = { user: this.name().trim() || 'Viewer', 'raid.channel': this.name().trim() || 'Viewer', 'cheer.amount': String(this.bits()), 'raid.viewers': String(this.viewers()), 'gift.count': String(this.gifts()) };
    return template.replace(/\$\(([a-z.]+)\)/g, (match, key: string) => values[key] ?? match);
  }

  play(kind: DefaultAlertKind, chained = false): void {
    if (!chained) { this.sequence.set(false); this.queue = []; }
    clearTimeout(this.timer);
    const id: OverlayPlaybackId = `${kind}-${++this.counter}`;
    const layout = defaultAlertLayout(kind, this.language(), template => this.render(template));
    this.playing.set(kind);
    this.jobs.set([{ event: { id, kind: EVENT[kind], layouts: { [DESIGN_ID]: layout } }, widgets: [BOX], snapshot: this.snapshot, playbackKey: id }]);
  }

  /** The renderer shows an alert once its pictures are decoded; its clock starts here, like in OBS. */
  ready(id: OverlayPlaybackId): void {
    const job = this.jobs().find(j => j.event.id === id); if (!job) return;
    const kind = String(id).split('-')[0] as DefaultAlertKind;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.jobs.set([]); this.playing.set(null);
      const next = this.queue.shift();
      if (next) this.timer = setTimeout(() => this.play(next, true), 700); else this.sequence.set(false);
    }, DEFAULT_ALERT_DURATION[kind] * 1000 + 150);
  }

  playAll(): void {
    if (this.sequence()) { this.stop(); return; }
    this.sequence.set(true); this.queue = DEFAULT_ALERT_KINDS.slice(1);
    this.play(DEFAULT_ALERT_KINDS[0], true);
  }

  stop(): void { clearTimeout(this.timer); this.queue = []; this.sequence.set(false); this.jobs.set([]); this.playing.set(null); }

  number(event: Event, target: 'bits' | 'viewers' | 'gifts'): void {
    const value = Math.max(1, Math.min(1_000_000, Math.round(Number((event.target as HTMLInputElement).value) || 1)));
    this[target].set(value);
  }
  setName(event: Event): void { this.name.set((event.target as HTMLInputElement).value.slice(0, 25)); }
}
