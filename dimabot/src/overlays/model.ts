export const CLIP_DESIGN_VARIANTS = ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash'] as const;
export type ClipDesignVariant = typeof CLIP_DESIGN_VARIANTS[number];
export type AlertEvent = 'sub' | 'bits' | 'follow' | 'raid';
export type EventKind = 'tts' | 'trigger' | 'clip' | AlertEvent;
export type WidgetKind = 'tts' | 'trigger' | 'clip' | 'alert' | 'text' | 'image' | 'video' | 'animation' | 'shape';
export const ALERT_TRANSITIONS = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'bounce', 'flip', 'spin'] as const;
export const ALERT_LOOPS = ['none', 'pulse', 'float', 'sway', 'spin'] as const;
export interface AlertMotion {
  enter: typeof ALERT_TRANSITIONS[number]; exit: typeof ALERT_TRANSITIONS[number]; loop: typeof ALERT_LOOPS[number];
  delay: number; enterDuration: number; exitDuration: number; loopDuration: number;
}
export interface OverlayWidget {
  id: string; kind: WidgetKind; name?: string;
  x: number; y: number; width: number; height: number;
  visible: boolean; locked: boolean;
  motion?: AlertMotion;
  fontFamily?: 'sans' | 'serif' | 'mono'; fontWeight?: 400 | 700; italic?: boolean; textAlign?: 'left' | 'center' | 'right';
  shape?: 'rectangle' | 'ellipse'; borderColor?: string; borderWidth?: number; radius?: number; opacity?: number;
  shadow?: { color: string; blur: number; x: number; y: number };
  mediaUrl?: string; assetId?: string; color?: string; fontSize?: number;
  triggerIds?: string[]; clipDesign?: ClipDesignVariant; designId?: string; events?: AlertEvent[]; text?: string;
}
/** An omitted selection receives all triggers; an empty selection receives none. */
export const matchesTrigger = (widget: OverlayWidget, triggerId?: string): boolean => widget.triggerIds === undefined || !!triggerId && widget.triggerIds.includes(triggerId);
export interface AlertSound { assetId: string; name?: string; volume: number; delay: number; fadeIn: number; fadeOut: number }
export interface AlertLayout { duration: number; widgets: OverlayWidget[]; sound?: AlertSound }
export interface AlertVariant { id: string; name: string; enabled: boolean; tier?: '1000' | '2000' | '3000'; min?: number; max?: number; layout: AlertLayout }
export interface AlertDesign {
  id: string; name: string; revision: number; width: number; height: number;
  events: Record<AlertEvent, AlertLayout>;
  variants?: Partial<Record<AlertEvent, AlertVariant[]>>;
}
export interface OverlayScene {
  id: string; name: string; width: number; height: number;
  widgets: OverlayWidget[]; waitFor: EventKind[]; publicId: string; revision: number;
  published?: { width: number; height: number; widgets: OverlayWidget[]; waitFor: EventKind[]; designs: AlertDesign[] };
}
export const ALERT_EVENTS: AlertEvent[] = ['sub', 'bits', 'follow', 'raid'];
export const EVENT_KINDS: EventKind[] = ['tts', 'trigger', 'clip', ...ALERT_EVENTS];
export const STORAGE_KEY = 'domdimabot-overlay-editor-mock-v2';
export const clone = <T>(value: T): T => structuredClone(value);
export function makeDesign(id: string, name: string): AlertDesign {
  const layout = (event: AlertEvent): AlertLayout => ({ duration: 5, widgets: [
    { id: `${event}-art`, kind: 'animation', x: 50, y: 50, width: 120, height: 120, visible: true, locked: false },
    { id: `${event}-text`, kind: 'text', x: 190, y: 65, width: 530, height: 90, visible: true, locked: false, text: '$(user)' }
  ] });
  return { id, name, revision: 1, width: 800, height: 240,
    events: { sub: layout('sub'), bits: layout('bits'), follow: layout('follow'), raid: layout('raid') } };
}
export function makeScene(id: string, name: string, designId: string): OverlayScene {
  return { id, name, width: 1920, height: 1080, revision: 0, publicId: `mock-${id}`,
    waitFor: ['tts', 'trigger', 'bits', 'follow'], widgets: [
      { id: 'tts-1', kind: 'tts', x: 670, y: 62, width: 580, height: 160, visible: true, locked: false },
      { id: 'trigger-1', kind: 'trigger', x: 75, y: 755, width: 510, height: 230, visible: true, locked: false },
      { id: 'clip-1', kind: 'clip', x: 1410, y: 775, width: 430, height: 250, visible: true, locked: false },
      { id: 'alert-1', kind: 'alert', x: 640, y: 450, width: 640, height: 192, visible: true, locked: false,
        designId, events: [...ALERT_EVENTS] }
    ] };
}

/** Ordered rules: the first enabled match wins; malformed/missing event data uses the default. */
export function matchingVariant(design: AlertDesign, kind: AlertEvent, raw: Record<string, unknown>): AlertVariant | undefined {
  if (kind === 'follow') return undefined;
  return design.variants?.[kind]?.find(v => {
    if (!v.enabled) return false;
    if (kind === 'sub') return !!v.tier && raw['tier'] === v.tier;
    const amount = raw[kind === 'bits' ? 'bits' : 'viewers'];
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0
      && amount >= (v.min ?? 0) && (v.max === undefined || amount <= v.max);
  });
}
export function selectAlertLayout(design: AlertDesign, kind: AlertEvent, raw: Record<string, unknown>): AlertLayout {
  return matchingVariant(design, kind, raw)?.layout ?? design.events[kind];
}
export const designLayouts = (design: AlertDesign): AlertLayout[] => [
  ...Object.values(design.events), ...Object.values(design.variants ?? {}).flatMap(variants => variants.map(v => v.layout))
];
