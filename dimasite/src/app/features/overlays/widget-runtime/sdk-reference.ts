/**
 * The widget APIs as data: one source for the code editor's suggestions and hover docs, and for the typings and
 * JSON schemas in "Download for your code editor". Mirrors dima-sdk.ts, dima-events.ts and se-shim.ts (a spec
 * cross-checks the lists against them). `type` is TypeScript text; a type name found in `TYPES` can be completed into.
 */
import { WIDGET_USES, type FieldType, type WidgetField } from '../custom-widget-format.generated';

export interface RefProp {
  type: string;
  doc: string;
  /** Methods show a short call shape in suggestions. */
  call?: string;
}
export interface RefType { doc: string; props: Record<string, RefProp> }

const p = (type: string, doc: string): RefProp => ({ type, doc });
const m = (type: string, call: string, doc: string): RefProp => ({ type, call, doc });

export const TYPES: Record<string, RefType> = {
  // ---- Dima SDK -------------------------------------------------------------------------------------------------
  DimaSDK: { doc: 'The Dima SDK (global `Dima`): the widget\'s only connection to Studio and OBS.', props: {
    version: p('1', 'SDK version (1).'),
    ready: m('() => Promise<DimaContext>', 'ready()', 'Resolves once Studio/OBS sends the widget\'s settings, channel and mode.'),
    context: p('DimaContext | null', 'Widget, channel, settings and mode after `ready()` (null before).'),
    fields: p('WidgetFields', 'Current settings. Available immediately; updated before each `fields` event.'),
    mode: p("'editor' | 'live' | null", '`editor` in Studio, `live` in OBS (null before `ready()`).'),
    on: m('<K extends keyof DimaEvents>(type: K, handler: (data: DimaEvents[K]) => void) => () => void', "on('event', handler)",
      'Listens for an event (chat, chat.delete, chat.clear, alert, button, fields, store, session). Returns a function that stops listening.'),
    off: m('<K extends keyof DimaEvents>(type: K, handler: (data: DimaEvents[K]) => void) => void', "off('event', handler)", 'Stops a handler added with `on`.'),
    store: p('DimaStore', 'Values saved for this widget (needs "store" in widget.json uses).'),
    counters: p('DimaCounters', 'The bot\'s command counters (needs "counters" in widget.json uses).'),
    setField: m('(key: string, value: unknown, reload?: boolean) => Promise<void>', 'setField(key, value, reload?)', 'Studio only: changes a setting from code (reloads the widget unless reload is false).'),
    done: m('() => Promise<void>', 'done()', 'Reserved for the alert queue; does nothing in SDK v1.'),
    escape: m('(text: unknown) => string', 'escape(text)', 'Escapes text for safe use in HTML.'),
    html: m('(message: DimaChat) => string', 'html(message)', 'A chat message as safe HTML with Twitch emotes as <img>.'),
    log: m('(...args: unknown[]) => void', 'log(...args)', 'Writes to the widget log in Studio.')
  } },
  DimaStore: { doc: 'Saved values (JSON, up to 64 KB each).', props: {
    get: m('(key: string) => Promise<unknown>', 'get(key)', 'Reads a saved value (null when missing).'),
    set: m('(key: string, value: unknown) => Promise<void>', 'set(key, value)', 'Saves a value; other sources of this widget get a `store` event.')
  } },
  DimaCounters: { doc: 'Bot command counters.', props: {
    get: m('(name: string) => Promise<number>', 'get(name)', 'A command counter\'s value (0 when it doesn\'t exist).')
  } },
  DimaContext: { doc: 'What `Dima.ready()` resolves to.', props: {
    widget: p('DimaWidgetInfo', 'This widget and layer.'),
    channel: p('DimaChannel', 'The channel the overlay belongs to.'),
    fields: p('WidgetFields', 'Settings when the widget started.'),
    mode: p("'editor' | 'live'", '`editor` in Studio, `live` in OBS.'),
    muted: p('boolean', 'Whether sound should stay off.'),
    session: p('DimaSession | null', 'Recent events and totals (needs "session" in uses).')
  } },
  DimaWidgetInfo: { doc: 'The widget and layer.', props: {
    id: p('string', 'Widget ID.'), layerId: p('string', 'Layer ID in the overlay.'), name: p('string', 'Layer or widget name.'), revision: p('number', 'Version of the widget\'s code.')
  } },
  DimaChannel: { doc: 'A Twitch channel.', props: { id: p('string', 'Twitch user ID.'), login: p('string', 'Login (lowercase).'), name: p('string', 'Display name.') } },
  DimaUser: { doc: 'A Twitch user.', props: { id: p('string', 'Twitch user ID.'), login: p('string', 'Login (lowercase).'), name: p('string', 'Display name.') } },
  DimaChatUser: { doc: 'Who wrote a chat message.', props: {
    id: p('string', 'Twitch user ID.'), login: p('string', 'Login (lowercase).'), name: p('string', 'Display name.'),
    color: p('string | null', 'Name colour (#RRGGBB) or null.'),
    badges: p('DimaBadge[]', 'Chat badges with images.'),
    roles: p('DimaRoles', 'Broadcaster, moderator, VIP, subscriber…'),
    subMonths: p('number | null', 'Months subscribed, when known.')
  } },
  DimaRoles: { doc: 'Chat roles.', props: Object.fromEntries(Object.entries({ broadcaster: 'the broadcaster', moderator: 'a moderator', vip: 'a VIP', subscriber: 'a subscriber',
    founder: 'a founder', artist: 'a channel artist', staff: 'Twitch staff', partner: 'a Twitch partner', turbo: 'a Turbo user', prime: 'a Prime Gaming user' })
    .map(([role, who]) => [role, p('boolean', `True when the user is ${who}.`)])) },
  DimaBadge: { doc: 'A chat badge.', props: {
    set: p('string', 'Badge set, e.g. "subscriber".'), version: p('string', 'Badge version.'), info: p('string', 'Extra info (e.g. sub months).'),
    title: p('string', 'Badge title.'), images: p('DimaImages', 'Image URLs at 1x/2x/4x.')
  } },
  DimaImages: { doc: 'Image URLs.', props: { '1x': p('string', '1x image URL.'), '2x': p('string', '2x image URL.'), '4x': p('string', '4x image URL.') } },
  DimaChat: { doc: 'A chat message (event `chat`).', props: {
    id: p('string', 'Message ID (used by `chat.delete`).'), platform: p("'twitch'", 'Where it came from.'), at: p('number', 'Time (ms since 1970).'),
    user: p('DimaChatUser', 'Who wrote it.'), text: p('string', 'Plain text.'), parts: p('DimaPart[]', 'Text, emotes, cheers and mentions in order.'),
    kind: p("'text' | 'highlighted' | 'intro' | 'power-up' | 'gigantified'", 'Message kind.'),
    action: p('boolean', 'True for /me messages.'), firstMessage: p('boolean', 'True for a first-time chatter\'s first message.'),
    bits: p('number', 'Bits cheered in this message.'), rewardId: p('string | null', 'Channel-point reward ID, when sent with one.'),
    reply: p('DimaReply | null', 'The message it replies to.'), sharedChat: p('DimaSharedChat | null', 'Set when it came from a shared chat.')
  } },
  DimaReply: { doc: 'The message being replied to.', props: { id: p('string', 'Message ID.'), user: p('DimaUser', 'Its author.'), text: p('string', 'Its text.') } },
  DimaSharedChat: { doc: 'Shared chat origin.', props: { channelId: p('string', 'Channel it was sent in.'), messageId: p('string', 'Original message ID.') } },
  DimaChatDelete: { doc: 'A message was deleted (event `chat.delete`).', props: { messageId: p('string', 'Deleted message ID.'), userId: p('string | null', 'Its author.') } },
  DimaChatClear: { doc: 'Chat was cleared (event `chat.clear`).', props: { userId: p('string | null', 'One user\'s messages, or null for the whole chat.') } },
  DimaAlert: { doc: 'A follow, sub, gift, Bits, raid or tip (event `alert`).', props: {
    id: p('string', 'Event ID.'), type: p("'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid' | 'tip'", 'What happened.'),
    at: p('number', 'Time (ms since 1970).'), test: p('boolean', 'True for Studio tests.'),
    user: p('DimaUser | null', 'Who did it (null when anonymous).'), amount: p('number', 'Bits, gift count, raid viewers or tip amount.'),
    tier: p("'1000' | '2000' | '3000' | 'prime' | null", 'Sub tier.'), months: p('number | null', 'Total months (resubs).'), streak: p('number | null', 'Streak months.'),
    message: p('string | null', 'Message sent with it.'), recipient: p('DimaUser | null', 'Gift recipient (single gifts).'),
    currency: p('string | null', 'Tip currency.'), rule: p('DimaAlertRule | null', 'The alert rule that matched.')
  } },
  DimaAlertRule: { doc: 'An alert rule.', props: { id: p('string', 'Rule ID.'), name: p('string', 'Rule name.') } },
  DimaButton: { doc: 'A settings button was pressed in Studio (event `button`).', props: { field: p('string', 'The button\'s field key.'), value: p('unknown', 'The button\'s value.') } },
  DimaStoreUpdate: { doc: 'A saved value changed (event `store`).', props: { key: p('string', 'Key.'), value: p('unknown', 'New value.'), namespace: p('string', 'Store it belongs to.') } },
  DimaSession: { doc: 'Recent events and totals (StreamElements-style keys).', props: {
    data: p('Record<string, unknown>', 'Keys like "follower-latest", "subscriber-recent", "cheer-session".'), recents: p('unknown[]', 'Recent events, newest first.')
  } },
  // ---- StreamElements layer -----------------------------------------------------------------------------------
  SEApi: { doc: 'StreamElements API (global `SE_API`) on top of the Dima SDK.', props: {
    store: p('SEStore', 'Channel-wide saved values (shared by StreamElements widgets).'),
    counters: p('SECounters', 'Command counters.'),
    sanitize: m('(input: { message?: string }) => Promise<{ skip: boolean; result: { message: string } }>', 'sanitize({ message })', 'Returns the message unchanged (no word filter yet).'),
    cheerFilter: m('(text: string) => Promise<string>', 'cheerFilter(text)', 'Removes cheermotes (Cheer100…) from text.'),
    getOverlayStatus: m('() => Promise<{ isEditorMode: boolean; muted: boolean }>', 'getOverlayStatus()', 'Editor or live, muted or not.'),
    resumeQueue: m('() => void', 'resumeQueue()', 'With a widgetDuration setting: lets the next queued alert play now.'),
    setField: m('(key: string, value: unknown, reload?: boolean) => Promise<void>', 'setField(key, value, reload?)', 'Studio only: changes a setting from code.')
  } },
  SEStore: { doc: 'Channel-wide saved values.', props: {
    get: m('(key: string) => Promise<unknown>', 'get(key)', 'Reads a saved value.'), set: m('(key: string, value: unknown) => Promise<void>', 'set(key, value)', 'Saves a value.')
  } },
  SECounters: { doc: 'Command counters.', props: {
    get: m('(counter: string) => Promise<{ id: string; count: number; counter: string; value: number }>', 'get(counter)', 'A command counter.')
  } },
  SEWidgetLoad: { doc: '`onWidgetLoad` event detail.', props: {
    channel: p('SEChannel', 'The channel.'), currency: p('{ code: string; name: string; symbol: string }', 'Currency (always USD).'),
    fieldData: p('WidgetFields', 'The widget\'s settings.'), recents: p('unknown[]', 'Recent events.'),
    session: p('{ data: Record<string, unknown>; settings: Record<string, unknown> }', 'Session data (session.data["follower-latest"]…).'),
    overlay: p('{ isEditorMode: boolean; muted: boolean }', 'Editor or live.'), emotes: p('unknown[]', 'Always empty.')
  } },
  SEChannel: { doc: 'The channel.', props: { id: p('string', 'Twitch user ID.'), username: p('string', 'Login.'), providerId: p('string', 'Twitch user ID.'), avatar: p('string', 'Always empty.') } },
  SEEventReceived: { doc: '`onEventReceived` event detail.', props: { listener: p('SEListener', 'What kind of event (message, follower-latest…).'), event: p('SEEvent', 'The event; its fields depend on the listener.') } },
  SEEvent: { doc: 'An `onEventReceived` event (fields depend on the listener).', props: {
    data: p('SEMessageData', 'listener "message": the chat message.'), renderedText: p('string', 'listener "message": escaped HTML with emotes.'),
    service: p('string', 'listener "message": "twitch".'),
    msgId: p('string', 'listener "delete-message": deleted message ID.'), userId: p('string', 'listener "delete-messages": cleared user ID.'),
    name: p('string', 'Alerts: who did it.'), amount: p('number', 'Alerts: Bits, months, gifts or raid viewers.'), message: p('string', 'Alerts: their message.'),
    type: p('string', 'Alerts: follower, subscriber, cheer, raid, tip.'), tier: p('string', 'Subs: "1000", "2000", "3000" or "prime".'),
    gifted: p('boolean', 'Subs: a gifted sub.'), sender: p('string', 'Gifted subs: who gifted.'), bulkGifted: p('boolean', 'Community gift.'),
    isCommunityGift: p('boolean', 'Community gift.'), playedAsCommunityGift: p('boolean', 'Subs: shown as part of a community gift.'),
    streak: p('number', 'Resubs: streak months.'), currency: p('string', 'Tips: currency.'), _id: p('string', 'Event ID.'), createdAt: p('string', 'ISO time.'),
    listener: p('string', 'listener "widget-button": the listener name again.'),
    field: p('string', 'listener "widget-button": the button\'s field key.'), value: p('unknown', 'listener "widget-button": its value.')
  } },
  SEMessageData: { doc: 'A chat message (StreamElements shape).', props: {
    time: p('number', 'Time (ms).'), tags: p('Record<string, string>', 'IRC tags (badges, color, emotes, first-msg…).'), nick: p('string', 'Login.'),
    userId: p('string', 'Twitch user ID.'), displayName: p('string', 'Display name.'), displayColor: p('string', 'Name colour.'),
    badges: p('{ type: string; version: string; url: string; description: string }[]', 'Badges.'), channel: p('string', 'Channel login.'),
    text: p('string', 'Plain text.'), isAction: p('boolean', '/me message.'), emotes: p('unknown[]', 'Emotes with positions and URLs.'), msgId: p('string', 'Message ID.'),
    key: p('string', 'listener "kvstore:update": the changed key ("customWidget." + key).'), value: p('unknown', 'listener "kvstore:update": its new value.')
  } },
  SESessionUpdate: { doc: '`onSessionUpdate` event detail.', props: { session: p('Record<string, unknown>', 'Session data.') } }
};

/** Type aliases for the typings (unions that can't be completed into). */
export const ALIASES: Record<string, string> = {
  DimaPart: "{ type: 'text'; text: string } | { type: 'emote'; text: string; id: string; animated: boolean; images: DimaImages } | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number } | { type: 'mention'; text: string; user: DimaUser }",
  SEListener: "'message' | 'delete-message' | 'delete-messages' | 'follower-latest' | 'subscriber-latest' | 'cheer-latest' | 'raid-latest' | 'tip-latest' | 'widget-button' | 'kvstore:update'"
};

/** Dima SDK events: payload type and the widget.json `uses` entry needed to receive them. */
export const DIMA_EVENTS: { name: string; type: string; uses: string | null; doc: string }[] = [
  { name: 'chat', type: 'DimaChat', uses: 'chat', doc: 'A chat message.' },
  { name: 'chat.delete', type: 'DimaChatDelete', uses: 'chat', doc: 'A moderator deleted a message.' },
  { name: 'chat.clear', type: 'DimaChatClear', uses: 'chat', doc: 'One user\'s messages or the whole chat was cleared.' },
  { name: 'alert', type: 'DimaAlert', uses: 'alerts', doc: 'Follow, sub, resub, gift, Bits, raid or tip.' },
  { name: 'button', type: 'DimaButton', uses: null, doc: 'A settings button was pressed in Studio.' },
  { name: 'fields', type: 'WidgetFields', uses: null, doc: 'Settings changed in Studio (no reload).' },
  { name: 'store', type: 'DimaStoreUpdate', uses: 'store', doc: 'A saved value changed.' },
  { name: 'session', type: 'DimaSession', uses: 'session', doc: 'Recent events and totals changed.' }
];
export const SE_EVENTS: { name: string; type: string; doc: string }[] = [
  { name: 'onWidgetLoad', type: 'SEWidgetLoad', doc: 'Once at start: settings (fieldData), channel and session.' },
  { name: 'onEventReceived', type: 'SEEventReceived', doc: 'Chat, deletes, alerts, buttons and store changes.' },
  { name: 'onSessionUpdate', type: 'SESessionUpdate', doc: 'Session data changed.' }
];
export const SE_LISTENERS: { name: string; doc: string }[] = [
  { name: 'message', doc: 'A chat message (event.data, event.renderedText).' },
  { name: 'delete-message', doc: 'A message was deleted (event.msgId).' },
  { name: 'delete-messages', doc: 'A user\'s messages were cleared (event.userId).' },
  { name: 'follower-latest', doc: 'A follow (event.name).' },
  { name: 'subscriber-latest', doc: 'A sub, resub or gift (event.name, amount, tier, gifted, sender).' },
  { name: 'cheer-latest', doc: 'Bits (event.name, amount, message).' },
  { name: 'raid-latest', doc: 'A raid (event.name, amount).' },
  { name: 'tip-latest', doc: 'A tip (never fires until tipping is available).' },
  { name: 'widget-button', doc: 'A settings button was pressed (event.field, event.value).' },
  { name: 'kvstore:update', doc: 'A saved value changed (event.data.key, event.data.value).' }
];

/** widget.json keys and values. */
export const MANIFEST_KEYS: { name: string; doc: string; values?: readonly string[] }[] = [
  { name: 'engine', doc: '"dima" (Dima SDK) or "streamelements" (StreamElements layer).', values: ['dima', 'streamelements'] },
  { name: 'api', doc: 'SDK version the code was written for: 1.' },
  { name: 'name', doc: 'Widget name (used on import).' },
  { name: 'author', doc: 'Who made it.' },
  { name: 'version', doc: 'Your version text, e.g. "1.0.0".' },
  { name: 'description', doc: 'One line about what it does.' },
  { name: 'uses', doc: 'Live data the widget may read.', values: WIDGET_USES }
];
export const USES_DOCS: Record<string, string> = {
  chat: 'Chat messages, deletes and clears.', alerts: 'Follows, subs, gifts, Bits, raids and tips.', store: 'Saved values (Dima.store / SE_API.store).',
  counters: 'Bot command counters.', session: 'Recent events and totals.'
};
/** fields.txt field types and properties. */
export const FIELD_TYPES: { name: FieldType; doc: string }[] = [
  { name: 'text', doc: 'One line of text.' }, { name: 'textarea', doc: 'Several lines of text.' }, { name: 'number', doc: 'A number (min, max, step).' },
  { name: 'slider', doc: 'A number on a slider (min, max, step).' }, { name: 'checkbox', doc: 'On or off.' }, { name: 'colorpicker', doc: 'A colour.' },
  { name: 'dropdown', doc: 'One of the options ({ "value": "Label" }).' }, { name: 'googleFont', doc: 'A Google font name.' },
  { name: 'image-input', doc: 'An image (multiple: true for a list).' }, { name: 'video-input', doc: 'A video.' }, { name: 'sound-input', doc: 'A sound.' },
  { name: 'button', doc: 'A button that sends an event (Dima `button`, SE `widget-button`).' }, { name: 'hidden', doc: 'A value the settings panel doesn\'t show.' }
];
export const FIELD_PROPS: { name: string; doc: string }[] = [
  { name: 'type', doc: 'Field type.' }, { name: 'label', doc: 'Label in the settings panel.' }, { name: 'value', doc: 'Default value.' },
  { name: 'group', doc: 'Settings group it appears in.' }, { name: 'options', doc: 'dropdown: { "value": "Label", … }.' },
  { name: 'min', doc: 'number/slider: lowest value.' }, { name: 'max', doc: 'number/slider: highest value.' }, { name: 'step', doc: 'number/slider: step.' },
  { name: 'multiple', doc: 'Media inputs: allow several files.' }
];

/** The TypeScript type of a setting's value. */
export function fieldValueType(field: Pick<WidgetField, 'type' | 'options' | 'multiple'>): string {
  switch (field.type) {
    case 'number': case 'slider': return 'number';
    case 'checkbox': return 'boolean';
    case 'dropdown': return field.options?.length ? field.options.map(option => JSON.stringify(option.value)).join(' | ') : 'string';
    case 'image-input': case 'video-input': case 'sound-input': return field.multiple ? 'string[]' : 'string';
    case 'hidden': return 'any';
    default: return 'string';
  }
}
export const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);
/** Strips `| null` and similar so a type name can be completed into. */
export function typeName(type: string): string | null {
  const parts = type.split('|').map(part => part.trim()).filter(part => part !== 'null' && part !== 'undefined');
  return parts.length === 1 && Object.hasOwn(TYPES, parts[0]) ? parts[0] : null;
}
