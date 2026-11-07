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
      'Listens for an event (chat, chat.delete, chat.clear, alert, button, fields, storage, session, signal or signal:<name>). Returns a function that stops listening.'),
    off: m('<K extends keyof DimaEvents>(type: K, handler: (data: DimaEvents[K]) => void) => void', "off('event', handler)", 'Stops a handler added with `on`.'),
    state: m('<K extends keyof DimaStates>(name: K, handler: (value: DimaStates[K]) => void) => () => void', "state('polls', handler)",
      'Live state by name: "polls" (needs "polls" in uses) or "goals" (needs "goals"). The handler gets the latest value right away (once known) and every change. Returns a function that stops listening.'),
    storage: p('DimaStorage', 'Values saved for this widget (needs "storage" in widget.json uses).'),
    counters: p('DimaCounters', 'The bot\'s command counters (needs "counters" in widget.json uses).'),
    setField: m('(key: string, value: unknown, reload?: boolean) => Promise<void>', 'setField(key, value, reload?)', 'Studio only: changes a setting from code (reloads the widget unless reload is false).'),
    done: m('() => Promise<void>', 'done()', 'Reserved for the alert queue; does nothing in SDK v1.'),
    escape: m('(text: unknown) => string', 'escape(text)', 'Escapes text for safe use in HTML.'),
    html: m('(message: DimaChat) => string', 'html(message)', 'A chat message as safe HTML with Twitch emotes as <img>.'),
    log: m('(...args: unknown[]) => void', 'log(...args)', 'Writes to the widget log in Studio.')
  } },
  DimaStorage: { doc: 'Saved values (JSON, up to 64 KB each).', props: {
    get: m('(key: string) => Promise<unknown>', 'get(key)', 'Reads a saved value (null when missing).'),
    set: m('(key: string, value: unknown) => Promise<void>', 'set(key, value)', 'Saves a value; other sources of this widget get a `storage` event.')
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
    session: p('DimaSession | null', 'Recent events and totals (needs "session" in uses).'),
    goalSource: p("'dima' | 'twitch'", 'Where this layer\'s goals come from (Studio, Goal data): the Goals page or the streamer\'s Twitch goals.')
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
  DimaStorageUpdate: { doc: 'A saved value changed (event `storage`).', props: { key: p('string', 'Key.'), value: p('unknown', 'New value.'), namespace: p('string', 'Store it belongs to.') } },
  DimaSignal: { doc: 'A chat command ran `$(widget.signal name value)` (event `signal`, or `signal:name` for one name). The value is viewer text: show it with `textContent` or `Dima.escape()`.', props: {
    id: p('string', 'Signal ID.'), name: p('string', 'Signal name (lowercase letters, digits and _).'),
    value: p('string', 'Text after the name, e.g. what the viewer typed (`&p1`, `&t`). Empty when none.'),
    json: p('unknown', 'The value parsed when it is a JSON number, boolean, array or object (otherwise null).'),
    args: p('string[]', 'The value split on spaces.'), at: p('number', 'Time sent (ms).'),
    user: p('DimaSignalUser | null', 'Who used the command (null when unknown).'),
    source: p('DimaSignalSource', 'What sent it: a command, keyword, event or a Studio test.'),
    target: p('string | null', 'Layer name for `$(widget.signal.to …)` (null: every widget that uses signals).')
  } },
  DimaSignalUser: { doc: 'Who used the command.', props: { id: p('string', 'Twitch user ID.'), login: p('string', 'Login (lowercase).'), name: p('string', 'Display name.'), roles: p('DimaRoles', 'Broadcaster, moderator, VIP, subscriber.') } },
  DimaSignalSource: { doc: 'What sent a signal.', props: { kind: p("'command' | 'keyword' | 'event' | 'studio'", 'Command, keyword, Twitch event or Studio test.'), name: p('string', 'Command or keyword name.') } },
  DimaPolls: { doc: 'Live state "polls": the current Twitch poll and prediction (null when there is none).', props: {
    poll: p('DimaPoll | null', 'The current or last poll.'), prediction: p('DimaPoll | null', 'The current or last prediction.')
  } },
  DimaPoll: { doc: 'A Twitch poll or prediction (totals only, never who voted).', props: {
    kind: p("'poll' | 'prediction'", 'Poll or prediction.'), id: p('string', 'Twitch ID.'), title: p('string', 'Question.'),
    phase: p("'active' | 'locked' | 'completed' | 'archived' | 'terminated' | 'resolved' | 'canceled'", 'Where it is: active, locked (predictions), or finished.'),
    choices: p('DimaPollChoice[]', 'Choices with their totals.'), startedAt: p('string', 'ISO time.'), deadline: p('string | null', 'ISO time voting ends.'),
    endedAt: p('string | null', 'ISO time it ended.'), winnerId: p('string | null', 'Winning choice (predictions).'), revision: p('number', 'Grows with every change.'),
    occurredAt: p('string', 'ISO time of the last change.'), receipt: p('string', 'Change identifier.')
  } },
  DimaPollChoice: { doc: 'A poll or prediction choice.', props: {
    id: p('string', 'Choice ID.'), title: p('string', 'Choice text.'), votes: p('number', 'Poll votes.'), users: p('number', 'People (predictions).'),
    points: p('number', 'Channel points (predictions).'), channelPointsVotes: p('number', 'Votes bought with channel points (polls).'), color: p('string', 'Twitch colour (predictions).')
  } },
  DimaGoal: { doc: 'A goal (live state "goals"): from the Goals page, or from Twitch when the layer is set to Twitch goals. Money goals are in currency units.', props: {
    id: p('string', 'Goal ID.'), source: p("'dima' | 'twitch'", 'Goals page or Twitch (each layer only gets its own source).'), name: p('string', 'Goal name.'),
    metric: p("'follows' | 'subs' | 'subPoints' | 'bits' | 'cheerers' | 'currency'", 'What it counts (sub points and cheerers: Twitch goals only).'),
    mode: p('string', 'How it counts: total, current, fixed, rolling, monthly, or twitch.'), target: p('number', 'Target.'), current: p('number', 'Progress.'),
    percent: p('number', 'Progress in percent (0–100).'), currency: p('string | null', 'Currency code for money goals.'),
    twitchType: p('string | null', "Twitch's goal type (follow, subscription_count, new_bit…); null for Goals page goals."),
    achieved: p('boolean | null', 'Twitch goals that ended: whether Twitch counted it as reached.'),
    status: p('string', 'scheduled, active, reached or ended.'), startsAt: p('number', 'Start time (ms).'), endsAt: p('number | null', 'End time (ms) for set dates, or when a Twitch goal ended.'),
    windowSeconds: p('number | null', 'Rolling window length.'), period: p('{ key: string; startsAt: number; endsAt: number } | null', 'Current month for monthly goals.')
  } },
  DimaTts: { doc: 'A text-to-speech message started or finished (event `tts`). Text is what was spoken.', props: {
    id: p('string', 'Message ID (same for start and end).'), phase: p("'start' | 'end'", 'Started or finished.'), text: p('string', 'Spoken text.'),
    user: p('DimaUser | null', 'Who sent it.'), reason: p("'ended' | 'skipped' | 'cleared' | 'interrupted' | null", 'How it finished (end only).'),
    at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaTrigger: { doc: 'A trigger alert was sent to the overlay (event `trigger`).', props: {
    id: p('string', 'This send.'), triggerId: p('string', 'The trigger (empty for unsaved ones).'), name: p('string', 'Trigger name.'),
    mediaType: p("'audio' | 'video' | 'image' | 'unknown'", 'Its media.'), at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaReward: { doc: 'A channel-point reward was redeemed (event `reward`). Input is viewer text: escape it.', props: {
    id: p('string', 'Redemption ID.'), reward: p('{ id: string; title: string; cost: number }', 'The reward.'), user: p('DimaUser | null', 'Who redeemed it.'),
    input: p('string | null', 'Their text, when the reward asks for it.'), at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaPet: { doc: 'The channel\'s pet started or finished a reply (event `pet`). Text is what it said.', props: {
    id: p('string', 'Reply ID (same for both phases).'), kind: p("'talk' | 'ask' | 'tts'", 'pet.talk, pet.ask or a TTS message read by the pet.'),
    phase: p("'speaking' | 'done'", 'Started or finished speaking.'), text: p('string', 'What the pet said.'), mood: p('string | null', 'Its mood when moods are on.'),
    result: p("'completed' | 'stopped' | null", 'How it finished (done only).'), at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaDuel: { doc: 'A duel started or ended (event `duel`). Names are Twitch logins; the winner is only sent when the fight ends.', props: {
    id: p('string', 'Duel ID (same for both phases).'), phase: p("'started' | 'ended'", 'Fight started or ended.'), challenger: p('string', 'Who challenged.'),
    opponent: p('string', 'Who was challenged.'), mode: p("'overlay' | 'chat'", 'Shown in the duel overlay or chat only.'), winner: p('string | null', 'Winner (ended only).'),
    loser: p('string | null', 'Loser (ended only).'), endsAt: p('number | null', 'When the fight ends (ms).'), at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaRoulette: { doc: 'A roulette spin (event `roulette`): `spinning`, then `result` with the label when it ends.', props: {
    id: p('string', 'Spin ID (same for both phases).'), rouletteId: p('string', 'The roulette.'), name: p('string', 'Roulette name.'),
    phase: p("'spinning' | 'result'", 'Spinning or finished.'), label: p('string | null', 'What it landed on (result only).'), endsAt: p('number', 'When the spin ends (ms).'),
    at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
  DimaHypeTrain: { doc: 'Live state "hypetrain": the running hype train, or the last one until its cooldown ends (null when there is none).', props: {
    id: p('string', 'This hype train.'), phase: p("'active' | 'ended'", 'Running or finished.'), level: p('number', 'Current (or final) level.'),
    total: p('number', 'Points so far (Twitch units).'), progress: p('number | null', 'Points toward the next level (null once ended).'), goal: p('number | null', 'Points this level needs (null once ended).'),
    topContributions: p('DimaHypeContribution[]', 'Top contributors (public on Twitch).'), allTimeHigh: p('{ level: number; total: number } | null', "The channel's record."),
    type: p("'regular' | 'golden_kappa' | 'treasure'", 'Kind of hype train.'), shared: p('boolean', 'A shared train with other channels.'), sharedParticipants: p('DimaUser[]', 'Channels in a shared train.'),
    startedAt: p('number', 'Start (ms).'), expiresAt: p('number | null', 'When it ends unless someone contributes (ms; null once ended).'),
    endedAt: p('number | null', 'End (ms).'), cooldownEndsAt: p('number | null', 'When the next hype train can start (ms).')
  } },
  DimaHypeContribution: { doc: 'A hype train contributor.', props: {
    user: p('DimaUser', 'Who.'), type: p("'bits' | 'subscription' | 'other'", 'What they gave.'), total: p('number', 'Their points (Twitch units).')
  } },
  DimaAds: { doc: 'Live state "ads": the running ad break and the ad schedule. Times are ms.', props: {
    active: p('DimaAdBreak | null', 'The ad break running now (null when none).'), schedule: p('DimaAdSchedule | null', 'From Twitch, about once a minute (null when unknown).')
  } },
  DimaAdBreak: { doc: 'An ad break.', props: {
    startedAt: p('number', 'Start (ms).'), endsAt: p('number', 'End (ms).'), duration: p('number', 'Length in seconds.'), automatic: p('boolean', 'Started by the ad schedule (not by hand).')
  } },
  DimaAdSchedule: { doc: "Twitch's ad schedule (fields are null when Twitch doesn't say).", props: {
    nextAt: p('number | null', 'Next scheduled ad break (ms; null when none is scheduled or offline).'), duration: p('number | null', 'Length of the next break (seconds).'),
    lastAt: p('number | null', 'Last ad break (ms).'), snoozes: p('number | null', 'Snoozes left.'), snoozeRefreshAt: p('number | null', 'When a snooze is added back (ms).'),
    prerollFreeUntil: p('number | null', 'Pre-roll free until (ms).')
  } },
  DimaDimafx: { doc: 'A DimaFX item was bought and is playing (event `dimafx`). Message is viewer text: escape it.', props: {
    id: p('string', 'This purchase.'), item: p('{ id: string; name: string; type: string }', 'The item.'), source: p("'bits' | 'credits' | 'saved' | 'test'", 'How it was paid.'),
    bits: p('number | null', 'Bits paid.'), credits: p('number | null', 'Credits paid.'), user: p('DimaUser | null', 'The buyer, only when they shared their identity with the extension.'),
    message: p('string | null', 'The viewer\'s own text (custom TTS items).'), at: p('number', 'Time (ms).'), test: p('boolean', 'A Studio test.')
  } },
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
    name: p('string', 'Alerts: who did it. dima:signal: the signal name.'), amount: p('number', 'Alerts: Bits, months, gifts or raid viewers.'), message: p('string', 'Alerts: their message.'),
    type: p('string', 'Alerts: follower, subscriber, cheer, raid, tip.'), tier: p('string', 'Subs: "1000", "2000", "3000" or "prime".'),
    gifted: p('boolean', 'Subs: a gifted sub.'), sender: p('string', 'Gifted subs: who gifted.'), bulkGifted: p('boolean', 'Community gift.'),
    isCommunityGift: p('boolean', 'Community gift.'), playedAsCommunityGift: p('boolean', 'Subs: shown as part of a community gift.'),
    streak: p('number', 'Resubs: streak months.'), currency: p('string', 'Tips: currency.'), _id: p('string', 'Event ID.'), createdAt: p('string', 'ISO time.'),
    listener: p('string', 'listener "widget-button": the listener name again.'),
    field: p('string', 'listener "widget-button": the button\'s field key.'), value: p('unknown', 'listener "widget-button": its value. dima:signal: the text after the signal name.'),
    id: p('string', 'listener "dima:signal": signal ID.'), at: p('number', 'listener "dima:signal": time sent (ms).'),
    json: p('unknown', 'listener "dima:signal": the value as JSON (number, boolean, array or object) or null.'), args: p('string[]', 'listener "dima:signal": the value split on spaces.'),
    user: p('DimaSignalUser | DimaUser | null', 'listeners "dima:signal", "dima:tts", "dima:reward", "dima:dimafx": who it came from.'), source: p('DimaSignalSource | string', 'listener "dima:signal": what sent it; "dima:dimafx": how it was paid.'),
    poll: p('DimaPoll | null', 'listener "dima:polls": the current poll.'), prediction: p('DimaPoll | null', 'listener "dima:polls": the current prediction.'),
    goals: p('DimaGoal[]', 'listener "dima:goals": the goals.'), phase: p('string', 'listener "dima:tts": start or end.'), text: p('string', 'listener "dima:tts": spoken text.'),
    reason: p('string | null', 'listener "dima:tts": how it finished.'), triggerId: p('string', 'listener "dima:trigger": the trigger.'), mediaType: p('string', 'listener "dima:trigger": its media.'),
    reward: p('{ id: string; title: string; cost: number }', 'listener "dima:reward": the reward.'), input: p('string | null', 'listener "dima:reward": viewer text.'), test: p('boolean', 'A Studio test.'),
    kind: p('string', 'listener "dima:pet": talk, ask or tts.'), mood: p('string | null', 'listener "dima:pet": its mood.'), result: p('string | null', 'listener "dima:pet": how it finished.'),
    challenger: p('string', 'listener "dima:duel": who challenged.'), opponent: p('string', 'listener "dima:duel": who was challenged.'), mode: p('string', 'listener "dima:duel": overlay or chat.'),
    winner: p('string | null', 'listener "dima:duel": the winner (ended).'), loser: p('string | null', 'listener "dima:duel": the loser (ended).'), endsAt: p('number | null', 'listeners "dima:duel", "dima:roulette": when it ends (ms).'),
    rouletteId: p('string', 'listener "dima:roulette": the roulette.'), label: p('string | null', 'listener "dima:roulette": what it landed on (result).'),
    item: p('{ id: string; name: string; type: string }', 'listener "dima:dimafx": the item.'), bits: p('number | null', 'listener "dima:dimafx": Bits paid.'), credits: p('number | null', 'listener "dima:dimafx": credits paid.'),
    target: p('string | null', 'listener "dima:signal": layer name for widget.signal.to.'),
    hypetrain: p('DimaHypeTrain | null', 'listener "dima:hypetrain": the hype train (null when none).'),
    active: p('DimaAdBreak | null', 'listener "dima:ads": the running ad break.'), schedule: p('DimaAdSchedule | null', 'listener "dima:ads": the ad schedule.')
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
  DimaState: "{ name: 'polls'; value: DimaPolls } | { name: 'goals'; value: DimaGoal[] } | { name: 'hypetrain'; value: DimaHypeTrain | null } | { name: 'ads'; value: DimaAds }",
  DimaStates: "{ polls: DimaPolls; goals: DimaGoal[]; hypetrain: DimaHypeTrain | null; ads: DimaAds }",
  DimaPart: "{ type: 'text'; text: string } | { type: 'emote'; text: string; id: string; animated: boolean; images: DimaImages } | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number } | { type: 'mention'; text: string; user: DimaUser }",
  SEListener: "'message' | 'delete-message' | 'delete-messages' | 'follower-latest' | 'subscriber-latest' | 'cheer-latest' | 'raid-latest' | 'tip-latest' | 'widget-button' | 'kvstore:update' | 'dima:signal' | 'dima:polls' | 'dima:goals' | 'dima:tts' | 'dima:trigger' | 'dima:reward' | 'dima:pet' | 'dima:duel' | 'dima:roulette' | 'dima:dimafx' | 'dima:hypetrain' | 'dima:ads'",
};

/** Dima SDK events: payload type and the widget.json `uses` entry needed to receive them. */
export const DIMA_EVENTS: { name: string; type: string; uses: string | null; doc: string }[] = [
  { name: 'chat', type: 'DimaChat', uses: 'chat', doc: 'A chat message.' },
  { name: 'chat.delete', type: 'DimaChatDelete', uses: 'chat', doc: 'A moderator deleted a message.' },
  { name: 'chat.clear', type: 'DimaChatClear', uses: 'chat', doc: 'One user\'s messages or the whole chat was cleared.' },
  { name: 'alert', type: 'DimaAlert', uses: 'alerts', doc: 'Follow, sub, resub, gift, Bits, raid or tip.' },
  { name: 'button', type: 'DimaButton', uses: null, doc: 'A settings button was pressed in Studio.' },
  { name: 'fields', type: 'WidgetFields', uses: null, doc: 'Settings changed in Studio (no reload).' },
  { name: 'storage', type: 'DimaStorageUpdate', uses: 'storage', doc: 'A saved value changed.' },
  { name: 'session', type: 'DimaSession', uses: 'session', doc: 'Recent events and totals changed.' },
  { name: 'signal', type: 'DimaSignal', uses: 'signals', doc: 'A chat command sent a signal: $(widget.signal name value). Use \'signal:name\' for one name.' },
  { name: 'state', type: 'DimaState', uses: null, doc: 'Live state changed ({ name, value }); Dima.state(name, …) is the easy way. Needs "polls", "goals", "hypetrain" or "ads" in uses.' },
  { name: 'tts', type: 'DimaTts', uses: 'tts', doc: 'A text-to-speech message started or finished.' },
  { name: 'trigger', type: 'DimaTrigger', uses: 'triggers', doc: 'A trigger alert was sent to the overlay.' },
  { name: 'reward', type: 'DimaReward', uses: 'rewards', doc: 'A channel-point reward was redeemed.' },
  { name: 'pet', type: 'DimaPet', uses: 'pets', doc: 'The pet started or finished a reply.' },
  { name: 'duel', type: 'DimaDuel', uses: 'duels', doc: 'A duel started or ended.' },
  { name: 'roulette', type: 'DimaRoulette', uses: 'roulette', doc: 'A roulette spin started, then its result.' },
  { name: 'dimafx', type: 'DimaDimafx', uses: 'dimafx', doc: 'A DimaFX item was bought and is playing.' }
];
/** Dima.state('…') names and their value types. */
export const STATE_REFS: { name: string; type: string; doc: string }[] = [
  { name: 'polls', type: 'DimaPolls', doc: 'The current Twitch poll and prediction. Needs "polls" in widget.json uses.' },
  { name: 'goals', type: 'DimaGoal[]', doc: 'Goals with progress: the Goals page, or Twitch goals when the layer is set to them. Needs "goals" in widget.json uses.' },
  { name: 'hypetrain', type: 'DimaHypeTrain | null', doc: 'The running hype train (or the last one until its cooldown ends); null when none. Needs "hypetrain" in widget.json uses.' },
  { name: 'ads', type: 'DimaAds', doc: 'The running ad break and the ad schedule. Needs "ads" in widget.json uses.' }
];
/** `Dima.on('signal:feed', …)`: one signal by name. */
export const SIGNAL_EVENT = /^signal:([a-z0-9_]{1,40})$/;
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
  { name: 'kvstore:update', doc: 'A saved value changed (event.data.key, event.data.value).' },
  { name: 'dima:signal', doc: 'A chat command sent a signal (event.name, event.value, event.user). Needs "signals" in widget.json uses.' },
  { name: 'dima:polls', doc: 'The current Twitch poll/prediction changed (event.poll, event.prediction). Needs "polls" in widget.json uses.' },
  { name: 'dima:goals', doc: 'Goals changed (event.goals). Needs "goals" in widget.json uses.' },
  { name: 'dima:tts', doc: 'A TTS message started or finished (event.phase, event.text, event.user). Needs "tts" in widget.json uses.' },
  { name: 'dima:trigger', doc: 'A trigger alert was sent (event.name, event.mediaType). Needs "triggers" in widget.json uses.' },
  { name: 'dima:reward', doc: 'A channel-point reward was redeemed (event.reward, event.user, event.input). Needs "rewards" in widget.json uses.' },
  { name: 'dima:pet', doc: 'The pet started or finished a reply (event.phase, event.text, event.mood). Needs "pets" in widget.json uses.' },
  { name: 'dima:duel', doc: 'A duel started or ended (event.phase, event.challenger, event.opponent, event.winner). Needs "duels" in widget.json uses.' },
  { name: 'dima:roulette', doc: 'A roulette spin started or finished (event.phase, event.name, event.label). Needs "roulette" in widget.json uses.' },
  { name: 'dima:dimafx', doc: 'A DimaFX item was bought (event.item, event.bits, event.user). Needs "dimafx" in widget.json uses.' },
  { name: 'dima:hypetrain', doc: 'The hype train changed (event.hypetrain; null when none). Needs "hypetrain" in widget.json uses.' },
  { name: 'dima:ads', doc: 'An ad break started or ended, or the ad schedule changed (event.active, event.schedule). Needs "ads" in widget.json uses.' }
];

/** widget.json keys and values. */
export const MANIFEST_KEYS: { name: string; doc: string; values?: readonly string[] }[] = [
  { name: 'engine', doc: '"dima" (Dima SDK) or "streamelements" (StreamElements layer).', values: ['dima', 'streamelements'] },
  { name: 'api', doc: 'SDK version the code was written for: 1.' },
  { name: 'name', doc: 'Widget name (used on import).' },
  { name: 'author', doc: 'Who made it.' },
  { name: 'version', doc: 'Your version text, e.g. "1.0.0".' },
  { name: 'description', doc: 'One line about what it does.' },
  { name: 'uses', doc: 'Live data the widget may read.', values: WIDGET_USES },
  { name: 'signals', doc: 'Signals your code listens for. Studio shows each one as a ready-to-paste command: [{ "name": "feed", "description": "Feed the pet", "values": ["pizza"] }].' }
];
export const USES_DOCS: Record<string, string> = {
  chat: 'Chat messages, deletes and clears.', alerts: 'Follows, subs, gifts, Bits, raids and tips.', storage: 'Saved values (Dima.storage / SE_API.store).',
  counters: 'Bot command counters.', session: 'Recent events and totals.', signals: 'Signals from chat commands: $(widget.signal name value).',
  polls: 'Live Twitch polls and predictions (totals only).', goals: 'Goals from the Goals page (or the streamer\'s Twitch goals) with live progress.', tts: 'Text-to-speech messages starting and finishing.',
  triggers: 'Trigger alerts sent to the overlay.', rewards: 'Channel-point redemptions.', pets: 'The pet speaking.', duels: 'Duels starting and ending.',
  roulette: 'Roulette spins and results.', dimafx: 'DimaFX purchases playing.', hypetrain: 'Hype trains (level, progress, top contributors).',
  ads: 'Ad breaks and the ad schedule.'
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
