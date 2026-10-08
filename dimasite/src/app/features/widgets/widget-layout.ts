import { WidgetLayout } from './widgets-api.service';
export interface WidgetRect { x: number; y: number; width: number; height: number }
/** All positions are in the single 1920 × 1080 OBS source's coordinate system. */
export function widgetGeometry(layout: WidgetLayout, gameplay: boolean) {
  const width = Math.max(320, Math.min(800, layout.cameraWidth)), height = Math.max(180, Math.min(640, layout.cameraHeight));
  const left = layout.cameraCorner.endsWith('left'), top = layout.cameraCorner.startsWith('top');
  const compact = layout.loadoutMode === 'compact' || layout.autoCompact && gameplay;
  const activeWidth = 1760 - width, activeX = left ? 96 + width : 64, sideX = left ? 64 : 1856 - width;
  const cameraY = top ? 64 : 1016 - height, infoY = top ? cameraY + height + 32 : 64;
  const scoreWidth = layout.progressStyle === 'bar' ? activeWidth : Math.min(864, activeWidth);
  return {compact, active: {x: activeX, y: 64, width: activeWidth, height: 776}, info: {x: sideX, y: infoY, width, height: compact ? Math.min(232, 920 - height) : 920 - height}, camera: {x: sideX, y: cameraY, width, height}, progress: {x: activeX + (activeWidth - scoreWidth) / 2, y: 898, width: scoreWidth, height: 118}};
}
