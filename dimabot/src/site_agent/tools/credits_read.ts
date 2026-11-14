/** Read-only AI credit balance for the channel (site assistant and MCP), same data and rule as the Credits page. */
import type { AgentTool, Lang } from '../types.js';
import UsersSchema from '../../schemas/users.schema.js';
import { getAiCredits } from '../../utils/billing.js';
import { getFreeAiCreditDisplay } from '../../utils/ai_credit_display.js';

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

export const getAiCreditsTool: AgentTool<Record<string, never>> = {
    name: 'get_ai_credits',
    description: 'The channel\'s AI credits right now, as the website\'s Credits page shows them: balance left, used and limit for '
        + 'the current period, and whether AI features can run. AI replies, AI voices, chat protection and MCP tool calls spend '
        + 'these credits. Use it when the user asks about credits or before a long run of tool calls. Free to call. More '
        + 'credits: the buyMoreAt page.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'read',
    // Same rule as the website's Credits page and GET /billing/ai-credits.
    permissions: ['billing:view'],
    label: (_input, lang) => l(lang, 'Checking AI credits…', 'Revisando créditos de IA…'),
    validate: () => ({}),
    async run(_input, ctx) {
        const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: ctx.channelId } } });
        if (!owner) return { type: 'result', billable: false, result: { available: false, message: 'No account found for this channel.' } };
        const raw = await getAiCredits(owner, ctx.channelId, { signal: ctx.signal });
        const display = await getFreeAiCreditDisplay(owner, ctx.channelId, raw);
        const credits = display?.credits ?? raw;
        const empty = credits.status === 'exhausted' || (credits.available && credits.balance <= 0);
        return {
            type: 'result',
            summary: credits.available ? l(ctx.lang, `${credits.balance} AI credits left`, `Quedan ${credits.balance} créditos de IA`)
                : l(ctx.lang, 'AI credits unavailable', 'Créditos de IA no disponibles'),
            result: {
                plan: owner.plan_tier ?? 'free',
                available: credits.available,
                status: empty ? 'exhausted' : credits.status,
                balance: credits.balance,
                used: credits.used,
                limit: credits.limit,
                ...(display?.estimated && display.credits ? { estimated: true } : {}),
                updatedAt: credits.updatedAt,
                buyMoreAt: `https://domdimabot.com/${ctx.channelLogin}/credits`,
                ...(credits.available ? {} : { message: 'AI credits can\'t be read right now (billing is unavailable or not set up for this channel).' }),
            },
        };
    },
};
