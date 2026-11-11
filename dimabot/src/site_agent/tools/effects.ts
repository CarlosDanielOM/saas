/**
 * What a command body can do, in plain words, for approval cards. The body runs through the
 * command tester (`utils/ast_parser/simulate.ts`: actions recorded, never performed) a few times,
 * as a viewer and a mod, with and without an argument, so random branches show up too.
 */
import type { Lang, PlanTier } from '../types.js';
import { parseSimulationInput, simulateCommand, SimulationInputError, type SimulationRunInput, type SimulationRunResult } from '../../utils/ast_parser/simulate.js';
import { findAstCatalogEntry } from '../../utils/ai/ast_catalog/index.js';

export interface CommandEffects {
    /** Plain-language things the body can do on stream/Twitch, e.g. "Can time out viewers". */
    effects: string[];
    /** Problems found by the dry run (parse errors, unknown functions, code printed as text). */
    problems: string[];
}

type Text = Record<Lang, string>;

/** In order of how much they matter to the streamer (moderation and Twitch changes first). */
const EFFECTS = {
    ban: { en: 'Can ban viewers', es: 'Puede dar ban a espectadores' },
    timeout: { en: 'Can time out viewers', es: 'Puede dar timeout a espectadores' },
    banMod: { en: 'Can time out or ban moderators (removes their Mod first)', es: 'Puede dar timeout o ban a moderadores (primero les quita el Mod)' },
    warn: { en: 'Can send viewers an official Twitch warning', es: 'Puede enviar advertencias oficiales de Twitch a espectadores' },
    clearChat: { en: 'Can clear the chat', es: 'Puede borrar el chat' },
    emoteOnly: { en: 'Can turn emote-only chat on or off', es: 'Puede activar o desactivar el chat solo con emotes' },
    mod: { en: 'Can give or remove Mod', es: 'Puede dar o quitar Mod' },
    vip: { en: 'Can give or remove VIP', es: 'Puede dar o quitar VIP' },
    raid: { en: 'Can start or cancel a raid', es: 'Puede iniciar o cancelar un raid' },
    defense: { en: 'Can switch Follow Defense to attack mode', es: 'Puede poner la Defensa contra follows en modo ataque' },
    permit: { en: 'Can let viewers skip the moderation filters for a while', es: 'Puede dejar que espectadores se salten los filtros de moderación por un rato' },
    title: { en: 'Changes the stream title', es: 'Cambia el título del stream' },
    category: { en: 'Changes the stream category', es: 'Cambia la categoría del stream' },
    prediction: { en: 'Can start, lock, end or cancel predictions', es: 'Puede iniciar, bloquear, terminar o cancelar predicciones' },
    poll: { en: 'Can start, end or cancel polls', es: 'Puede iniciar, terminar o cancelar encuestas' },
    commandToggle: { en: 'Turns commands on or off', es: 'Activa o desactiva comandos' },
    rewardToggle: { en: 'Turns channel point rewards on or off', es: 'Activa o desactiva recompensas de puntos del canal' },
    announce: { en: 'Posts announcements in chat', es: 'Publica anuncios en el chat' },
    shoutout: { en: 'Gives Twitch shoutouts', es: 'Da shoutouts de Twitch' },
    pin: { en: 'Pins or unpins chat messages', es: 'Fija o quita mensajes fijados del chat' },
    chat: { en: 'Sends extra chat messages', es: 'Envía mensajes extra al chat' },
    clipCreate: { en: 'Creates clips', es: 'Crea clips' },
    clipShow: { en: 'Shows clips on stream', es: 'Muestra clips en el stream' },
    tts: { en: 'Speaks on stream with TTS', es: 'Habla en el stream con TTS' },
    ttsVoice: { en: 'Changes the channel TTS voice', es: 'Cambia la voz de TTS del canal' },
    ttsControl: { en: 'Can skip, clear or reset TTS playback', es: 'Puede saltar, borrar o reiniciar la reproducción de TTS' },
    pet: { en: 'Makes the pet talk on stream', es: 'Hace que la mascota hable en el stream' },
    trigger: { en: 'Plays triggers (sounds, videos, images) on stream', es: 'Reproduce triggers (sonidos, videos, imágenes) en el stream' },
    overlayQueue: { en: 'Can skip, pause, resume or clear overlay alerts', es: 'Puede saltar, pausar, reanudar o borrar alertas del overlay' },
    widget: { en: 'Sends signals to Overlay Studio widgets', es: 'Envía señales a los widgets de Overlay Studio' },
    goal: { en: 'Adds progress to a goal', es: 'Suma progreso a una meta' },
    roulette: { en: 'Changes, shows or spins roulettes', es: 'Cambia, muestra o gira ruletas' },
    ai: { en: 'Writes replies with AI (uses AI credits)', es: 'Escribe respuestas con IA (usa créditos de IA)' },
    later: { en: 'Schedules messages or actions for later (the test run does not check them)', es: 'Programa mensajes o acciones para después (la prueba no los revisa)' },
} as const satisfies Record<string, Text>;

type EffectKey = keyof typeof EFFECTS;

const isSeconds = (value: string | undefined) => Boolean(value && /^\s*\d+\s*$/.test(value));

/** Canonical function name → effect. Functions not listed (and not quiet) get a generic line. */
const FUNCTION_EFFECTS: Record<string, EffectKey | ((args: string[]) => EffectKey)> = {
    ban: (args) => isSeconds(args[1]) ? 'timeout' : 'ban',
    'ban.self': (args) => isSeconds(args[0]) ? 'timeout' : 'ban',
    'ban.mod': 'banMod',
    warn: 'warn',
    'clear.chat': 'clearChat',
    emoteonly: 'emoteOnly',
    'add.mod': 'mod', unmod: 'mod',
    'add.vip': 'vip', unvip: 'vip',
    raid: 'raid', unraid: 'raid',
    permit: 'permit',
    'set.title': 'title',
    'set.game': 'category',
    'start.prediction': 'prediction', 'lock.prediction': 'prediction', 'end.prediction': 'prediction', 'cancel.prediction': 'prediction',
    'start.poll': 'poll', 'end.poll': 'poll', 'cancel.poll': 'poll',
    'enable.command': 'commandToggle', 'disable.command': 'commandToggle',
    'enable.redemption': 'rewardToggle', 'disable.redemption': 'rewardToggle',
    announce: 'announce',
    shoutout: 'shoutout',
    'pin.create': 'pin', 'pin.update': 'pin', 'pin.del': 'pin',
    'chat.send': 'chat',
    'create.clip': 'clipCreate',
    'show.clip': 'clipShow',
    tts: 'tts', 'tts.speak': 'tts', 'tts.clone': 'tts', 'tts.kokoro': 'tts',
    'set.voice': 'ttsVoice',
    'tts.skip': 'ttsControl', 'tts.clear': 'ttsControl', 'tts.refresh': 'ttsControl',
    'pet.talk': 'pet', 'pet.ask': 'pet',
    'trigger.send': 'trigger',
    'widget.signal': 'widget', 'widget.signal.to': 'widget',
    'goal.add': 'goal',
    timer: 'later',
    ai: 'ai',
};

/** Recorded calls with no effect worth listing (pacing and loop control). */
const QUIET = new Set(['delay', 'break', 'continue']);

const PLAN_RANK: Record<PlanTier, number> = { free: 0, premium: 1, pro: 2 };

function effectFor(name: string, args: string[]): EffectKey | 'generic' | null {
    if (QUIET.has(name)) return null;
    const rule = FUNCTION_EFFECTS[name];
    if (typeof rule === 'function') return rule(args);
    if (rule) return rule;
    if (name.startsWith('overlay.')) return 'overlayQueue';
    if (name.startsWith('roulette.') && name !== 'roulette.result') return 'roulette';
    return 'generic';
}

/** Several viewers and arguments, so argument-only and mod-only branches run too. */
const RUNS: SimulationRunInput[] = [
    { user: 'Sam', role: 'viewer' },
    { user: 'Sam', role: 'viewer', argument: 'Alex' },
    { user: 'Mia', role: 'mod', argument: 'Alex 60' },
];
/** Fresh sequences (random branches); stops early when the time budget is spent. */
const SEQUENCES = 8;
const BUDGET_MS = 3_000;

const t = (text: Text, lang: Lang) => text[lang] ?? text.en;

export async function describeCommandEffects(body: string, opts: { plan: PlanTier; lang: Lang }): Promise<CommandEffects> {
    const { plan, lang } = opts;
    if (!body || !body.trim()) {
        return { effects: [], problems: [t({ en: 'The reply is empty.', es: 'La respuesta está vacía.' }, lang)] };
    }

    let input;
    try {
        input = parseSimulationInput({ body, runs: RUNS, plan });
    } catch (error) {
        if (error instanceof SimulationInputError) return { effects: [], problems: [error.message] };
        throw error;
    }

    const runs: SimulationRunResult[] = [];
    const started = Date.now();
    try {
        for (let sequence = 0; sequence < SEQUENCES; sequence++) {
            const result = await simulateCommand({ ...input, repeat: 1 });
            runs.push(...result.runs);
            // Slow bodies (loops, timeouts) are not run again.
            if (Date.now() - started > BUDGET_MS || result.runs.some((run) => run.problems.some((problem) => problem.includes('longer than')))) break;
        }
    } catch (error) {
        return {
            effects: [],
            problems: [t({ en: 'The test run failed: ', es: 'La prueba falló: ' }, lang) + (error instanceof Error ? error.message : String(error))],
        };
    }

    const keys = new Set<EffectKey>();
    const generic = new Set<string>();
    const referenced = new Set<string>();
    const problems = new Set<string>();
    const called = new Set<string>();

    for (const run of runs) {
        for (const call of run.actions) {
            const name = findAstCatalogEntry(call.function)?.name ?? call.function;
            called.add(name);
            const effect = effectFor(name, call.args);
            if (effect === 'generic') generic.add(name);
            else if (effect) keys.add(effect);
        }
        for (const sample of run.samples) {
            const name = findAstCatalogEntry(sample.function)?.name ?? sample.function;
            called.add(name);
            if (name === 'ai') keys.add('ai');
            if (name === 'bot.mode' && sample.args[0]?.trim().toLowerCase() === 'attack') keys.add('defense');
        }
        for (const ref of run.commandReferences) {
            const name = ref.replace(/^#\(/, '').replace(/\)$/, '').split(/\s+/)[0];
            if (name) referenced.add(`!${name}`);
        }
        for (const problem of run.problems) problems.add(problem);
    }

    // Safety net: actions behind a random branch or an unusual argument may never run in the dry runs above
    // (a 1-in-6 "russian roulette" timeout). Every function written in the body is classified too.
    for (const call of staticCalls(body)) {
        const entry = findAstCatalogEntry(call.function);
        const name = entry?.name ?? call.function;
        if (called.has(name) || QUIET.has(name)) continue;
        // Only known actions: pure functions ($(user), $(random)…) never become effects.
        const known = name in FUNCTION_EFFECTS || name.startsWith('overlay.') || (name.startsWith('roulette.') && name !== 'roulette.result') || entry?.destructive === true;
        if (!known) continue;
        const effect = effectFor(name, call.args);
        if (effect === 'generic') generic.add(name);
        else if (effect) keys.add(effect);
    }

    for (const name of called) {
        const tier = findAstCatalogEntry(name)?.planTier;
        if (tier && PLAN_RANK[tier] > PLAN_RANK[plan]) {
            problems.add(t({
                en: `${name} needs ${tier === 'pro' ? 'Pro' : 'Premium or Pro'}; on this plan it does nothing.`,
                es: `${name} necesita ${tier === 'pro' ? 'Pro' : 'Premium o Pro'}; con este plan no hace nada.`,
            }, lang));
        }
    }

    if (runs.length && runs.every((run) => !run.reply && !run.actions.length && !run.commandReferences.length && !run.problems.length)) {
        problems.add(t({ en: 'In the test run it posts nothing and does nothing.', es: 'En la prueba no publica nada ni hace nada.' }, lang));
    }

    const effects = (Object.keys(EFFECTS) as EffectKey[]).filter((key) => keys.has(key)).map((key) => t(EFFECTS[key], lang));
    if (generic.size) {
        const names = [...generic].slice(0, 6).join(', ');
        effects.push(t({ en: `Also runs: ${names}`, es: `También ejecuta: ${names}` }, lang));
    }
    if (referenced.size) {
        const names = [...referenced].slice(0, 6).join(', ');
        effects.push(t({ en: `Runs other commands: ${names}`, es: `Ejecuta otros comandos: ${names}` }, lang));
    }

    return { effects, problems: [...problems].slice(0, 8) };
}

/**
 * Every `$(name args…)` written in a body, with its top-level arguments as written (nested calls kept as text).
 * Used only to make sure a written action is never missing from the effects list.
 */
export function staticCalls(body: string): { function: string; args: string[] }[] {
    const calls: { function: string; args: string[] }[] = [];
    const start = /\$\(\s*([a-z][\w.]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = start.exec(body)) && calls.length < 200) {
        let depth = 1;
        let quote: string | null = null;
        let index = match.index + match[0].length;
        const inner = index;
        for (; index < body.length && depth > 0; index++) {
            const ch = body[index];
            if (quote) { if (ch === '\\') index++; else if (ch === quote) quote = null; continue; }
            if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '(') depth++;
            else if (ch === ')') depth--;
        }
        const text = body.slice(inner, depth === 0 ? index - 1 : index);
        const args: string[] = [];
        let current = '';
        let level = 0;
        let q: string | null = null;
        for (const ch of text) {
            if (q) { current += ch; if (ch === q) q = null; continue; }
            if (ch === '"' || ch === "'") { q = ch; current += ch; continue; }
            if (ch === '(') level++;
            if (ch === ')') level--;
            if (/\s/.test(ch) && level === 0) { if (current) args.push(current); current = ''; continue; }
            current += ch;
        }
        if (current) args.push(current);
        calls.push({ function: match[1].toLowerCase(), args });
    }
    return calls;
}
