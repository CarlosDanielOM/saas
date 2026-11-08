import { isPlatformBrowser } from '@angular/common';
import {
  ApplicationRef, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, PLATFORM_ID, afterNextRender, computed, inject, signal
} from '@angular/core';
import { LucideAngularModule, Pause, Play, RotateCcw } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { DemoFrameComponent } from './demo-frame.component';
import { demoDuelDuration } from './demo-duel';
import { DEMO_SAMPLES } from './demo-samples';
import {
  DEMO_ACTOR_NAMES, DEMO_CONTRACT_VERSION, DEMO_FORMATS, DEMO_LANGS, DEMO_LOOKS, normalizeScene, sceneCues,
  type DemoFormat, type DemoLang, type DemoLook, type DemoScene
} from './demo-scene';

/** What the recorder may pass to `load()` besides the scene. */
interface LoadOptions { format: DemoFormat; lang: DemoLang; look?: DemoLook; media?: { tts?: Record<string, { src: string; durationMs: number }> } }
type LoadResult =
  | { ok: true; durationMs: number; posterMs: number; fps: number; beats: { id: string; do: string; at: number; end: number }[]; cues: ReturnType<typeof sceneCues> }
  | { ok: false; errors: string[] };

export interface DemoPlayerApi {
  version: number;
  actors: readonly string[];
  bootReady: boolean;
  load(scene: unknown, options: LoadOptions): LoadResult;
  ready(): Promise<{ ok: boolean; problems: string[] }>;
  frame(t: number): Promise<{ waiting: number; running: string[] }>;
}

/** Real timers the recorder saves before it fakes the page clock (the frame settle needs real rendering turns). */
interface NativeTimers { requestAnimationFrame: typeof requestAnimationFrame; setTimeout: typeof setTimeout }
declare global { interface Window { __dimaDemo?: DemoPlayerApi; __demoNative?: NativeTimers } }

const LOOK_NAMES: Record<DemoLook, Record<DemoLang, string>> = {
  studio: { en: 'Original', es: 'Original' }, site: { en: 'Website', es: 'Sitio web' }, paper: { en: 'Print', es: 'Impreso' },
  signal: { en: 'Kinetic', es: 'Cinético' }, broadcast: { en: 'Broadcast', es: 'Transmisión' }, night: { en: 'Night', es: 'Noche' }
};

const COPY = {
  en: { title: 'Demo video player', look: 'Look', lead: 'Promo videos are recorded from this frame, one frame at a time. This preview plays the built-in sample.', sample: 'Sample', format: 'Format', vertical: 'Vertical', landscape: 'Landscape', language: 'Language', play: 'Play', pause: 'Pause', restart: 'Restart', time: 'Position', invalid: 'This sample has problems:' },
  es: { title: 'Reproductor de videos demo', look: 'Estilo', lead: 'Los videos promocionales se graban desde este cuadro, una imagen a la vez. Esta vista previa reproduce el ejemplo incluido.', sample: 'Ejemplo', format: 'Formato', vertical: 'Vertical', landscape: 'Horizontal', language: 'Idioma', play: 'Reproducir', pause: 'Pausar', restart: 'Reiniciar', time: 'Posición', invalid: 'Este ejemplo tiene problemas:' }
} as const;

const FONT_FACES = [
  '700 40px "Playfair Display"', '400 14px "Playfair Display"', '700 30px "Space Grotesk"',
  '400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Bricolage Grotesque"', '600 16px "Bricolage Grotesque"',
  '400 40px "Anton"', '800 40px "Archivo"', '400 13px "JetBrains Mono"', '600 13px "JetBrains Mono"', '400 16px "Inter Tight"', '600 16px "Inter Tight"', '700 16px "Inter Tight"', '800 16px "Inter Tight"',
  '400 16px "Plus Jakarta Sans"', '700 16px "Plus Jakarta Sans"', '800 16px "Plus Jakarta Sans"'
];

/** Google Fonts splits accents and symbols into separate files that load lazily; ask for them up front. */
const FONT_SAMPLE = 'AaBb09 ÁáÉéÍíÓóÚúÑñÜü¿¡…·×—–“”‘’@#&%$!?';

/**
 * /mocks/dev/demo: plays a demo-video scene through the real product components.
 * In a browser it previews the built-in sample; the recorder (marketing/video) drives it through window.__dimaDemo.
 * Scenes never come from the URL, so nobody can make domdimabot.com show arbitrary text.
 */
@Component({
  selector: 'app-demo-player',
  imports: [DemoFrameComponent, LucideAngularModule],
  templateUrl: './demo-player.component.html',
  styleUrl: './demo-player.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.dp--record]': 'recording()' }
})
export class DemoPlayerComponent {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly appRef = inject(ApplicationRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly icons = { play: Play, pause: Pause, restart: RotateCcw };
  readonly samples = DEMO_SAMPLES;
  readonly langs = DEMO_LANGS;
  readonly formats = Object.keys(DEMO_FORMATS) as DemoFormat[];
  readonly looks = DEMO_LOOKS;
  readonly lookNames = LOOK_NAMES;
  /** Preview-only look override (the recorder passes its own in load()). */
  readonly look = signal<DemoLook | null>(null);

  readonly lang = signal<DemoLang>(inject(LanguageService).currentLanguage() === 'es' ? 'es' : 'en');
  readonly format = signal<DemoFormat>('vertical');
  readonly sampleId = signal(DEMO_SAMPLES[0].id);
  readonly recording = signal(false);
  readonly playing = signal(false);
  readonly t = signal(0);
  /** Bumped by every load(): remounts the frame. */
  readonly loads = signal(0);
  readonly copy = computed(() => COPY[this.lang()]);

  private readonly recorded = signal<DemoScene | null>(null);
  private readonly sample = computed(() => {
    const sample = DEMO_SAMPLES.find((s) => s.id === this.sampleId()) ?? DEMO_SAMPLES[0];
    const result = normalizeScene(sample.scene, this.lang(), { duel: demoDuelDuration });
    const look = this.look();
    return look && result.scene ? { ...result, scene: { ...result.scene, look } } : result;
  });
  readonly sampleErrors = computed(() => this.sample().errors);
  readonly scene = computed(() => this.recorded() ?? this.sample().scene);
  readonly duration = computed(() => this.scene()?.durationMs ?? 0);
  readonly timeLabel = computed(() => `${(this.t() / 1000).toFixed(1)} / ${(this.duration() / 1000).toFixed(1)} s`);

  /** Preview scale so the whole frame fits the screen. */
  private readonly room = signal({ width: 0, height: 0 });
  readonly fit = computed(() => {
    const size = DEMO_FORMATS[this.format()], room = this.room();
    if (!room.width || !room.height) return 1;
    return Math.min(1.6, room.width / size.width, room.height / size.height);
  });
  readonly frameSize = computed(() => DEMO_FORMATS[this.format()]);

  private readonly alertsReady = signal<ReadonlySet<string>>(new Set());
  private startedAt = 0;
  private loop = 0;

  constructor() {
    if (!this.browser) return;
    const destroy = inject(DestroyRef);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    afterNextRender(() => {
      const stage = this.host.querySelector<HTMLElement>('.dp-stage');
      if (stage) {
        const observer = new ResizeObserver(([entry]) => this.room.set({ width: entry.contentRect.width, height: entry.contentRect.height }));
        observer.observe(stage);
        destroy.onDestroy(() => observer.disconnect());
      }
      if (!this.recording()) {
        if (reduced) this.t.set(this.scene()?.posterMs ?? 0);
        else this.play();
      }
    });
    this.loadFont();
    window.__dimaDemo = this.api();
    destroy.onDestroy(() => {
      cancelAnimationFrame(this.loop);
      if (window.__dimaDemo?.version === DEMO_CONTRACT_VERSION) delete window.__dimaDemo;
    });
  }

  // ── Preview controls ──────────────────────────────────────────────
  play(): void {
    if (this.recording()) return;
    if (this.t() >= this.duration()) this.t.set(0);
    this.startedAt = performance.now() - this.t();
    this.playing.set(true);
    cancelAnimationFrame(this.loop);
    const tick = () => {
      if (!this.playing()) return;
      const t = performance.now() - this.startedAt;
      if (t >= this.duration()) { this.t.set(this.duration()); this.playing.set(false); return; }
      this.t.set(t);
      this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }
  pause(): void { this.playing.set(false); cancelAnimationFrame(this.loop); }
  toggle(): void { if (this.playing()) this.pause(); else this.play(); }
  restart(): void { this.pause(); this.t.set(0); this.play(); }
  scrub(event: Event): void { this.pause(); this.t.set(Number((event.target as HTMLInputElement).value)); }
  setFormat(format: DemoFormat): void { this.format.set(format); }
  setLook(look: DemoLook): void { this.look.set(look); }
  /** The look on screen: the override, else the scene's own. */
  readonly currentLook = computed(() => this.scene()?.look ?? 'studio');
  setLang(lang: DemoLang): void { const playing = this.playing(); this.pause(); this.lang.set(lang); this.t.set(Math.min(this.t(), this.duration())); if (playing) this.play(); }
  onAlertReady(id: string): void { this.alertsReady.update((ids) => new Set(ids).add(id)); }

  /** Playfair Display is only used by the brand cards, so it loads here rather than on every page. */
  private loadFont(): void {
    if (document.querySelector('link[data-demo-font]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wdth,wght@100..125,400..900&family=JetBrains+Mono:wght@400;600&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;600;700;800&family=Playfair+Display:wght@400;700&display=block';
    link.dataset['demoFont'] = '';
    document.head.appendChild(link);
  }

  // ── Recorder contract ─────────────────────────────────────────────
  private api(): DemoPlayerApi {
    const native = (): NativeTimers => window.__demoNative ?? { requestAnimationFrame: requestAnimationFrame.bind(window), setTimeout: setTimeout.bind(window) };
    const nextFrame = () => new Promise<void>((resolve) => native().requestAnimationFrame(() => resolve()));
    const sleep = (ms: number) => new Promise<void>((resolve) => native().setTimeout(resolve, ms));
    const running = () => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target;
      return `${a instanceof CSSAnimation ? a.animationName : a.id || 'animation'} on ${target instanceof Element ? target.tagName.toLowerCase() + (target.className && typeof target.className === 'string' ? '.' + target.className.split(' ')[0] : '') : '?'}`;
    });
    return {
      version: DEMO_CONTRACT_VERSION,
      actors: DEMO_ACTOR_NAMES,
      bootReady: true,
      load: (raw, options) => {
        if (!options || !(options.format in DEMO_FORMATS) || !DEMO_LANGS.includes(options.lang)) return { ok: false, errors: ['format must be vertical/landscape and lang en/es'] };
        if (options.look !== undefined && !DEMO_LOOKS.includes(options.look)) return { ok: false, errors: [`look must be one of: ${DEMO_LOOKS.join(', ')}`] };
        const tts = options.media?.tts ?? {};
        const durations = Object.fromEntries(Object.entries(tts).map(([id, clip]) => [id, clip.durationMs]));
        const normalized = normalizeScene(raw, options.lang, { tts: durations, duel: demoDuelDuration });
        if (!normalized.scene) return { ok: false, errors: normalized.errors };
        const scene: DemoScene = options.look ? { ...normalized.scene, look: options.look } : normalized.scene;
        this.pause();
        this.recording.set(true);
        this.format.set(options.format);
        this.lang.set(options.lang);
        this.alertsReady.set(new Set());
        this.recorded.set(scene);
        this.loads.update((n) => n + 1);
        this.t.set(0);
        document.documentElement.style.background = '#0d0b14';
        this.appRef.tick();
        return {
          ok: true, durationMs: scene.durationMs, posterMs: scene.posterMs, fps: scene.fps,
          beats: scene.beats.map((b) => ({ id: b.id, do: b.do, at: b.at, end: b.end })),
          cues: sceneCues(scene, Object.fromEntries(Object.entries(tts).map(([id, clip]) => [id, clip.src])))
        };
      },
      ready: async () => {
        const problems: string[] = [];
        await Promise.all(FONT_FACES.map((face) => document.fonts.load(face, FONT_SAMPLE).then((faces) => { if (!faces.length) problems.push(`font not loaded: ${face}`); }, () => problems.push(`font failed: ${face}`))));
        await document.fonts.ready;
        this.appRef.tick();
        await nextFrame();
        for (const img of Array.from(this.host.querySelectorAll('img'))) {
          try { await img.decode(); } catch { problems.push(`picture failed: ${img.getAttribute('src')}`); }
        }
        const alerts = this.scene()?.beats.filter((b) => b.do === 'alert').map((b) => b.id) ?? [];
        for (let waited = 0; alerts.some((id) => !this.alertsReady().has(id)); waited += 50) {
          if (waited > 10000) { problems.push(`alert not ready: ${alerts.filter((id) => !this.alertsReady().has(id)).join(', ')}`); break; }
          await sleep(50);
          this.appRef.tick();
        }
        return { ok: !problems.length, problems };
      },
      frame: async (t) => {
        this.t.set(t);
        // Render, let the browser lay out (ResizeObserver, image sizes), render what that changed, repeat once.
        this.appRef.tick();
        await nextFrame();
        this.appRef.tick();
        await nextFrame();
        // A glyph the preload missed starts a font download; never capture a frame with a fallback font.
        if (document.fonts.status !== 'loaded') { await document.fonts.ready; this.appRef.tick(); await nextFrame(); }
        let waiting = this.host.querySelectorAll('[data-waiting]').length;
        for (let waited = 0; waiting && waited < 3000; waited += 16) {
          await nextFrame();
          this.appRef.tick();
          waiting = this.host.querySelectorAll('[data-waiting]').length;
        }
        return { waiting, running: running() };
      }
    };
  }
}
