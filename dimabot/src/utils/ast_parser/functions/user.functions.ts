import type { ExecutionContext } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import * as ChatFunctions from '../../../functions/chats/index.js';
import { getRandomUserBlacklist } from '../randomuser_settings.js';

function sanitizeInput(input: unknown): string {
    if (typeof input !== 'string') return String(input || '');
    return input
        .replace(/\$/g, '\\$')
        .replace(/%/g, '\\%')
        .replace(/\*/g, '\\*');
}

function getUserName(ctx: ExecutionContext): string {
    const eventData = ctx.eventData as Record<string, unknown> | undefined;
    
    if (eventData?.chatter_user_name) {
        return String(eventData.chatter_user_name);
    }
    if (eventData?.chatter_user_login) {
        return String(eventData.chatter_user_login);
    }
    if (ctx.extraContext?.userName) {
        return String(ctx.extraContext.userName);
    }
    if (ctx.extraContext?.userLogin) {
        return String(ctx.extraContext.userLogin);
    }
    return ctx.userDisplayName || ctx.userLogin || '';
}

/**
 * Optional character filters supported by `$(user ignore ...)`.
 *
 * - `symbols`  removes every character that is not a Unicode letter, combining
 *   mark or number (underscores, punctuation, emoji, whitespace, ...). The
 *   characters are dropped without inserting spaces.
 * - `numbers`  removes Unicode numeric characters (decimal digits, other
 *   numeric forms such as roman numerals, ...).
 *
 * Both filters can be combined and given in any order. Letters and combining
 * marks always survive, and the casing of the name is preserved.
 */
type UserNameFilter = 'symbols' | 'numbers';

interface UserNameFilterPlan {
    removeSymbols: boolean;
    removeNumbers: boolean;
}

const USER_NAME_FILTERS: Record<string, UserNameFilter> = {
    symbols: 'symbols',
    numbers: 'numbers'
};

// Unicode-aware character classes. No `g` flag: `test` must stay stateless.
const NUMERIC_CHARACTER = /\p{N}/u;
const LETTER_OR_NUMBER_CHARACTER = /[\p{L}\p{N}]/u;
const LETTER_MARK_OR_NUMBER_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

/**
 * Splits the raw arguments into lowercase tokens. Arguments arrive either as
 * separate tokens (`$(user ignore symbols numbers)`) or as a single quoted
 * string (`$(user "ignore symbols numbers")`), so both shapes are flattened.
 */
function flattenArgumentTokens(args: unknown[]): string[] {
    const tokens: string[] = [];
    if (!Array.isArray(args)) return tokens;

    for (const arg of args) {
        const text = typeof arg === 'string' ? arg : String(arg ?? '');
        for (const part of text.trim().split(/\s+/)) {
            if (part) tokens.push(part.toLowerCase());
        }
    }

    return tokens;
}

/**
 * Parses the `ignore` filter syntax. Returns null for anything that is not a
 * recognized filter list (missing `ignore`, unknown option, no option at all)
 * so the caller keeps the previous raw-name behavior.
 */
function parseUserNameFilter(args: unknown[]): UserNameFilterPlan | null {
    const tokens = flattenArgumentTokens(args);
    if (tokens.length < 2) return null;
    if (tokens[0] !== 'ignore') return null;

    const plan: UserNameFilterPlan = { removeSymbols: false, removeNumbers: false };
    let optionCount = 0;

    for (const token of tokens.slice(1)) {
        if (!Object.hasOwn(USER_NAME_FILTERS, token)) return null;
        const filter = USER_NAME_FILTERS[token];
        if (!filter) return null;
        if (filter === 'symbols') plan.removeSymbols = true;
        else plan.removeNumbers = true;
        optionCount++;
    }

    return optionCount > 0 ? plan : null;
}

function applyUserNameFilters(name: string, plan: UserNameFilterPlan): string {
    let filtered = '';

    for (const character of name) {
        if (plan.removeSymbols && !LETTER_MARK_OR_NUMBER_CHARACTER.test(character)) continue;
        if (plan.removeNumbers && NUMERIC_CHARACTER.test(character)) continue;
        filtered += character;
    }

    return filtered;
}

const userHandler: FunctionHandler = async (args, ctx) => {
    const name = getUserName(ctx);
    const plan = parseUserNameFilter(args);
    if (!plan) return name;

    const filtered = applyUserNameFilters(name, plan);
    // A name made only of symbols (or only of digits) has no usable content
    // left, so the caller falls back to a neutral label.
    if (!LETTER_OR_NUMBER_CHARACTER.test(filtered)) return 'viewer';

    return filtered;
};

const touserHandler: FunctionHandler = async (args, ctx) => {
    const target = args[0] || ctx.argument;
    if (target) {
        return sanitizeInput(target);
    }
    return getUserName(ctx);
};

const randomuserHandler: FunctionHandler = async (args, ctx) => {
    const tokens = flattenArgumentTokens(args).flatMap(token => token.split(',')).filter(Boolean);
    const ignoreIndex = tokens.indexOf('ignore');
    const options = ignoreIndex < 0 ? tokens : tokens.slice(0, ignoreIndex);
    const unique = options.includes('unique');
    const local = options.includes('local');
    const excluded = new Set((ignoreIndex < 0 ? [] : tokens.slice(ignoreIndex + 1)).map(name => name.replace(/^@/, '')));
    if (!local) {
        try {
            ctx.randomUserState.blacklist ??= getRandomUserBlacklist(ctx.broadcasterId);
            for (const name of await ctx.randomUserState.blacklist) excluded.add(name.toLowerCase());
        } catch {
            return '<unable to load randomuser blacklist>';
        }
    }
    const chattersResult = await ChatFunctions.getChatters(ctx.broadcasterId, ctx.broadcasterId);
    if (chattersResult.error) {
        return chattersResult.message;
    }
    if ((!chattersResult.chatters || chattersResult.chatters.length === 0) && !unique && excluded.size === 0) {
        return getUserName(ctx) || 'Unknown';
    }
    const eligible = (chattersResult.chatters ?? []).filter(chatter => {
        const login = String(chatter.user_login || '').toLowerCase();
        const display = String(chatter.user_name || '').toLowerCase();
        const identity = login || display;
        return identity && !excluded.has(login) && !excluded.has(display) && (!unique || !ctx.randomUserState.selected.has(identity));
    });
    if (!eligible.length) return '<no eligible chatters>';
    const randomChatter = eligible[Math.floor(Math.random() * eligible.length)];
    ctx.randomUserState.selected.add(String(randomChatter.user_login || randomChatter.user_name).toLowerCase());
    return randomChatter.user_name || randomChatter.user_login || 'Unknown';
};

export function registerUserFunctions(): void {
    registerFunction('user', userHandler, {
        description: 'Returns the username of the caller / current chatter. Optional "ignore" filters strip characters from that name: "symbols" removes every character that is not a letter, combining mark or number, "numbers" removes numeric characters. Both filters can be combined in any order, and the name keeps its casing. Returns "viewer" when the filters leave no letters or numbers.',
        syntax: 'user [ignore [symbols] [numbers]]',
        category: 'user',
        examples: ['user', 'user ignore symbols', 'user ignore numbers', 'user ignore symbols numbers'],
        keywords: ['caller', 'username', 'who', 'usuario', 'nombre', 'quien', 'ignore', 'filter', 'symbols', 'numbers', 'filtrar', 'simbolos', 'numeros']
    });
    registerFunction('touser', touserHandler, {
        description: 'Returns the target username from the first argument; falls back to the caller when no argument is given.',
        syntax: 'touser [target]',
        category: 'user',
        examples: ['touser', 'touser $(randomuser)'],
        keywords: ['target', 'argument', 'objetivo', 'destinatario']
    });
    registerFunction('randomuser', randomuserHandler, {
        description: 'Returns a random chatter, excluding the channel blacklist. Use unique to avoid earlier picks in this execution, ignore followed by logins for additional exclusions, or local to replace the shared blacklist with only those exclusions. Returns a placeholder if no eligible chatter remains.',
        syntax: 'randomuser [unique] [local] [ignore login ...]',
        category: 'user',
        examples: ['randomuser', 'randomuser unique', 'randomuser unique ignore nightbot', 'randomuser unique local ignore nightbot'],
        keywords: ['random chatter', 'random viewer', 'usuario aleatorio', 'alguien random']
    });
}
