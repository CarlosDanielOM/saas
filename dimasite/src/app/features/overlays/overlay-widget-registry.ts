import { Bell, Clapperboard, Image, Layers3, Play, Radio, Sparkles, Type, Volume2, Zap, type LucideIconData } from 'lucide-angular';
import { OverlayInteractionSettingsComponent } from './overlay-interaction-settings.component';
import { OverlayInteractionWidgetComponent } from './overlay-interaction-widget.component';
import { sampleInteraction, type InteractionKind, type InteractionPreview } from './overlay-interaction.model';
import type { OverlayWidget } from './overlay.model';
import { getWidgetDefinition, validWidgetModuleConfig, widgetKinds, type WidgetKind, type WidgetPlacement } from './overlay-widget-contract.generated';
import type { OverlayWidgetModule, WidgetCreationContext, WidgetPreview } from './overlay-widget-module';

function moduleDefinition(kind: WidgetKind, icon: LucideIconData, extensions: Partial<OverlayWidgetModule> = {}): OverlayWidgetModule {
  const definition = getWidgetDefinition(kind)!;
  return {
    definition, nameKey: kind + 'Name', icon,
    createDefault: context => ({
      ...structuredClone(definition.defaults), id: context.id, kind, configVersion: definition.configVersion,
      x: context.position?.x ?? 40, y: context.position?.y ?? 40, ...definition.defaultSize, visible: true, locked: false
    }),
    ...extensions
  };
}
function interactionPreview(kind: InteractionKind, stages: InteractionPreview[]): WidgetPreview {
  return { defaultFixture: 'progress', fixtures: stages.map(id => ({ id, labelKey: 'interactionPreview_' + id })),
    create: (fixture, translate) => sampleInteraction(kind, stages.includes(fixture as InteractionPreview) ? fixture as InteractionPreview : 'progress', translate) };
}
/** Module registration is the frontend extension point. Stateful modules supply their own UI and fixtures. */
export const OVERLAY_WIDGET_MODULES: Readonly<Record<WidgetKind, OverlayWidgetModule>> = {
  poll: moduleDefinition('poll', Radio, { renderer: OverlayInteractionWidgetComponent, settings: OverlayInteractionSettingsComponent,
    preview: interactionPreview('poll', ['begin', 'progress', 'result', 'tie', 'canceled']) }),
  prediction: moduleDefinition('prediction', Sparkles, { renderer: OverlayInteractionWidgetComponent, settings: OverlayInteractionSettingsComponent,
    preview: interactionPreview('prediction', ['begin', 'progress', 'locked', 'result', 'canceled']) }),
  tts: moduleDefinition('tts', Volume2),
  trigger: moduleDefinition('trigger', Zap),
  clip: moduleDefinition('clip', Clapperboard),
  alert: moduleDefinition('alert', Bell, { createDefault: context => ({ ...moduleDefinition('alert', Bell).createDefault(context), designId: context.defaultDesignId }) }),
  text: moduleDefinition('text', Type),
  image: moduleDefinition('image', Image),
  video: moduleDefinition('video', Play),
  animation: moduleDefinition('animation', Sparkles),
  shape: moduleDefinition('shape', Layers3)
};
export function getWidgetModule(kind: unknown): OverlayWidgetModule | undefined {
  const definition = getWidgetDefinition(kind);
  return definition ? OVERLAY_WIDGET_MODULES[definition.kind] : undefined;
}
export function widgetModuleFor(widget: OverlayWidget, placement: WidgetPlacement): OverlayWidgetModule | undefined {
  return validWidgetModuleConfig(widget as unknown as Record<string, unknown>, placement) ? getWidgetModule(widget.kind) : undefined;
}
export function widgetPalette(placement: WidgetPlacement): WidgetKind[] {
  return widgetKinds(placement).filter(kind => getWidgetModule(kind)?.definition.palette?.[placement] !== false);
}
export function createWidget(kind: WidgetKind, context: WidgetCreationContext): OverlayWidget | null {
  const module = getWidgetModule(kind);
  return module?.definition.placements.includes(context.placement) ? module.createDefault(context) : null;
}
export function widgetFixture(widget: OverlayWidget, fixture?: string): string {
  const preview = getWidgetModule(widget.kind)?.preview;
  return preview?.fixtures.some(item => item.id === fixture) ? fixture! : preview?.defaultFixture ?? '';
}
