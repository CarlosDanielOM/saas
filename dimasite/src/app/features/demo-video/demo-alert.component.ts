import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { OverlaySceneRendererComponent } from '../overlays/overlay-scene-renderer.component';
import type { Snapshot } from '../overlays/overlay-api.service';
import type { AlertTransport } from '../overlays/overlay-sound.component';
import type { AlertMotion, OverlayWidget } from '../overlays/overlay.model';
import type { AlertKeyframes } from '../overlays/overlay-keyframes.model';
import { MOTION_PRESETS, presetSequence } from '../overlays/overlay-motion-presets';
import type { DemoBeat, DemoLang, DemoLook } from './demo-scene';

/** Size of the alert design, and where the alert box sits on the 1920x1080 stream. */
export const ALERT_BOX = { x: 560, y: 70, width: 800, height: 240 };

const MESSAGES: Record<string, Record<DemoLang, string>> = {
  follow: { en: 'just followed!', es: '¡te empezó a seguir!' },
  sub: { en: 'subscribed for {n} months!', es: '¡se suscribió por {n} meses!' },
  bits: { en: 'cheered {n} Bits!', es: '¡mandó {n} Bits!' },
  raid: { en: 'is raiding with {n} viewers!', es: '¡llegó en raid con {n} viewers!' }
};

const motion: AlertMotion = { enter: 'none', exit: 'none', loop: 'none', delay: 0, enterDuration: 0.9, exitDuration: 0.7, loopDuration: 3 };
const keyframes = (enter: string, loop: string | null, exit: string): AlertKeyframes => {
  const seq = (id: string) => presetSequence(MOTION_PRESETS.find((p) => p.id === id)!);
  return { enter: seq(enter), ...(loop ? { loop: seq(loop) } : {}), exit: seq(exit) };
};
const layer = (w: Partial<OverlayWidget> & Pick<OverlayWidget, 'id' | 'kind' | 'x' | 'y' | 'width' | 'height'>): OverlayWidget =>
  ({ visible: true, locked: false, motion, ...w }) as OverlayWidget;

/** Colors of the sample alert design in each look (a streamer designs their own; these are plausible designs). */
const ALERT_STYLE: Record<DemoLook, { card: string; border: string; shadow: { color: string; blur: number; x: number; y: number }; name: string; line: string; mark: string; radius: number }> = {
  studio: { card: '#1a1430', border: '#8b5cf6', shadow: { color: '#8b5cf699', blur: 34, x: 0, y: 0 }, name: '#ffffff', line: '#d8ccff', mark: 'mark-on-dark', radius: 34 },
  paper: { card: '#fffdf8', border: '#1d1b17', shadow: { color: '#1d1b17', blur: 0, x: 12, y: 14 }, name: '#1d1b17', line: '#e0432b', mark: 'mark-on-light', radius: 10 },
  signal: { card: '#0b0b0b', border: '#c8ff2e', shadow: { color: '#c8ff2e55', blur: 0, x: 10, y: 10 }, name: '#f4f4ef', line: '#c8ff2e', mark: 'mark-on-dark', radius: 0 },
  broadcast: { card: '#18181b', border: '#a970ff', shadow: { color: '#00000099', blur: 30, x: 0, y: 14 }, name: '#efeff1', line: '#c9a8ff', mark: 'mark-on-dark', radius: 18 },
  site: { card: '#1a1626', border: '#8b5cf6', shadow: { color: '#00000088', blur: 30, x: 0, y: 12 }, name: '#f5f7fb', line: '#c4b5fd', mark: 'mark-on-dark', radius: 28 },
  night: { card: '#050507', border: '#a970ff', shadow: { color: '#a970ff66', blur: 40, x: 0, y: 0 }, name: '#f2f1f6', line: '#a970ff', mark: 'mark-on-dark', radius: 0 }
};

/** One alert design built from Overlay Studio layers and its real motion presets (no stand-in drawing). */
function demoLayers(kind: string, look: DemoLook): OverlayWidget[] {
  const style = ALERT_STYLE[look];
  const border = look === 'studio' ? (kind === 'bits' ? '#fbbf24' : kind === 'raid' ? '#f472b6' : style.border) : style.border;
  const shadow = look === 'studio' ? { ...style.shadow, color: border + '99' } : style.shadow;
  return [
    layer({ id: 'card', kind: 'shape', x: 20, y: 30, width: 760, height: 180, color: style.card, borderColor: border, borderWidth: 4, radius: style.radius,
      shadow, keyframes: keyframes('hero-pop', 'breathe', 'pop-away') }),
    layer({ id: 'mark', kind: 'image', x: 44, y: 46, width: 148, height: 148, mediaUrl: `/assets/brand/${style.mark}.png`,
      keyframes: keyframes('twirl-in', 'float', 'fade-away') }),
    layer({ id: 'name', kind: 'text', x: 214, y: 54, width: 540, height: 78, text: '$(user)', fontSize: 58, fontWeight: 700, color: style.name,
      textAlign: 'left', keyframes: keyframes('glide-right', null, 'fade-away') }),
    layer({ id: 'line', kind: 'text', x: 214, y: 132, width: 540, height: 54, text: '$(message)', fontSize: 34, fontWeight: 700, color: style.line,
      textAlign: 'left', keyframes: keyframes('rise', null, 'fade-away') })
  ];
}

/**
 * A designed alert played by the real Overlay Studio renderer in its timeline (design replay) mode: the same
 * layers and motion code OBS uses, seeked from scene time. It mounts with the scene (hidden) so its pictures are
 * decoded before it appears; `ready` fires once they are.
 */
@Component({
  selector: 'app-demo-alert',
  imports: [OverlaySceneRendererComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-self-clock': '', '[style.visibility]': "visible() ? null : 'hidden'", '[attr.data-demo-alert]': 'beat().id' },
  template: `<app-overlay-scene-renderer placement="design" [scene]="scene()" [viewport]="viewport" [texts]="texts()"
    [staticPlaybackKey]="epoch()" [staticDuration]="seconds()" [transport]="transport()" (ready)="ready.emit(beat().id)" />`,
  styles: `:host { position: absolute; display: block; pointer-events: none }`
})
export class DemoAlertComponent {
  readonly beat = input.required<DemoBeat>();
  readonly t = input.required<number>();
  readonly lang = input.required<DemoLang>();
  readonly look = input<DemoLook>('studio');
  readonly ready = output<string>();

  readonly viewport = { width: ALERT_BOX.width, height: ALERT_BOX.height };
  readonly scene = computed<Snapshot>(() => ({
    width: ALERT_BOX.width, height: ALERT_BOX.height, widgets: demoLayers(String(this.beat().props['event']), this.look()), designs: [], waitFor: []
  }));
  readonly epoch = computed(() => 1000 + this.beat().index);
  readonly seconds = computed(() => Math.max(0.5, (this.beat().end - this.beat().at) / 1000));
  readonly visible = computed(() => this.t() >= this.beat().at && this.t() < this.beat().end);
  readonly transport = computed<AlertTransport>(() => ({
    time: Math.min(this.seconds(), Math.max(0, (this.t() - this.beat().at) / 1000)), playing: false, seek: this.epoch()
  }));
  readonly texts = computed<Record<string, string>>(() => {
    const props = this.beat().props, kind = String(props['event']);
    const amount = typeof props['amount'] === 'number' ? props['amount'] : kind === 'raid' ? 42 : kind === 'bits' ? 500 : 3;
    const message = typeof props['message'] === 'string' && props['message'] ? props['message'] : MESSAGES[kind][this.lang()].replace('{n}', String(amount));
    return { '$(user)': String(props['user']), '$(message)': message };
  });
}
