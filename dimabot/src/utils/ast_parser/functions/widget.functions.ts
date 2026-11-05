import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { nextWidgetSignal } from '../effects.js';
import { buildSignal, signalError, widgetSignals } from '../../../widget_feed/signals.js';
import type { DimaSignal } from '../../../widget_feed/types.js';

type Actor = NonNullable<Exclude<ReturnType<typeof nextWidgetSignal>, 'limit'>>['actor'];
/** Roles from the signed chat badges of the verified sender (never the authored body's elevated identity). */
function signalUser(actor: Actor, channel: string): DimaSignal['user'] {
  // Twitch events have no chat badges. Anonymous ones (e.g. anonymous Bits) fall back to the channel ID as their actor,
  // which must never read as the broadcaster: no user then, and no roles for event senders.
  if (!actor.chat) return !actor.userId || actor.userId === channel ? null
    : { id: actor.userId, login: actor.displayName.toLowerCase(), name: actor.displayName, roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } };
  const badges = new Set((actor.chat?.badges ?? []).map(badge => badge.set_id));
  return { id: actor.userId, login: actor.chat?.login ?? actor.displayName.toLowerCase(), name: actor.displayName, roles: {
    broadcaster: actor.userId === channel, moderator: badges.has('moderator') || badges.has('lead_moderator'),
    vip: badges.has('vip'), subscriber: badges.has('subscriber') || badges.has('founder') } };
}

/** `$(widget.signal name value…)` / `$(widget.signal.to "layer" name value…)`: silent; widgets decide what it means. */
export function widgetSignalHandler(targeted: boolean): FunctionHandler {
  return async (args, ctx) => {
    // Like pet actions: only authored command/keyword/event bodies from verified Twitch ingress. AI requests,
    // timers and generic renders can't send (they carry no effect authority).
    if (ctx.enforceFunctionPermissions !== false || ctx.authorization?.origin !== 'authored' || (ctx.timerDepth ?? 0) > 0 || ctx.platform !== 'twitch') return 'Error: widget_signal_context_required';
    const values = args.map(arg => String(arg ?? ''));
    const target = targeted ? (values.shift() ?? '').trim() : null;
    const name = (values.shift() ?? '').trim().toLowerCase();
    // `pet.feed` reaches us as "pet" + "." + "feed" (the parser splits dots). Handlers only see evaluated values, so a
    // lone "." (e.g. a viewer's &p1) stays a value; only "." followed by more name is a dotted name. (A hyphenated name
    // looks exactly like a viewer value such as "-5", so only the docs and Studio's validated snippets guard that.)
    if (values[0] === '.' && /^[a-z0-9_]/i.test(values[1] ?? '')) return 'Error: invalid_widget_signal_name';
    const value = values.join(' ').trim();
    const invalid = signalError(name, value, target);
    if (invalid) return `Error: ${invalid}`;
    const identity = nextWidgetSignal(ctx.effectContext, ctx.broadcasterId);
    if (!identity) return 'Error: widget_signal_context_required';
    if (identity === 'limit') { await widgetSignals.countSkipped(ctx.broadcasterId); return ''; }
    // Keywords run as commands named `keyword:<id>`; their readable name is the first scope alias.
    const keyword = String(ctx.scopeName || '').startsWith('keyword:');
    const kind = identity.origin.kind === 'chat-command' ? (keyword ? 'keyword' : 'command') : 'event';
    const sourceName = keyword ? ctx.scopeAliases?.[0] ?? '' : ctx.commandName || ctx.scopeName || '';
    await widgetSignals.publish(ctx.broadcasterId, buildSignal({ name, value, target, user: signalUser(identity.actor, ctx.broadcasterId),
      source: { kind, name: String(sourceName).slice(0, 80) } }), identity.actionKey);
    return '';
  };
}

export function registerWidgetFunctions(): void {
  const common = { category: 'overlay', planTier: 'free' as const, surfaces: ['authoring' as const],
    keywords: ['widget', 'custom widget', 'overlay', 'overlay studio', 'signal', 'señal', 'widget personalizado', 'mascota', 'pet', 'comando'] };
  const where = 'Works in Twitch chat commands, keywords and event actions (not timers, channel-point rewards or AI requests). Widgets receive it when their widget.json uses "signals". Silent in chat.';
  registerFunction('widget.signal', widgetSignalHandler(false), { ...common,
    description: `Sends a named signal with an optional value to the channel's Overlay Studio custom widgets; the widget's code decides what it does (a pet eats, a wheel spins, colours change). ${where} Names: letters, digits and _ (max 40); value up to 500 characters.`,
    syntax: 'widget.signal name value', examples: ['widget.signal hype', 'widget.signal feed &p1', 'widget.signal theme night'] });
  registerFunction('widget.signal.to', widgetSignalHandler(true), { ...common,
    description: `Like widget.signal, but only custom widget layers with this name react (quote names with spaces; published names count). ${where}`,
    syntax: 'widget.signal.to "layer name" name value', examples: ['widget.signal.to "Chat box" focus on', 'widget.signal.to Wheel spin'] });
}
