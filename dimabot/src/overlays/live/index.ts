/**
 * Overlay Studio live delivery (OBS sources). Public entry point; each file owns one job:
 * - connections.live.ts   OBS source sockets, reconnect leases, published overlay reloads, the 1 s loop, producer bridge
 * - delivery.live.ts      the pending event queue, durable copies, media files, event details, queue controls
 * - alerts.live.ts        Twitch alerts from the domain event log, Bits rules
 * - tts.live.ts           TTS speech ownership, playback reports, skip/clear/refresh, status
 * - widget_feeds.live.ts  state widgets (polls, predictions) and custom widget feeds
 */
export { registerStudio, studioHasSource, studioConnections, connectedClientVersions } from './connections.live.js';
export { publishStudioMedia, publishStudioTrigger, publishTest, eventFor, fileFor, queueStatus, controlStudio } from './delivery.live.js';
export type { ClipMetadata, LiveMedia, LiveEvent } from './delivery.live.js';
export { bitsRuleFor, publishStudioAlert } from './alerts.live.js';
export { publishStudioReadTts, endStudioReadTts, studioTtsStatus, controlStudioTts } from './tts.live.js';
export { ensureWidgetModeration, feedSignal, feedTestAlert, feedTestEvent, interactionKinds, publicWidgetStateFor, interactionsFor, onWidgetChat, subscribeChatFeed } from './widget_feeds.live.js';
