/**
 * Compatibility code the API keeps for older pages. An entry can go once no page of its client older than `before`
 * has been seen for COMPAT_QUIET_DAYS (client-versions.ts). Nothing is removed automatically: the admin site shows the
 * entry as ready and the owner asks an agent to remove the code listed in `code`, then deletes the entry.
 */
export type ClientKind = 'overlay' | 'studio';
export interface CompatEntry {
  id: string;
  client: ClientKind;
  /** Pages with a lower protocol (overlay) or writer (studio) need this code. */
  before: number;
  /** What the code does, in plain words. */
  summary: string;
  /** Where the code lives, for the agent that removes it. */
  code: readonly string[];
}
export const COMPAT_QUIET_DAYS = 14;
export const COMPAT_ENTRIES: readonly CompatEntry[] = [
  {
    id: 'overlay-legacy-sound', client: 'overlay', before: 1,
    summary: 'Alert designs also store `sound`, a copy of the first sound, because older OBS pages play only that one sound.',
    code: ['dimabot/src/overlays/store.ts: alertLayout() writes result.sound in design mode',
      'dimabot/src/overlays/default-alerts.ts: the default designs write the same mirror']
  },
  {
    id: 'overlay-library-urls', client: 'overlay', before: 1,
    summary: 'Published designs sent to OBS also carry the file URL of Dima library pictures and sounds, because older OBS pages only know URLs and Studio assets.',
    code: ['dimabot/src/overlays/store.ts: publicState() calls designsWithLibraryUrls()',
      'dimabot/src/overlays/library.ts: layoutWithLibraryUrls() and designsWithLibraryUrls()']
  },
  {
    id: 'overlay-legacy-interactions', client: 'overlay', before: 1,
    summary: 'Polls and predictions are also sent in the old `interactions` format (`overlay-interactions` event and field), for OBS pages from before widget states.',
    code: ['dimabot/src/overlays/live/widget_feeds.live.ts: publicWidgetStateFor() legacy interactions and the overlay-interactions emit in tickWidgetFeeds()',
      'dimabot/src/overlays/live/connections.live.ts: `interactions` in the overlay-state message',
      'dimabot/src/overlays/widget-state-providers.ts: legacyInteractions()',
      'dimabot/src/server/routes/overlay-studio.route.ts: `interactions` in the public overlay response']
  },
  {
    id: 'studio-old-editor-sounds', client: 'studio', before: 2,
    summary: 'Saves without `writer` (Studio tabs opened before several sounds per alert) get their single `sound` edit merged into `sounds`.',
    code: ['dimabot/src/overlays/store.ts: the writer < 2 branch of alertLayout()']
  }
];
