import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { OverlaySceneRendererComponent } from '../overlays/overlay-scene-renderer.component';
import type { Snapshot } from '../overlays/overlay-api.service';
import type { AlertTransport } from '../overlays/overlay-sound.component';
import type { AlertMotion, OverlayWidget } from '../overlays/overlay.model';
import type { AlertKeyframes } from '../overlays/overlay-keyframes.model';
import { MOTION_PRESETS, presetSequence } from '../overlays/overlay-motion-presets';
import type { DemoBeat, DemoLang } from './demo-scene';

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

/** One alert design built from Overlay Studio layers and its real motion presets (no stand-in drawing). */
function demoLayers(kind: string): OverlayWidget[] {
  const accent = kind === 'bits' ? '#fbbf24' : kind === 'raid' ? '#f472b6' : '#8b5cf6';
  return [
    layer({ id: 'card', kind: 'shape', x: 20, y: 30, width: 760, height: 180, color: '#1a1430', borderColor: accent, borderWidth: 4, radius: 34,
      shadow: { color: accent + '99', blur: 34, x: 0, y: 0 }, keyframes: keyframes('hero-pop', 'breathe', 'pop-away') }),
    layer({ id: 'mark', kind: 'image', x: 44, y: 46, width: 148, height: 148, mediaUrl: '/assets/brand/mark-on-dark.png',
      keyframes: keyframes('twirl-in', 'float', 'fade-away') }),
    layer({ id: 'name', kind: 'text', x: 214, y: 54, width: 540, height: 78, text: '$(user)', fontSize: 58, fontWeight: 700, color: '#ffffff',
      textAlign: 'left', keyframes: keyframes('glide-right', null, 'fade-away') }),
    layer({ id: 'line', kind: 'text', x: 214, y: 132, width: 540, height: 54, text: '$(message)', fontSize: 34, fontWeight: 700, color: '#d8ccff',
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
  readonly ready = output<string>();

  readonly viewport = { width: ALERT_BOX.width, height: ALERT_BOX.height };
  readonly scene = computed<Snapshot>(() => ({
    width: ALERT_BOX.width, height: ALERT_BOX.height, widgets: demoLayers(String(this.beat().props['event'])), designs: [], waitFor: []
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
