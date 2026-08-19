import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { RouterLink } from '@angular/router';

export type ClipOverlayVariant =
  | 'classic'
  | 'tile'
  | 'third'
  | 'cinema'
  | 'orbit'
  | 'pill'
  | 'hud'
  | 'slash';
export type ClipStageBg = 'checker' | 'green' | 'dark' | 'dim';
export type ClipPlayPhase = 'idle' | 'rest' | 'in' | 'out';

interface CurrentPanelStyle {
  backgroundColor: string;
  backdropFilter: string;
  border: string;
  color: string;
}

export interface ClipPlayPayload {
  clipID: string;
  duration: number;
  title: string;
  game: string;
  streamer: string;
  streamerLogin: string;
  profileImage: string;
  description: string;
  streamerColor: string;
}

interface OverlayVariantCard {
  id: ClipOverlayVariant;
  label: string;
  badge: string;
  note: string;
  premium: boolean;
}

const FIXTURES: Omit<ClipPlayPayload, 'clipID' | 'duration' | 'profileImage'>[] = [
  {
    title: 'Clutch on B site',
    game: 'VALORANT',
    streamer: 'UnoSitoPolar',
    streamerLogin: 'unositopolar',
    description: 'They really let me walk in like that?',
    streamerColor: '#FF4655'
  },
  {
    title: 'Just chatting late',
    game: 'Just Chatting',
    streamer: 'cdom201',
    streamerLogin: 'cdom201',
    description: 'New overlay test — ignore the screams',
    streamerColor: '#9146FF'
  },
  {
    title: 'Baron steal attempt',
    game: 'League of Legends',
    streamer: 'ElKenoZVT',
    streamerLogin: 'elkenozvt',
    description: 'I cannot believe that actually worked',
    streamerColor: '#C89B3C'
  },
  {
    title: 'Commission wip',
    game: 'Art',
    streamer: 'MisumiK',
    streamerLogin: 'misumik',
    description: 'Lineart pass before color, chat pick the palette',
    streamerColor: '#EC4899'
  },
  {
    title: 'Cover run-through',
    game: 'Music',
    streamer: 'AriaScarletVT',
    streamerLogin: 'ariascarletvt',
    description: 'First full take — no talking over this one',
    streamerColor: '#22D3EE'
  },
  {
    title: 'Speedrun PB hunt',
    game: 'Minecraft',
    streamer: 'OzbellVT',
    streamerLogin: 'ozbellvt',
    description: 'If I miss this village I am logging off',
    streamerColor: '#22C55E'
  },
  {
    title: 'Dark theme stress',
    game: 'Software and Game Development',
    streamer: 'nightmode',
    streamerLogin: 'nightmode',
    description: 'Near-black streamer color — current D1 fallback path',
    streamerColor: '#111111'
  }
];

@Component({
  selector: 'app-clip-overlay-playground',
  imports: [RouterLink],
  templateUrl: './clip-overlay-playground.component.html',
  styleUrl: './clip-overlay-playground.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipOverlayPlaygroundComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('vplayer');

  readonly variants: OverlayVariantCard[] = [
    {
      id: 'classic',
      label: 'Classic',
      badge: 'Free',
      premium: false,
      note: 'Current Design 1. Split slide, seam avatar, 1.5s ease in and out.'
    },
    {
      id: 'third',
      label: 'Third',
      badge: 'Free',
      premium: false,
      note: 'Broadcast lower-third. Video fades, bar slides up, then eases back down.'
    },
    {
      id: 'tile',
      label: 'Tile',
      badge: 'Premium',
      premium: true,
      note: 'Live First card. Video and info tile stagger in from opposite sides.'
    },
    {
      id: 'cinema',
      label: 'Cinema',
      badge: 'Premium',
      premium: true,
      note: 'Full-bleed clip. Scrim and meta rise after the picture fades up.'
    },
    {
      id: 'orbit',
      label: 'Orbit',
      badge: 'Premium',
      premium: true,
      note: 'Avatar-forward. Pulse ring scales in, then video and type follow.'
    },
    {
      id: 'pill',
      label: 'Pill',
      badge: 'Premium',
      premium: true,
      note: 'Floating capsule over full video. Capsule slides in after the picture.'
    },
    {
      id: 'hud',
      label: 'HUD',
      badge: 'Premium',
      premium: true,
      note: 'Corner chips only. Game, name, and title stagger in around the clip.'
    },
    {
      id: 'slash',
      label: 'Slash',
      badge: 'Premium',
      premium: true,
      note: 'Diagonal reveal. Video wipes open, type sits in the cut, avatar on the seam.'
    }
  ];

  readonly fixtures = FIXTURES;
  readonly stageOptions: ClipStageBg[] = ['checker', 'green', 'dark', 'dim'];
  readonly variant = signal<ClipOverlayVariant>('classic');
  readonly stageBg = signal<ClipStageBg>('checker');
  readonly hold = signal(false);
  readonly timeoutSeconds = signal(8);
  readonly selectedLogin = signal<string | 'random'>('random');
  readonly phase = signal<ClipPlayPhase>('idle');
  readonly clip = signal<ClipPlayPayload | null>(null);
  readonly scale = signal(1);
  readonly lastError = signal('');

  readonly activeVariant = computed(
    () => this.variants.find((item) => item.id === this.variant()) ?? this.variants[0]
  );

  readonly panelStyle = computed<CurrentPanelStyle>(() => {
    const payload = this.clip();
    if (!payload) {
      return {
        backgroundColor: 'transparent',
        backdropFilter: 'none',
        border: '0',
        color: '#fff'
      };
    }
    const rgb = hexToRgb(payload.streamerColor);
    if (rgb.r <= 40 && rgb.g <= 40 && rgb.b <= 40) {
      return {
        backgroundColor: 'rgba(204, 204, 204, 0.7)',
        backdropFilter: 'blur(10px)',
        border: '3px solid #000',
        color: '#fff'
      };
    }
    return {
      backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.7)`,
      backdropFilter: 'blur(10px)',
      color: '#000',
      border: `3px solid rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`
    };
  });

  readonly accent = computed(() => this.clip()?.streamerColor ?? '#8b5cf6');
  readonly motion = computed(() => motionFor(this.variant()));

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private enterFrame = 0;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => this.bindStageScale());

    this.destroyRef.onDestroy(() => {
      this.clearTimers();
      this.stopCanvas();
      this.resizeObserver?.disconnect();
    });
  }

  selectVariant(id: ClipOverlayVariant): void {
    this.resetStage();
    this.variant.set(id);
  }

  onFixtureChange(event: Event): void {
    this.selectedLogin.set((event.target as HTMLSelectElement).value);
  }

  setStage(bg: ClipStageBg): void {
    this.stageBg.set(bg);
  }

  updateTimeout(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.timeoutSeconds.set(Math.min(30, Math.max(3, value)));
  }

  toggleHold(): void {
    this.hold.update((value) => !value);
  }

  playTest(): void {
    this.lastError.set('');
    const source = this.pickFixture();
    const duration = this.timeoutSeconds();
    const payload: ClipPlayPayload = {
      ...source,
      clipID: `mock-${Date.now()}`,
      duration,
      profileImage: avatarDataUri(source.streamer, source.streamerColor)
    };

    this.clearTimers();
    this.clip.set(payload);
    this.phase.set('rest');

    queueMicrotask(() => this.attachAndPlay(duration));
  }

  resetStage(): void {
    this.clearTimers();
    this.phase.set('idle');
    this.stopCanvas();
    const video = this.videoRef()?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      video.load();
    }
  }

  private attachAndPlay(duration: number): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      this.lastError.set('Video element missing — replay the test.');
      return;
    }

    this.stopCanvas();
    video.srcObject = this.startCanvasClip(this.clip()!);
    video.muted = true;
    video.playsInline = true;
    void video.play().then(() => {
      this.armEnter(duration);
    }).catch((error: unknown) => {
      this.lastError.set(error instanceof Error ? error.message : 'Autoplay blocked');
      this.armEnter(duration);
    });
  }

  private armEnter(duration: number): void {
    const { enter, exit } = this.motion();
    cancelAnimationFrame(this.enterFrame);
    this.enterFrame = requestAnimationFrame(() => {
      this.enterFrame = requestAnimationFrame(() => {
        this.phase.set('in');
        if (this.hold()) return;
        const hideAt = Math.max(enter + 400, duration * 1000 - 500);
        this.hideTimer = setTimeout(() => this.phase.set('out'), hideAt);
        this.endTimer = setTimeout(() => this.resetStage(), hideAt + exit + 80);
      });
    });
  }

  private pickFixture() {
    const login = this.selectedLogin();
    if (login !== 'random') {
      return FIXTURES.find((item) => item.streamerLogin === login) ?? FIXTURES[0];
    }
    return FIXTURES[Math.floor(Math.random() * FIXTURES.length)];
  }

  private bindStageScale(): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = stage.clientWidth - 32;
      const height = stage.clientHeight - 32;
      const next = Math.min(width / 800, height / 225, 1);
      this.scale.set(Math.max(next, 0.28));
    };
    this.resizeObserver = new ResizeObserver(update);
    this.resizeObserver.observe(stage);
    update();
  }

  private startCanvasClip(payload: ClipPlayPayload): MediaStream {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas.captureStream(30);
    }

    const rgb = hexToRgb(payload.streamerColor);
    const draw = (stamp: number) => {
      const t = stamp / 1000;
      const gradient = ctx.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, `rgb(${rgb.r}, ${Math.max(rgb.g - 40, 0)}, ${rgb.b})`);
      gradient.addColorStop(1, '#14151a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 640, 360);

      ctx.save();
      ctx.translate(320 + Math.sin(t) * 24, 180 + Math.cos(t * 0.8) * 16);
      ctx.rotate(t * 0.2);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(-220, -70, 440, 140);
      ctx.restore();

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 292, 640, 68);
      ctx.fillStyle = '#fff';
      ctx.font = '700 22px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(payload.title, 20, 324);
      ctx.font = '500 14px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(`${payload.game} · mock clip`, 20, 346);

      this.raf = requestAnimationFrame(draw);
    };

    this.raf = requestAnimationFrame(draw);
    return canvas.captureStream(30);
  }

  private stopCanvas(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private clearTimers(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    cancelAnimationFrame(this.enterFrame);
    this.hideTimer = null;
    this.endTimer = null;
    this.enterFrame = 0;
  }
}

function motionFor(variant: ClipOverlayVariant): { enter: number; exit: number } {
  if (variant === 'classic') return { enter: 1500, exit: 1500 };
  if (variant === 'third' || variant === 'slash') return { enter: 1200, exit: 1100 };
  return { enter: 1100, exit: 1000 };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return { r: 145, g: 70, b: 255 };
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16)
  };
}

function avatarDataUri(name: string, color: string): string {
  const initials = name
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'CL';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="64" fill="${color}"/><text x="64" y="76" text-anchor="middle" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="44" font-weight="700" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
