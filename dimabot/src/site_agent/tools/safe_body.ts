/**
 * Safe-body guard for changes that apply without an approval card (MCP v1). Command-language text passes only if
 * every function it can call, in every nested argument, both branches of a condition, loops, templates, array
 * items, indexes and viewer selectors, is in SAFE_FUNCTIONS: functions that compute a value or produce the reply's
 * own text. Everything else is refused: moderation, Twitch/stream changes, TTS/pet/trigger/overlay/widget/goal
 * progress/roulette effects, AI, timers and delays, command or reward on/off, running other commands (`#(name)`),
 * unknown functions, syntax it can't check and text that does not parse. Static: nothing runs.
 *
 * It checks exactly what the runtime evaluates: the renderer's own top-level segments (`render.ts`
 * scanSourceSegments, which ignores quotes outside an expression), each parsed like the renderer parses it, and that
 * for the text as stored and as `&t`/`&pN` placeholders turn it before rendering (bound to variables, or removed when
 * a timer or event message renders without an argument, which can join text into a new expression).
 *
 * The refusal reasons come from `effects.ts` (FUNCTION_EFFECTS) and the AST catalog (generated from the function
 * registry). Variables (`%(…)`, `*(…)` logic and math, `^(…)`, `%del(…)`) are allowed: they are the command's own
 * state, like counters, and never reach Twitch. The registry has no time or uptime function today.
 */
import { parse } from '../../utils/ast_parser/parser.js';
import { scanSourceSegments } from '../../utils/ast_parser/render.js';
import { resolveArgumentPlaceholders } from '../../handlers/special_parser.handler.js';
import type { ArrayAccessor, AstNode } from '../../utils/ast_parser/types.js';
import { findAstCatalogEntry } from '../../utils/ai/ast_catalog/index.js';
import { functionEffect } from './effects.js';

export type SafeBodyResult = { ok: true } | { ok: false; reason: string };

/** The audited allowlist (exact registry names; the evaluator matches names exactly), one reason each. */
export const SAFE_FUNCTIONS: Readonly<Record<string, string>> = {
    // Names and arguments
    user: 'the caller\'s name',
    touser: 'the name typed after the command (or the caller)',
    randomuser: 'a random chatter\'s name (reads the chatter list)',
    // Random and counters
    random: 'a random number',
    count: 'the command\'s own use counter',
    scount: 'the command\'s own use counter, +1',
    bits: 'Bits of the cheer that ran it',
    // Values of the event that ran it (chat events, Bits rules, rewards)
    'cheer.amount': 'event value', 'cheer.message': 'event value', 'sub.tier': 'event value', 'sub.months': 'event value',
    'gifted.user': 'event value', 'raid.channel': 'event value', 'raid.login': 'event value', 'raid.viewers': 'event value',
    'ad.time': 'event value', ad: 'event value (alias of ad.time)', 'ban.time': 'event value', 'twitch.modiversary': 'event value',
    'twitch.streak': 'event value', 'hypetrain.progress': 'event value', 'hypetrain.level': 'event value', 'hypetrain.end': 'event value',
    'shoutout.channel': 'event value', 'reward.input': 'event value', 'redemption.input': 'event value (alias of reward.input)',
    // Read-only Twitch lookups
    'twitch.live': 'reads live status', 'twitch.subs': 'reads the sub count', 'twitch.title': 'reads the title', 'twitch.game': 'reads the category',
    'twitch.viewers': 'reads the viewer count', 'twitch.follows': 'reads the follower count', 'twitch.channel': 'reads a display name',
    'twitch.login': 'reads a login', followage: 'reads how long someone follows', 'get.poll': 'reads the current poll', 'get.prediction': 'reads the current prediction',
    // Text helpers
    upper: 'text', lower: 'text', title: 'text', capitalize: 'text', trim: 'text', length: 'text', slice: 'text', replace: 'text',
    // Loop control
    break: 'loop control', continue: 'loop control',
};

const SAFE = new Set(Object.keys(SAFE_FUNCTIONS));

/** Why a refused function is risky, by AST catalog category (when effects.ts has no line for it). */
const CATEGORY_REASONS: Record<string, string> = {
    moderation: 'moderates chat', channel: 'changes the stream or channel on Twitch', availability: 'turns commands or rewards on or off',
    tts: 'uses TTS on stream', pet: 'makes the pet talk on stream', trigger: 'plays triggers on stream', overlay: 'acts on the overlay or its widgets',
    clip: 'creates or shows clips', roulette: 'changes, shows or spins roulettes', goals: 'adds progress to a goal', ai: 'writes replies with AI',
    flow: 'schedules or delays actions', chat: 'sends extra chat messages or announcements', pin: 'pins chat messages', defense: 'controls Follow Defense',
};

/** A body is at most a few thousand characters; this only bounds pathological input. */
const MAX_NODES = 20_000;

function refusal(name: string): string {
    const effect = functionEffect(name);
    if (effect) return `$(${name}): ${effect.charAt(0).toLowerCase()}${effect.slice(1)}`;
    const entry = findAstCatalogEntry(name);
    if (!entry || !name) return `$(${name}) is not a known function`;
    return `$(${name}) ${CATEGORY_REASONS[entry.category] ?? 'is not one of the reply functions allowed here'}`;
}

function accessorNode(accessor: ArrayAccessor | undefined): AstNode[] {
    return accessor && 'index' in accessor ? [accessor.index] : [];
}

/** The first unsafe construct in a parsed body, or null. Walks every child (iteratively, so deep nesting can't overflow). */
export function findUnsafe(root: AstNode): string | null {
    const stack: AstNode[] = [root];
    let seen = 0;
    while (stack.length) {
        const node = stack.pop()!;
        if (++seen > MAX_NODES) return 'the text is too long to check';
        switch (node.type) {
            case 'literal': case 'loopVar': break;
            case 'root': stack.push(...node.children); break;
            case 'function':
                if (!SAFE.has(node.name)) return refusal(node.name);
                stack.push(...node.args);
                break;
            case 'commandRef': return `#(${node.commandName}) runs another command`;
            case 'template': for (const segment of node.segments) if (segment.type === 'expr') stack.push(segment.node); break;
            case 'setVar': stack.push(node.value, ...accessorNode(node.accessor), ...(node.userSelector ? [node.userSelector] : [])); break;
            case 'getVar': case 'exists': case 'deleteVar': stack.push(...accessorNode(node.accessor), ...(node.userSelector ? [node.userSelector] : [])); break;
            case 'binary': stack.push(node.left, node.right); break;
            case 'unary': stack.push(node.argument); break;
            case 'ternary': stack.push(node.test, node.consequent, node.alternate); break;
            case 'arrayLiteral': stack.push(...node.items, ...accessorNode(node.accessor)); break;
            case 'forLoop': stack.push(...[node.init, node.condition, node.update, node.iterable].filter((part): part is AstNode => Boolean(part)), ...node.body); break;
            case 'loopAssign': if (node.value) stack.push(node.value); break;
            default: return 'it uses syntax that can\'t be checked here';
        }
    }
    return null;
}

/** The first unsafe expression in text as the renderer splits and parses it, or null. */
function unsafeRendered(text: string): string | null {
    for (const segment of scanSourceSegments(text)) {
        if (segment.kind === 'text') continue;
        if (segment.kind === 'unclosed') return 'an expression is never closed';
        const { ast, error } = parse(segment.source);
        if (error) return `the text does not parse (${error})`;
        const reason = findUnsafe(ast);
        if (reason) return reason;
    }
    return null;
}

/** Checks one command-language text (a command reply, timer message, event message, winner or goal action). */
export function checkSafeBody(text: string): SafeBodyResult {
    if (typeof text !== 'string') return { ok: false, reason: 'it is not text' };
    if (!text.trim()) return { ok: true };
    const variants = new Set([text, resolveArgumentPlaceholders(text, '', true).text, resolveArgumentPlaceholders(text, '', false).text]);
    for (const variant of variants) {
        const reason = unsafeRendered(variant);
        if (reason) return { ok: false, reason };
    }
    return { ok: true };
}
