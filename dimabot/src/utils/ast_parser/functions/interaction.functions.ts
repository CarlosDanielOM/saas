/**
 * Read-only `poll.*` and `prediction.*` functions: small pieces a command can combine (loop over the
 * options, compare votes, break a tie with a roulette). They all answer from one shared snapshot
 * (`utils/twitch_interactions.ts`), read once per command run, so values in the same command never disagree.
 *
 * Reads never return error text: a failed read is empty text (and `status` says `unavailable`), so a
 * loop or a condition built on them does nothing instead of acting on an error message.
 */
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { FunctionMetadata } from '../types.js';
import {
    eventSnapshot, findOption, leaders, payloadSnapshot, readInteraction,
    type InteractionKind, type InteractionSnapshot
} from '../../twitch_interactions.js';

type Read = (snapshot: InteractionSnapshot, argument: string) => string;

const list = (values: Array<string | number>) => values.length ? JSON.stringify(values) : '';
/** A canceled poll or prediction keeps its options and numbers, but has no result. */
const hasResult = (snapshot: InteractionSnapshot) => snapshot.status === 'active' || snapshot.status === 'locked' || snapshot.status === 'ended';

const shared: Record<string, Read> = {
    title: snapshot => snapshot.title,
    status: snapshot => snapshot.status,
    options: snapshot => list(snapshot.options.map(option => option.title)),
    values: snapshot => list(snapshot.options.map(option => option.value)),
    total: snapshot => String(snapshot.options.reduce((sum, option) => sum + option.value, 0)),
};
/** One option's number, by title or position. Empty for no or an unknown option: `$(poll.votes $(poll.result))` on a tie stays blank. */
const optionValue = (pick: (option: { value: number; users: number }) => number): Read => (snapshot, argument) => {
    const option = findOption(snapshot, argument);
    return option ? String(pick(option)) : '';
};

const POLL: Record<string, Read> = {
    ...shared,
    votes: optionValue(option => option.value),
    /** The single leader (the winner once it ended). Empty on a tie, and when nobody voted. */
    result: snapshot => {
        if (!hasResult(snapshot)) return '';
        const top = leaders(snapshot);
        return top.length === 1 ? top[0].title : '';
    },
    /** The options sharing first place, or empty text (false) when there is one leader. */
    tied: snapshot => {
        if (!hasResult(snapshot)) return '';
        const top = leaders(snapshot);
        return top.length > 1 ? list(top.map(option => option.title)) : '';
    },
};
const PREDICTION: Record<string, Read> = {
    ...shared,
    points: optionValue(option => option.value),
    users: optionValue(option => option.users),
    /** The winning outcome the streamer chose; empty until it is resolved. */
    result: snapshot => snapshot.status === 'ended'
        ? snapshot.options.find(option => option.id === snapshot.winnerId)?.title ?? '' : '',
};

/**
 * The snapshot every `poll.*` (or `prediction.*`) function of this run answers from. It is taken
 * once: a vote arriving between two functions cannot make a condition and the action after it
 * disagree. In a poll or prediction chat event ("Poll ended"), and in commands it references, it
 * is that event's own numbers, even if another poll has started since.
 */
export function runSnapshot(ctx: Parameters<FunctionHandler>[1], kind: InteractionKind): Promise<InteractionSnapshot> {
    const key = `interaction:${kind}`;
    const known = ctx.sharedReads?.get(key) as Promise<InteractionSnapshot> | undefined;
    if (known) return known;
    // The event type is known in the chat event itself; a command it references with #(name) carries the payload only.
    const eventType = String((ctx.eventsubData as { type?: unknown } | undefined)?.type ?? '');
    const fromEvent = eventType.startsWith(`channel.${kind}.`) ? eventSnapshot(eventType, ctx.eventData, Date.now())
        : eventType ? null : payloadSnapshot(kind, ctx.eventData, Date.now());
    const snapshot = fromEvent ? Promise.resolve(fromEvent) : readInteraction(String(ctx.broadcasterId || ''), kind);
    ctx.sharedReads?.set(key, snapshot);
    return snapshot;
}

function handler(kind: InteractionKind, read: Read): FunctionHandler {
    return async (args, ctx) => read(await runSnapshot(ctx, kind), args.map(value => String(value ?? '')).join(' ').trim());
}

const POLL_METADATA: Record<string, Omit<FunctionMetadata, 'category'>> = {
    title: {
        description: 'Returns the question of the running poll, or of the latest poll when none is running.',
        syntax: 'poll.title', examples: ['poll.title'],
        keywords: ['poll question', 'poll title', 'pregunta encuesta']
    },
    status: {
        description: 'Returns the state of the latest poll: active, ended, canceled, none (no poll yet) or unavailable (Twitch could not be read). A poll ended early on Twitch counts as ended; a poll stopped with cancel.poll or deleted on Twitch counts as canceled.',
        syntax: 'poll.status', examples: ['poll.status'],
        keywords: ['poll status', 'poll running', 'poll ended', 'estado encuesta']
    },
    options: {
        description: 'Returns the options of the latest poll as a list, in Twitch order. Loop over it with *(for #o in $(poll.options) { ... }).',
        syntax: 'poll.options', examples: ['poll.options'],
        keywords: ['poll options', 'poll choices', 'opciones encuesta']
    },
    values: {
        description: 'Returns the vote counts of the latest poll as a list, in the same order as poll.options. Counts include Channel Points votes.',
        syntax: 'poll.values', examples: ['poll.values'],
        keywords: ['poll votes list', 'vote counts', 'votos encuesta']
    },
    votes: {
        description: 'Returns the votes of one option of the latest poll, by its exact title or its number (starting at 1). Empty when no option is given or it does not exist.',
        syntax: 'poll.votes option', examples: ['poll.votes Pizza', 'poll.votes 1'],
        keywords: ['option votes', 'votes for', 'votos de opcion']
    },
    total: {
        description: 'Returns the total number of votes of the latest poll (0 when nobody voted).',
        syntax: 'poll.total', examples: ['poll.total'],
        keywords: ['total votes', 'votos totales']
    },
    result: {
        description: 'Returns the option in first place of the latest poll: the current leader while it runs, the winner once it ended. Empty on a tie, when nobody voted, and for a canceled poll.',
        syntax: 'poll.result', examples: ['poll.result'],
        keywords: ['poll winner', 'poll leader', 'ganador encuesta', 'resultado encuesta']
    },
    tied: {
        description: 'Returns the options tied for first place in the latest poll as a list, or empty text when one option leads. Works as a condition (empty is false) and as a loop list. With no votes every option is tied; check poll.total first to treat that differently.',
        syntax: 'poll.tied', examples: ['poll.tied', 'roulette.fill polls $(poll.tied)'],
        keywords: ['poll tie', 'tied options', 'tie breaker', 'empate encuesta', 'desempate']
    },
};
const PREDICTION_METADATA: Record<string, Omit<FunctionMetadata, 'category'>> = {
    title: {
        description: 'Returns the question of the running prediction, or of the latest prediction when none is running.',
        syntax: 'prediction.title', examples: ['prediction.title'],
        keywords: ['prediction question', 'prediction title', 'pregunta prediccion']
    },
    status: {
        description: 'Returns the state of the latest prediction: active, locked (betting closed), ended (a winner was chosen), canceled (points refunded), none (no prediction yet) or unavailable (Twitch could not be read).',
        syntax: 'prediction.status', examples: ['prediction.status'],
        keywords: ['prediction status', 'prediction locked', 'estado prediccion']
    },
    options: {
        description: 'Returns the outcomes of the latest prediction as a list, in Twitch order. Loop over it with *(for #o in $(prediction.options) { ... }).',
        syntax: 'prediction.options', examples: ['prediction.options'],
        keywords: ['prediction options', 'prediction outcomes', 'opciones prediccion']
    },
    values: {
        description: 'Returns the Channel Points bet on each outcome of the latest prediction as a list, in the same order as prediction.options.',
        syntax: 'prediction.values', examples: ['prediction.values'],
        keywords: ['prediction points list', 'puntos prediccion']
    },
    points: {
        description: 'Returns the Channel Points bet on one outcome of the latest prediction, by its exact title or its number (starting at 1). Empty when no outcome is given or it does not exist.',
        syntax: 'prediction.points option', examples: ['prediction.points Yes', 'prediction.points 1'],
        keywords: ['outcome points', 'points bet', 'puntos apostados']
    },
    users: {
        description: 'Returns how many viewers bet on one outcome of the latest prediction, by its exact title or its number (starting at 1). Empty when no outcome is given or it does not exist.',
        syntax: 'prediction.users option', examples: ['prediction.users Yes', 'prediction.users 2'],
        keywords: ['outcome users', 'predictors', 'cuantos apostaron']
    },
    total: {
        description: 'Returns the total Channel Points bet in the latest prediction.',
        syntax: 'prediction.total', examples: ['prediction.total'],
        keywords: ['total points', 'puntos totales']
    },
    result: {
        description: 'Returns the winning outcome of the latest prediction once the streamer has chosen it. Empty while it runs and when it was canceled.',
        syntax: 'prediction.result', examples: ['prediction.result'],
        keywords: ['prediction winner', 'winning outcome', 'ganador prediccion', 'resultado prediccion']
    },
};

/** The pure reads behind each function, by kind and name (for tests). */
export const INTERACTION_READS: Record<InteractionKind, Record<string, Read>> = { poll: POLL, prediction: PREDICTION };

/** Registered names, for the command tester and checks. */
export const INTERACTION_READ_FUNCTIONS: readonly string[] = [
    ...Object.keys(POLL).map(name => `poll.${name}`),
    ...Object.keys(PREDICTION).map(name => `prediction.${name}`),
];

export function registerInteractionFunctions(): void {
    for (const [name, read] of Object.entries(POLL)) {
        registerFunction(`poll.${name}`, handler('poll', read), {
            ...POLL_METADATA[name], category: 'channel', minUserLevel: 1,
            keywords: ['poll', 'encuesta', ...(POLL_METADATA[name].keywords ?? [])]
        });
    }
    for (const [name, read] of Object.entries(PREDICTION)) {
        registerFunction(`prediction.${name}`, handler('prediction', read), {
            ...PREDICTION_METADATA[name], category: 'channel', minUserLevel: 1,
            keywords: ['prediction', 'prediccion', ...(PREDICTION_METADATA[name].keywords ?? [])]
        });
    }
}
