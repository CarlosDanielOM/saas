/**
 * Code Execution Tool Implementation
 * 
 * Executes JavaScript code in a secure Deno sandbox.
 * Handles code planning (Pro tier), generation, and execution.
 */

import { getDragonflyClient } from '../../databases/dragonfly.database.js';
import { ingestPolarSHEvent } from '../../polarsh.js';
import { executeAiCode, type SandboxEnv } from '../sandbox/execute_sandbox.ai.js';
import { CODING_MODELS } from '../constants.js';
import { createFetchWithRetry } from '../fetch.utils.js';
import { error, debug } from '../../logger.js';
import path from 'path';
import fs from 'fs';

const fetchWithRetry = createFetchWithRetry({ timeout: 30000, retries: 3 });

async function sendExecutionStatusMessage(channelID: string, message: string): Promise<void> {
    try {
        const { sendTwitchChatMessage } = await import('../../../functions/chats/send_message.chat.js');
        await sendTwitchChatMessage(channelID, message);
    } catch (err) {
        await debug({
            function: 'sendExecutionStatusMessage',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'both' });
    }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface IStreamerData {
    user_id?: string;
    name?: string;
    plan_tier?: 'free' | 'premium' | 'pro';
    polar_sh_customer_id?: string;
    bot_token?: string;
    [key: string]: any;
}

/**
 * @deprecated Use SearchResult from search.tool.ts instead
 */
export interface ISearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
}

/**
 * Context passed to a tool when executing
 */
export interface IToolContext {
    name: string;
    context: any;
}

export interface ICodePlanResult {
    plan: string | null;
    error: string | null;
}

export interface ICodeGenerationResult {
    code: string | null;
    error: string | null;
}

export interface ISandboxExecutionResult {
    result: any;
    logs: string[];
    error: string | null;
    executionTime: number;
    timedOut: boolean;
}

export interface CodeExecutionToolResult {
    success: boolean;
    result?: any;
    logs?: string[];
    error?: string;
    executionTime?: number;
    timedOut?: boolean;
    hadPlan?: boolean;
    phase?: 'planning' | 'generation' | 'execution' | 'unknown';
}

// ============================================================================
// API DOCUMENTATION LOADER
// ============================================================================

function loadApiDocumentation(): string {
    const sections: string[] = [];
    try {
        const docPath = path.join(process.cwd(), 'src/utils/ai/sandbox/doc-llm.txt');
        sections.push(fs.readFileSync(docPath, 'utf-8'));
    } catch (err) {
        error({ function: 'loadApiDocumentation', error: 'Failed to load API documentation', err: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
    }
    try {
        // Generated AST authoring reference (npm run gen:ast-docs). May be
        // absent in a stale checkout; the command message syntax then falls
        // back to whatever doc-llm.txt still documents.
        const astDocPath = path.join(process.cwd(), 'src/utils/ai/sandbox/doc-ast.txt');
        sections.push(fs.readFileSync(astDocPath, 'utf-8'));
    } catch {
        // Optional; not fatal.
    }
    return sections.join('\n\n');
}

// ============================================================================
// CODE PLANNING (Pro Tier Only)
// ============================================================================

async function generateCodePlan(
    channelID: string,
    userRequest: string,
    model: string,
    streamer: IStreamerData
): Promise<ICodePlanResult> {
    const apiDocs = loadApiDocumentation();

    const systemPrompt = `You are a code planning assistant for DomDimaBot, a Twitch chat bot.
    Your task is to create a structured plan for code that will be executed in a secure sandbox environment.

    ## Available Environment Variables
    The sandbox has access to these environment variables via \`env\`:
    - env.CHANNEL_ID - The Twitch channel ID
    - env.CHANNEL_NAME - The Twitch channel name
    - env.AUTH_TOKEN - Bearer token for API authentication

    ## Available API Endpoints
    ${apiDocs}

    ## Your Task
    Analyze user's request and create a step-by-step plan that includes:
    CRITICAL DECISION: 
    - If user wants a command, use commands endpoint (command, comando, cmd, func, function, funcion)
    - If user wants a trigger, use triggers endpoint (trigger, alerta, alert, cost, prompt, description, descripcion, message, mensaje)
    - If user wants an event, use the events endpoint
    - If user wants a reward, use rewards endpoint (reward, canje, points, channel points, redeem, canjear, canjeo, reclamar, cost, prompt, description, descripcion, message, mensaje)

    1. Which API endpoints to use
    2. The order of operations
    3. How to handle data
    4. What to return as final result

    Keep the plan concise but complete. Focus on practical implementation steps.`;

    const userPrompt = `Create a code execution plan for this request:

"${userRequest}"

Provide a structured plan with clear steps.`;

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://domdimabot.com',
            'X-Title': 'DomDimaBot'
        };

        const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: headers as Record<string, string>,
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                user: `${channelID}`,
                usage: {
                    'include': true
                }
            })
        });

        const data: any = await response.json();
        
        if (data.error) {
            return { plan: null, error: data.error.message || 'Planning failed' };
        }

        if (streamer?.polar_sh_customer_id && data.usage) {
            const aiUsage = data.usage;
            const actualCost = (aiUsage?.cost_details?.upstream_inference_prompt_cost || 0) + 
                              (aiUsage?.cost_details?.upstream_inference_completions_cost || 0);

            await ingestPolarSHEvent({
                customerId: streamer.polar_sh_customer_id,
                channelID: channelID,
                cost: actualCost,
                reason: 'planner',
                llm: {
                    model: model,
                    usage: aiUsage
                },
                mode: 'cache'
            });
        }

        const plan = data.choices?.[0]?.message?.content || '';
        
        return { plan, error: null };
    } catch (err) {
        await error({ function: 'generateCodePlan', error: 'Code planning error', err: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
        return { plan: null, error: (err as Error).message };
    }
}

// ============================================================================
// CODE GENERATION
// ============================================================================

async function generateCode(
    channelID: string,
    userRequest: string,
    model: string,
    plan: string | null = null,
    streamer: IStreamerData | null = null
): Promise<ICodeGenerationResult> {
    const apiDocs = loadApiDocumentation();

    const systemPrompt = `You are a code generation assistant for DomDimaBot, a Twitch chat bot.
    Generate JavaScript code that will run in a secure sandbox environment.

    ## Sandbox Environment
    The sandbox provides:
    - \`fetch(url, options)\` - Make HTTP requests (only to allowed endpoints)
    - \`console.log(...args)\` - Log messages (captured for debugging)
    - \`env\` object with environment variables

    ## Available Environment Variables
    - env.CHANNEL_ID - The Twitch channel ID (use this in API URLs)
    - env.CHANNEL_NAME - The Twitch channel name
    - env.AUTH_TOKEN - Bearer token for API authentication (use in headers)

    ## Available API Endpoints
    ${apiDocs}

    ## Code Requirements
    1. Use \`fetch\` for all API calls
    2. Use \`env.AUTH_TOKEN\` in Authorization headers: \`Authorization: Bearer \${env.AUTH_TOKEN}\`
    3. Replace :channelID in URLs with \`env.CHANNEL_ID\`
    4. Always return a result using \`return\` statement
    5. Handle errors gracefully
    6. The code runs in an async context, so you can use await directly
    7. IMPORTANT: Always check that you are using the correct endpoint
        - If user wants a command, use the commands endpoint
        - If user wants a trigger, use the triggers endpoint
        - If user wants an event, use the events endpoint
        - If user wants a reward, use the rewards endpoint

    ## Example Code
    \`\`\`javascript
    // Fetch all commands for the channel
    const response = await fetch(\`https://api.domdimabot.com/command/\${env.CHANNEL_ID}\`, {
        method: 'GET',
        headers: {
            'Authorization': \`Bearer \${env.AUTH_TOKEN}\`
        }
    });

    if (!response.ok) {
        return { error: true, message: 'Failed to fetch commands', reason: 'missing authorization token' };
    }

    const commands = response.body;
    return { success: true, commandCount: commands.length };
    \`\`\`

    ## Output Format
    Return ONLY JavaScript code, no markdown code blocks, no explanations.
    The code should be ready to execute directly.`;

    let userPrompt = `Generate JavaScript code for this request:

"${userRequest}"`;

    if (plan) {
        userPrompt += `

## Execution Plan
Follow this plan when generating the code:

${plan}`;
    }

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://domdimabot.com',
            'X-Title': 'DomDimaBot'
        };

        const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: headers as Record<string, string>,
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 10000,
                user: `${channelID}`,
                usage: {
                    'include': true
                }
            })
        });

        const data: any = await response.json();
        
        if (data.error) {
            return { code: null, error: data.error.message || 'Code generation failed' };
        }

        if (streamer?.polar_sh_customer_id && data.usage) {
            const aiUsage = data.usage;
            const actualCost = (aiUsage?.cost_details?.upstream_inference_prompt_cost || 0) + 
                              (aiUsage?.cost_details?.upstream_inference_completions_cost || 0);

            await ingestPolarSHEvent({
                customerId: streamer.polar_sh_customer_id,
                channelID: channelID,
                cost: actualCost,
                reason: 'coding_agent',
                llm: {
                    model: model,
                    usage: aiUsage
                },
                mode: 'cache'
            });
        }

        let code = data.choices?.[0]?.message?.content || '';
        code = code.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/i, '').trim();
        
        return { code, error: null };
    } catch (err) {
        await error({ function: 'generateCode', error: 'Code generation error', err: err instanceof Error ? err.message : String(err) }, { channelId: channelID, destination: 'both' });
        return { code: null, error: (err as Error).message };
    }
}

// ============================================================================
// SANDBOX EXECUTION
// ============================================================================

async function executeSandbox(
    code: string,
    channelID: string,
    streamer: IStreamerData
): Promise<ISandboxExecutionResult> {
    const startTime = Date.now();
    
    try {
        const sandboxEnv: SandboxEnv = {
            CHANNEL_ID: channelID,
            CHANNEL_NAME: streamer?.name || '',
            AUTH_TOKEN: streamer?.bot_token || ''
        };

        const rawOutput = await executeAiCode(code, sandboxEnv);

        let parsedResult = rawOutput;
        try {
            parsedResult = JSON.parse(rawOutput);
        } catch (e) {
            parsedResult = rawOutput; 
        }

        const resultObj = {
            result: parsedResult,
            logs: [typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)],
            error: null,
            executionTime: Date.now() - startTime,
            timedOut: false
        };

        return resultObj;

    } catch (err) {
        await error({ function: 'executeSandbox', error: 'Sandbox execution error', err: err instanceof Error ? err.message : String(err) }, { channelId: channelID, destination: 'both' });

        const errorResult = {
            result: null,
            logs: [],
            error: (err as Error).message,
            executionTime: Date.now() - startTime,
            timedOut: (err as Error).message.includes('Timed Out')
        };

        return errorResult;
    }
}

// ============================================================================
// MODEL SELECTION
// ============================================================================

function selectCodingModel(streamer: IStreamerData | null | undefined, isExhausted: boolean = false): string {
    if (isExhausted) {
        return CODING_MODELS.exhausted;
    }
    if (streamer?.plan_tier === 'pro') {
        return CODING_MODELS.pro;
    }
    if (streamer?.plan_tier === 'premium') {
        return CODING_MODELS.premium;
    }
    return CODING_MODELS.free;
}

function isProTier(streamer: IStreamerData | null | undefined): boolean {
    return streamer?.plan_tier === 'pro';
}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

export async function execute(
    args: { code: string; request: string },
    context: { channelID: string; streamer: IStreamerData; username?: string }
): Promise<CodeExecutionToolResult> {
    const { code, request } = args;
    const { channelID, streamer, username = 'User' } = context;

    const cacheClient = await getDragonflyClient('CodeExecution');
    const isExhaustedResult = await cacheClient.exists(`${channelID}:ai:exhaust`);
    const isExhausted = isExhaustedResult === 1;
    const codingModel = selectCodingModel(streamer, isExhausted);

    let plan: string | null = null;
    let generatedCode: string | null = code;
    let sandboxResult: ISandboxExecutionResult | null = null;

    try {
        // Planning phase (Pro tier only, not exhausted)
        if (isProTier(streamer) && !isExhausted && !code) {
            debug({ message: '[Code Execution Tool] Pro tier detected - generating code plan', channelID }, { channelId: channelID, destination: 'console' });
            await sendExecutionStatusMessage(channelID, `@${username} Creando el plan`);

            const planResult = await generateCodePlan(channelID, request, 'openai/gpt-oss-120b', streamer);

            if (planResult.error) {
                await error({ function: 'codeExecutionTool', error: 'Plan generation failed', err: planResult.error }, { channelId: channelID, destination: 'both' });
            } else {
                plan = planResult.plan;
                debug({ message: '[Code Execution Tool] Plan generated successfully' }, { channelId: channelID, destination: 'console' });
            }
        }

        // Code generation (if code not provided)
        if (!generatedCode) {
            debug({ message: '[Code Execution Tool] Generating code', model: codingModel }, { channelId: channelID, destination: 'console' });
            await sendExecutionStatusMessage(channelID, `@${username} Generando el código`);
            
            const codeResult = await generateCode(channelID, request, codingModel, plan, streamer);
            
            if (codeResult.error) {
                return {
                    success: false,
                    error: `Code generation failed: ${codeResult.error}`,
                    phase: 'generation'
                };
            }
            
            generatedCode = codeResult.code;
        }

        // Sandbox execution
        debug({ message: '[Code Execution Tool] Code generated, executing in sandbox' }, { channelId: channelID, destination: 'console' });

        sandboxResult = await executeSandbox(generatedCode!, channelID, streamer);

        debug({
            message: '[Code Execution Tool] Sandbox execution completed',
            result: sandboxResult?.result ? String(sandboxResult.result).substring(0, 200) + (String(sandboxResult.result).length > 200 ? '...' : '') : 'null',
            logs: sandboxResult?.logs.length || 0,
            executionTime: sandboxResult?.executionTime || 0,
            model: codingModel
        }, { channelId: channelID, destination: 'console' });

        return {
            success: !sandboxResult?.error && !sandboxResult?.timedOut,
            result: sandboxResult?.result,
            logs: sandboxResult?.logs,
            error: sandboxResult?.error ?? undefined,
            executionTime: sandboxResult?.executionTime,
            timedOut: sandboxResult?.timedOut,
            hadPlan: !!plan,
            phase: 'execution'
        };

    } catch (codeError) {
        await error({ function: 'codeExecutionTool', error: 'Code action error', err: codeError instanceof Error ? codeError.message : String(codeError) }, { channelId: channelID, destination: 'both' });
        
        return {
            success: false,
            error: (codeError as Error).message,
            phase: 'unknown'
        };
    }
}

// ============================================================================
// TOOL METADATA
// ============================================================================

export const toolMeta = {
    name: 'code_execution',
    description: 'Execute JavaScript code in a sandbox',
    parameters: {
        code: { type: 'string', description: 'The JavaScript code to execute' },
        request: { type: 'string', description: 'What the user wants the code to do' }
    }
};
