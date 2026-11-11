/**
 * UI tools: show_ui (sandboxed HTML/CSS/JS block in the chat) and navigate (SPA navigation in
 * dimasite, optionally with the mascot pointing at an anchor). No server-side effects.
 */
import { SITE_AGENT_LIMITS } from '../config.js';
import { NAV_ANCHORS, NAV_ROUTES } from '../navigation.js';
import { ToolInputError, type AgentTool, type ToolContext } from '../types.js';
import { asObject, bool, int, oneOf, str } from './util.js';

const bytes = (text: string | undefined) => (text ? Buffer.byteLength(text, 'utf8') : 0);

interface ShowUiInput { title: string; html: string; css?: string; js?: string; waitForInput: boolean; height?: number }

export const showUiTool: AgentTool<ShowUiInput> = {
    name: 'show_ui',
    kind: 'ui',
    permissions: [],
    description: 'Show a small interactive UI block in the chat: tables, charts, previews or a form. It runs in a sandboxed frame themed like the site '
        + '(dark/light): no network, no access to the page. Available inside: CSS kit classes (card, table, btn, btn-primary, btn-ghost, chips/chip, badge, muted, '
        + 'row, stack, grid; inputs, selects, textareas, labels and range sliders are pre-styled) and a JS object `dima`: dima.chart(el, {type: "bar"|"line"|"area"|"donut", '
        + 'labels: [...], series: [{name, values: [...]}], unit?, title?}), dima.submit(values) to send a plain object of answers back (only when wait_for_input is true), '
        + 'dima.navigate(pageKey). Set wait_for_input: true to collect values: the conversation pauses until the user submits, and their values come back as this tool\'s result. '
        + 'Keep it focused (one table/chart/form), label every input, and never ask for passwords, tokens, emails or payment details.',
    parameters: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Short title shown above the block.' },
            html: { type: 'string', description: 'Body HTML (no <html>/<head>; no external URLs).' },
            css: { type: 'string', description: 'Optional extra CSS.' },
            js: { type: 'string', description: 'Optional JS run after the HTML (use the dima object).' },
            wait_for_input: { type: 'boolean', description: 'true = wait for the user to submit a form via dima.submit(values).' },
            height: { type: 'integer', minimum: 60, maximum: 900, description: 'Initial height hint in px (auto-resizes).' },
        },
        required: ['title', 'html'],
        additionalProperties: false,
    },
    label: (_input, lang) => (lang === 'es' ? 'Preparando una vista…' : 'Preparing a view…'),
    validate(raw) {
        const input = asObject(raw);
        const title = str(input, 'title', { required: true, max: 120 })!;
        const html = str(input, 'html', { required: true, trim: false })!;
        const css = str(input, 'css', { trim: false });
        const js = str(input, 'js', { trim: false });
        if (bytes(html) + bytes(css) + bytes(js) > SITE_AGENT_LIMITS.uiBlockBytes) {
            throw new ToolInputError(`The UI block is too large (max ${SITE_AGENT_LIMITS.uiBlockBytes} bytes of HTML+CSS+JS). Make it smaller.`);
        }
        if (/<\s*(script|iframe|frame|frameset|object|embed|portal|fencedframe|base|meta|link)\b/i.test(html)) {
            throw new ToolInputError('Put scripts in the js field; frames (<iframe>, <frame>…), <object>, <embed>, <base>, <meta> and <link> are not allowed in html.');
        }
        if (js && /\b(iframe|frameset|fencedframe|srcdoc)\b/i.test(js)) {
            throw new ToolInputError('UI blocks cannot create frames.');
        }
        return { title, html, css, js, waitForInput: bool(input, 'wait_for_input') ?? false, height: int(input, 'height', { min: 60, max: 900 }) };
    },
    async run(input) {
        return { type: 'ui', block: { title: input.title, html: input.html, css: input.css, js: input.js, waitForInput: input.waitForInput, height: input.height } };
    },
};

interface NavigateInput { mode: 'offer' | 'go'; route: string; anchor?: string; label: string }

async function canOpen(route: (typeof NAV_ROUTES)[number], ctx: ToolContext): Promise<boolean> {
    if (route.permission === 'owner') return ctx.role === 'owner';
    return ctx.can([route.permission]);
}

export const navigateTool: AgentTool<NavigateInput> = {
    name: 'navigate',
    kind: 'ui',
    permissions: [],
    description: 'Open a page of the dashboard for the user without reloading (always on the current channel). mode "go" navigates right away: use it when the user '
        + 'asks where something is or asks to go there, and pass `anchor` so the mascot points at the exact spot. mode "offer" shows a button the user can press. '
        + 'route and anchor must be keys from the "Page keys" and "Anchor keys" lists in your instructions. label = what the user will see, e.g. "Text to Speech settings".',
    parameters: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['offer', 'go'] },
            route: { type: 'string', description: 'Page key, e.g. "modules.tts".' },
            anchor: { type: 'string', description: 'Optional anchor key on that page, e.g. "tts.voice".' },
            label: { type: 'string', description: 'Short label in the user\'s language.' },
        },
        required: ['mode', 'route', 'label'],
        additionalProperties: false,
    },
    label: (_input, lang) => (lang === 'es' ? 'Abriendo la página…' : 'Opening the page…'),
    validate(raw) {
        const input = asObject(raw);
        const mode = oneOf(input, 'mode', ['offer', 'go'] as const, { required: true })!;
        const route = str(input, 'route', { required: true, max: 80 })!;
        const anchor = str(input, 'anchor', { max: 80 });
        const label = str(input, 'label', { required: true, max: 80 })!;
        if (!NAV_ROUTES.some((item) => item.key === route)) throw new ToolInputError(`Unknown page key "${route}". Use one from the Page keys list.`);
        if (anchor) {
            const found = NAV_ANCHORS.find((item) => item.key === anchor);
            if (!found) throw new ToolInputError(`Unknown anchor key "${anchor}". Use one from the Anchor keys list or omit it.`);
            if (found.route !== route) throw new ToolInputError(`Anchor "${anchor}" is on page "${found.route}", not "${route}".`);
        }
        return { mode, route, anchor, label };
    },
    async run(input, ctx) {
        const route = NAV_ROUTES.find((item) => item.key === input.route)!;
        if (!(await canOpen(route, ctx))) {
            return { type: 'result', result: { opened: false, reason: route.permission === 'owner' ? 'Only the channel owner can open this page.' : 'This person has no access to that page.' } };
        }
        return { type: 'navigate', action: { mode: input.mode, route: input.route, label: input.label, ...(input.anchor ? { anchor: input.anchor } : {}) } };
    },
};

export const uiTools: AgentTool[] = [showUiTool as unknown as AgentTool, navigateTool as unknown as AgentTool];
