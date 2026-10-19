import type { InputSignal, OutputEmitterRef, Type } from '@angular/core';
import type { LucideIconData } from 'lucide-angular';
import type { OverlayWidget } from './overlay.model';
import type { WidgetDefinition, WidgetPlacement } from './overlay-widget-contract.generated';

export interface WidgetFixture { id: string; labelKey: string }
export interface WidgetPreview {
  defaultFixture: string;
  fixtures: readonly WidgetFixture[];
  create: (fixture: string, translate: (key: string) => string) => unknown;
}
/** Both the local canvas and OBS pass the same inputs to a registered renderer. */
export interface WidgetRenderContext {
  widget: OverlayWidget;
  state: unknown;
  preview: boolean;
  clockOffset: number;
}
export interface WidgetRenderer { readonly context: InputSignal<WidgetRenderContext> }
export interface WidgetSettingsContext {
  widget: OverlayWidget;
  previewFixture: string;
  fixtures: readonly WidgetFixture[];
}
export interface WidgetSettings {
  readonly context: InputSignal<WidgetSettingsContext>;
  readonly configChange: OutputEmitterRef<Partial<OverlayWidget>>;
  readonly previewChange: OutputEmitterRef<string>;
}
export interface WidgetCreationContext {
  id: string;
  placement: WidgetPlacement;
  position?: { x: number; y: number };
  defaultDesignId?: string;
}
export interface OverlayWidgetModule {
  definition: WidgetDefinition;
  nameKey: string;
  icon: LucideIconData;
  createDefault: (context: WidgetCreationContext) => OverlayWidget;
  renderer?: Type<WidgetRenderer>;
  settings?: Type<WidgetSettings>;
  preview?: WidgetPreview;
}
