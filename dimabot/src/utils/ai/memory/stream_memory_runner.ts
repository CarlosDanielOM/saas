import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
import { ChannelStreamSummarySchema } from '../../../schemas/channel_stream_summary.schema.js';
import UsersSchema from '../../../schemas/users.schema.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { buildStreamSummaryContext, type StreamSummaryContext } from './stream_summary_context.js';
import { generateStreamSummaryDecision } from './stream_summary_decider.js';
import { getBackgroundSummaryModel } from '../constants.js';
import { applyStreamMemoryActions, type IApplyStreamMemoryActionsResult, type IMemoryAction } from './stream_memory_apply.js';
import { recordStreamMemoryActionMetric } from '../../observability/bot_runtime_metrics.js';
import { sendEmail, DASHBOARD_URL } from '../../email/email.service.js';
import { StreamSummaryEmail, getStreamSummaryEmailSubject } from '../../email/templates/stream-summary.js';
import { info as logInfo, error as logError, warn as logWarn, debug } from '../../logger.js';

const DEFAULT_RUN_CONFIG = {
    enabled: true,
    streamSummariesEnabled: true,
    postStreamSummaryEnabled: true,
    weeklyMaintenanceEnabled: true,
    monthlyMaintenanceEnabled: true,
    summaryMinDurationMinutes: 20,
    summaryMinChatMessages: 30
};

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

interface IRunConfig {
    enabled: boolean;
    streamSummariesEnabled: boolean;
    postStreamSummaryEnabled: boolean;
    weeklyMaintenanceEnabled: boolean;
    monthlyMaintenanceEnabled: boolean;
    summaryMinDurationMinutes: number;
    summaryMinChatMessages: number;
}

interface IPersonalityWithLearningConfig {
    streamSummariesEnabled?: unknown;
    learningConfig?: {
        enabled?: unknown;
        postStreamSummaryEnabled?: unknown;
        weeklyMaintenanceEnabled?: unknown;
        monthlyMaintenanceEnabled?: unknown;
        summaryMinDurationMinutes?: unknown;
        summaryMinChatMessages?: unknown;
    };
}

interface ISummaryOutput {
    summary: {
        headline: string;
        recap: string;
        highlights: string[];
    };
    actions: IMemoryAction[];
}

async function getRunConfig(channelID: string): Promise<IRunConfig> {
    const personality = await ChannelAIPersonalitySchema.findOne({ channelID }).select('learningConfig streamSummariesEnabled').lean() as IPersonalityWithLearningConfig | null;
    const config = personality?.learningConfig;
    return {
        enabled: Boolean(config?.enabled ?? DEFAULT_RUN_CONFIG.enabled),
        streamSummariesEnabled: Boolean(personality?.streamSummariesEnabled ?? DEFAULT_RUN_CONFIG.streamSummariesEnabled),
        postStreamSummaryEnabled: Boolean(config?.postStreamSummaryEnabled ?? DEFAULT_RUN_CONFIG.postStreamSummaryEnabled),
        weeklyMaintenanceEnabled: Boolean(config?.weeklyMaintenanceEnabled ?? DEFAULT_RUN_CONFIG.weeklyMaintenanceEnabled),
        monthlyMaintenanceEnabled: Boolean(config?.monthlyMaintenanceEnabled ?? DEFAULT_RUN_CONFIG.monthlyMaintenanceEnabled),
        summaryMinDurationMinutes: Number(config?.summaryMinDurationMinutes ?? DEFAULT_RUN_CONFIG.summaryMinDurationMinutes),
        summaryMinChatMessages: Number(config?.summaryMinChatMessages ?? DEFAULT_RUN_CONFIG.summaryMinChatMessages)
    };
}

function shouldRunForSource(source: string, config: IRunConfig): boolean {
    if (source === 'stream_offline') {
        return config.streamSummariesEnabled && config.postStreamSummaryEnabled;
    }
    if (!config.enabled) {
        return false;
    }
    if (source === 'weekly_maintenance') {
        return config.weeklyMaintenanceEnabled;
    }
    return config.monthlyMaintenanceEnabled;
}

interface ISaveSummaryRecordParams {
    channelID: string;
    channelName: string;
    source: string;
    context: StreamSummaryContext;
    status: string;
    summary: {
        headline: string;
        recap: string;
        highlights: string[];
    };
    proposedActions: IMemoryAction[];
    appliedActions: IApplyStreamMemoryActionsResult['results'];
    totals: IApplyStreamMemoryActionsResult['totals'];
    errorMessage?: string;
}

async function saveSummaryRecord(params: ISaveSummaryRecordParams): Promise<{ _id: string } | null> {
    const updateDoc = {
        channelID: params.channelID,
        channel: params.channelName,
        stream_session_id: params.context.session.id,
        stream_id: params.context.session.streamID,
        started_at: params.context.session.startedAt,
        ended_at: params.context.session.endedAt,
        duration_minutes: params.context.session.durationMinutes,
        average_viewers: params.context.session.averageViewers,
        peak_viewers: params.context.session.peakViewers,
        follows: params.context.session.follows,
        subs: params.context.session.subs,
        bits: params.context.session.bits,
        donations: params.context.session.donations,
        headline: params.summary.headline,
        recap: params.summary.recap,
        highlights: params.summary.highlights,
        chat_messages_sampled: params.context.chatMessages.length,
        snapshot_count: params.context.snapshots.length,
        proposed_actions: params.proposedActions,
        applied_actions: params.appliedActions,
        totals: params.totals,
        status: params.status,
        source: params.source,
        error_message: normalizeText(params.errorMessage)
    };
    const document = await ChannelStreamSummarySchema.findOneAndUpdate({
        channelID: params.channelID,
        stream_session_id: params.context.session.id,
        source: params.source
    }, {
        $set: updateDoc,
        $setOnInsert: {
            created_at: new Date()
        }
    }, {
        new: true,
        upsert: true
    });
    return document ? { _id: String(document._id) } : null;
}

export interface IRunStreamMemoryWorkflowInput {
    channelID: string;
    sessionID?: string;
    streamID?: string;
    source: 'stream_offline' | 'weekly_maintenance' | 'monthly_maintenance' | 'manual';
}

export interface IRunStreamMemoryWorkflowResult {
    error: boolean;
    message?: string;
    status: 'applied' | 'skipped' | 'noop' | 'failed';
    summaryID?: string;
}

export async function runStreamMemoryWorkflow(input: IRunStreamMemoryWorkflowInput): Promise<IRunStreamMemoryWorkflowResult> {
    const workflowStartTime = Date.now();

    try {
        const channelID = normalizeText(input.channelID);

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] ==========================================',
            step: 'START',
            channelID,
            sessionID: input.sessionID,
            streamID: input.streamID,
            source: input.source,
            timestamp: new Date().toISOString()
        }, { channelId: channelID, destination: 'both' });

        if (!channelID) {
            await logError({
                message: '[STREAM SUMMARY WORKFLOW] Invalid channel ID - stopping',
                step: 'VALIDATION',
                channelID,
                input
            }, { channelId: channelID || 'unknown', destination: 'both' });

            return {
                error: true,
                message: 'Invalid channel ID',
                status: 'failed'
            };
        }

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 1: Getting run configuration',
            step: 'GET_CONFIG',
            channelID,
            source: input.source
        }, { channelId: channelID, destination: 'both' });

        const config = await getRunConfig(channelID);

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Got run config',
            step: 'GOT_CONFIG',
            channelID,
            config,
            shouldRun: shouldRunForSource(input.source, config)
        }, { channelId: channelID, destination: 'both' });

        if (!shouldRunForSource(input.source, config)) {
            await logWarn({
                message: '[STREAM SUMMARY WORKFLOW] Workflow disabled for this source - skipping',
                step: 'DISABLED',
                channelID,
                source: input.source,
                config
            }, { channelId: channelID, destination: 'both' });

            return {
                error: false,
                message: `Stream memory workflow disabled for source ${input.source}`,
                status: 'skipped'
            };
        }

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 2: Fetching streamer info from Twitch',
            step: 'GET_STREAMER',
            channelID
        }, { channelId: channelID, destination: 'both' });

        // Fetch streamer info first to get plan tier and language
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        const channelName = normalizeText(streamer?.name) || 'Unknown';
        const planTier = streamer?.plan_tier;

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Got streamer info',
            step: 'GOT_STREAMER',
            channelID,
            channelName,
            planTier,
            hasPolarCustomerId: !!streamer?.polar_sh_customer_id
        }, { channelId: channelID, destination: 'both' });

        // Get language preference from personality (null if not set, will detect from chat)
        const personality = await ChannelAIPersonalitySchema.findOne({ channelID }).select('language').lean();
        const language = personality?.language || null;

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 3: Building stream summary context from Qdrant and MongoDB',
            step: 'BUILD_CONTEXT',
            channelID,
            sessionID: input.sessionID,
            streamID: input.streamID,
            planTier,
            language
        }, { channelId: channelID, destination: 'both' });

        const contextResult = await buildStreamSummaryContext({
            channelID,
            sessionID: input.sessionID,
            streamID: input.streamID,
            planTier,
            language
        });

        if (contextResult.error || !contextResult.context) {
            await logError({
                message: '[STREAM SUMMARY WORKFLOW] Failed to build context - stopping workflow',
                step: 'BUILD_CONTEXT_FAILED',
                channelID,
                error: contextResult.message,
                errorDetails: contextResult
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: contextResult.message || 'Failed to build stream summary context',
                status: 'failed'
            };
        }

        const context = contextResult.context;

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Context built successfully',
            step: 'CONTEXT_BUILT',
            channelID,
            sessionDuration: context.session.durationMinutes,
            chatMessagesCount: context.chatMessages.length,
            snapshotsCount: context.snapshots?.length || 0,
            existingMemoriesCount: context.existingMemories?.length || 0
        }, { channelId: channelID, destination: 'both' });

        const isBelowThreshold = input.source === 'stream_offline'
            && (context.session.durationMinutes < config.summaryMinDurationMinutes
                || context.chatMessages.length < config.summaryMinChatMessages);

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Checking if stream meets summary thresholds',
            step: 'CHECK_THRESHOLD',
            channelID,
            source: input.source,
            durationMinutes: context.session.durationMinutes,
            minDurationRequired: config.summaryMinDurationMinutes,
            chatMessagesCount: context.chatMessages.length,
            minChatMessagesRequired: config.summaryMinChatMessages,
            isBelowThreshold
        }, { channelId: channelID, destination: 'both' });

        if (isBelowThreshold) {
            await logWarn({
                message: '[STREAM SUMMARY WORKFLOW] Stream below threshold - marking as noop',
                step: 'BELOW_THRESHOLD',
                channelID,
                durationMinutes: context.session.durationMinutes,
                chatMessages: context.chatMessages.length,
                thresholdDuration: config.summaryMinDurationMinutes,
                thresholdMessages: config.summaryMinChatMessages
            }, { channelId: channelID, destination: 'both' });

            const noOpSummary = await saveSummaryRecord({
                channelID,
                channelName,
                source: input.source,
                context,
                status: 'noop',
                summary: {
                    headline: `Stream summary for ${channelName}`,
                    recap: 'Stream did not meet summary thresholds, so no memory actions were applied.',
                    highlights: [
                        `Duration: ${context.session.durationMinutes} minutes`,
                        `Sampled chat messages: ${context.chatMessages.length}`
                    ]
                },
                proposedActions: [],
                appliedActions: [],
                totals: {
                    proposed: 0,
                    applied: 0,
                    skipped: 0,
                    failed: 0
                }
            });

            await logInfo({
                message: '[STREAM SUMMARY WORKFLOW] Noop summary saved - workflow complete',
                step: 'NOOP_COMPLETE',
                channelID,
                summaryID: noOpSummary?._id,
                durationMs: Date.now() - workflowStartTime
            }, { channelId: channelID, destination: 'both' });

            return {
                error: false,
                message: 'Summary thresholds not met; workflow marked as noop',
                status: 'noop',
                summaryID: noOpSummary?._id
            };
        }

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 4: Generating AI summary decision via OpenRouter',
            step: 'GENERATE_DECISION',
            channelID,
            source: input.source,
            modelSelection: getBackgroundSummaryModel(planTier)
        }, { channelId: channelID, destination: 'both' });

        const decisionResult = await generateStreamSummaryDecision(context, input.source);
        const decisionOutput = decisionResult.output as ISummaryOutput | undefined;
        const actionsCount = decisionOutput?.actions?.length || 0;

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] AI decision received',
            step: 'GOT_DECISION',
            channelID,
            decisionError: decisionResult.error,
            decisionMessage: decisionResult.message,
            hasOutput: !!decisionOutput,
            model: decisionResult.model,
            usedFallback: decisionResult.usedFallback,
            outputSummary: decisionOutput ? {
                headline: decisionOutput.summary?.headline,
                highlightsCount: decisionOutput.summary?.highlights?.length || 0,
                actionsCount
            } : null
        }, { channelId: channelID, destination: 'both' });

        // Operator-only one-liner so it's easy to grep for "0 actions + fallback" runs.
        // NOTE: this is not surfaced to streamers/users.
        // eslint-disable-next-line no-console
        console.log(`[STREAM MEMORY] channelID=${channelID} mode=${input.source} actions=${actionsCount} model=${decisionResult.model || 'unknown'} fallback=${decisionResult.usedFallback ? 'yes' : 'no'}`);

        if (actionsCount === 0 && decisionResult.usedFallback) {
            await logWarn({
                message: '[STREAM SUMMARY WORKFLOW] Zero actions returned and fallback model was used — check decider logs',
                step: 'ZERO_ACTIONS_WITH_FALLBACK',
                channelID,
                mode: input.source,
                model: decisionResult.model,
                decisionMessage: decisionResult.message
            }, { channelId: channelID, destination: 'both' });
        }

        if (!decisionOutput) {
            await logError({
                message: '[STREAM SUMMARY WORKFLOW] No AI decision output - marking as failed',
                step: 'NO_DECISION_OUTPUT',
                channelID,
                decisionError: decisionResult.error,
                decisionMessage: decisionResult.message
            }, { channelId: channelID, destination: 'both' });

            const failedSummary = await saveSummaryRecord({
                channelID,
                channelName,
                source: input.source,
                context,
                status: 'failed',
                summary: {
                    headline: `Stream summary for ${channelName}`,
                    recap: 'Failed to produce AI summary output.',
                    highlights: []
                },
                proposedActions: [],
                appliedActions: [],
                totals: {
                    proposed: 0,
                    applied: 0,
                    skipped: 0,
                    failed: 1
                },
                errorMessage: decisionResult.message || 'Missing AI decision output'
            });

            return {
                error: true,
                message: decisionResult.message || 'Failed to generate stream summary decision',
                status: 'failed',
                summaryID: failedSummary?._id
            };
        }

        // Check if channel has no approved memories yet (new channel for memory purposes)
        const hasApprovedMemories = (context.existingMemories?.length ?? 0) > 0;
        const isNewChannel = !hasApprovedMemories;

        await logInfo({
            message: config.enabled
                ? '[STREAM SUMMARY WORKFLOW] Step 5: Applying memory actions'
                : '[STREAM SUMMARY WORKFLOW] Step 5: Learning disabled; skipping memory actions',
            step: 'APPLY_ACTIONS',
            channelID,
            learningEnabled: config.enabled,
            isNewChannel,
            existingMemoriesCount: context.existingMemories?.length || 0,
            actionsToApply: decisionOutput.actions?.length || 0
        }, { channelId: channelID, destination: 'both' });

        const proposedActions = Array.isArray(decisionOutput.actions) ? decisionOutput.actions : [];
        const applyResult: IApplyStreamMemoryActionsResult = config.enabled
            ? await applyStreamMemoryActions({
                channelID,
                channelName,
                actions: proposedActions,
                source: input.source,
                isNewChannel
            })
            : {
                results: proposedActions.map((action) => ({
                    action: action.action,
                    targetMemoryId: String(action.targetMemoryId || ''),
                    status: 'skipped' as const,
                    reason: 'learning_disabled'
                })),
                totals: {
                    proposed: proposedActions.length,
                    applied: 0,
                    skipped: proposedActions.length,
                    failed: 0
                }
            };

        const actionCounts = new Map<string, number>();
        for (const result of applyResult.results) {
            const key = `${result.action}:${result.status}`;
            actionCounts.set(key, (actionCounts.get(key) || 0) + 1);
        }
        for (const [actionStatus, count] of actionCounts.entries()) {
            void recordStreamMemoryActionMetric({
                channelID,
                source: input.source,
                action: actionStatus,
                count
            });
        }

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Memory actions applied',
            step: 'ACTIONS_APPLIED',
            channelID,
            actionCounts: Object.fromEntries(actionCounts),
            totals: applyResult.totals
        }, { channelId: channelID, destination: 'both' });

        const status = applyResult.totals.applied > 0 ? 'applied' : 'noop';

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 6: Saving summary record to MongoDB',
            step: 'SAVE_SUMMARY',
            channelID,
            status
        }, { channelId: channelID, destination: 'both' });

        const summaryDoc = await saveSummaryRecord({
            channelID,
            channelName,
            source: input.source,
            context,
            status,
            summary: decisionOutput.summary,
            proposedActions: decisionOutput.actions,
            appliedActions: applyResult.results,
            totals: applyResult.totals,
            errorMessage: decisionResult.error ? decisionResult.message : ''
        });

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Summary saved to MongoDB',
            step: 'SUMMARY_SAVED',
            channelID,
            summaryID: summaryDoc?._id,
            status
        }, { channelId: channelID, destination: 'both' });

        // Send stream summary email for active accounts
        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] Step 7: Processing email notification',
            step: 'EMAIL_CHECK',
            channelID,
            source: input.source,
            decisionError: decisionResult.error,
            shouldSendEmail: !decisionResult.error && input.source === 'stream_offline'
        }, { channelId: channelID, destination: 'both' });

        if (!decisionResult.error && input.source === 'stream_offline') {
            await logInfo({
                message: '[STREAM SUMMARY WORKFLOW] Sending stream summary email',
                step: 'SEND_EMAIL',
                channelID,
                channelName,
                emailSubject: getStreamSummaryEmailSubject(
                    context.session.startedAt ? new Date(context.session.startedAt).toLocaleDateString() : 'Recent Stream',
                    'en'
                )
            }, { channelId: channelID, destination: 'both' });

            void sendStreamSummaryEmail({
                channelID,
                channelName,
                context,
                summary: decisionOutput.summary,
                appliedActions: applyResult.results
            }).then(() => {
                logInfo({
                    message: '[STREAM SUMMARY WORKFLOW] Email sent successfully',
                    step: 'EMAIL_SENT',
                    channelID,
                    emailRecipient: channelName
                }, { channelId: channelID, destination: 'both' });
            }).catch((emailError) => {
                logError({
                    message: '[STREAM SUMMARY WORKFLOW] Failed to send stream summary email',
                    step: 'EMAIL_FAILED',
                    channelID,
                    error: emailError instanceof Error ? emailError.message : String(emailError),
                    errorStack: emailError instanceof Error ? emailError.stack : undefined
                }, { channelId: channelID, destination: 'both' });
            });
        } else {
            await logInfo({
                message: '[STREAM SUMMARY WORKFLOW] Skipping email - decision had error or not stream_offline source',
                step: 'EMAIL_SKIPPED',
                channelID,
                reason: decisionResult.error ? 'decisionError' : `source=${input.source}`
            }, { channelId: channelID, destination: 'both' });

            await debug({
                message: '[STREAM SUMMARY WORKFLOW] Email Skipped',
                step: 'EMAIL_SKIPPED',
                channelID,
                channelName,
                source: input.source,
                emailSendCondition: '!decisionResult.error && input.source === \'stream_offline\'',
                decisionError: decisionResult.error,
                decisionMessage: decisionResult.error ? decisionResult.message : undefined,
                decisionModel: decisionResult.model,
                decisionHasOutput: !!decisionOutput,
                outputSummary: decisionOutput ? {
                    headline: decisionOutput.summary?.headline,
                    recap: decisionOutput.summary?.recap,
                    highlightsCount: decisionOutput.summary?.highlights?.length || 0,
                    actionsCount: decisionOutput.actions?.length || 0
                } : undefined,
                decisionOutput: decisionOutput || undefined,
                appliedActions: applyResult.results,
                emailSubject: getStreamSummaryEmailSubject(
                    context.session.startedAt ? new Date(context.session.startedAt).toLocaleDateString() : 'Recent Stream',
                    'en'
                ),
                sessionStreamID: context.session.streamID,
                sessionStartedAt: context.session.startedAt,
                sessionDurationMinutes: context.session.durationMinutes
            }, { channelId: channelID, destination: 'both' });
        }

        await logInfo({
            message: '[STREAM SUMMARY WORKFLOW] ========================================== WORKFLOW COMPLETE',
            step: 'COMPLETE',
            channelID,
            status,
            summaryID: summaryDoc?._id,
            totalDurationMs: Date.now() - workflowStartTime
        }, { channelId: channelID, destination: 'both' });

        return {
            error: false,
            message: status === 'applied'
                ? 'Stream memory workflow completed with applied actions'
                : 'Stream memory workflow completed with no applied actions',
            status,
            summaryID: summaryDoc?._id
        };
    }
    catch (error) {
        await logError({
            message: '[STREAM SUMMARY WORKFLOW] ========================================== WORKFLOW FAILED',
            step: 'WORKFLOW_ERROR',
            channelID: input.channelID,
            error: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            input,
            durationMs: Date.now() - workflowStartTime
        }, { channelId: input.channelID, destination: 'both' });

        return {
            error: true,
            message: 'Failed to run stream memory workflow',
            status: 'failed'
        };
    }
}

interface SendStreamSummaryEmailParams {
    channelID: string;
    channelName: string;
    context: StreamSummaryContext;
    summary: {
        headline: string;
        recap: string;
        highlights: string[];
    };
    appliedActions: IApplyStreamMemoryActionsResult['results'];
}

async function sendStreamSummaryEmail(params: SendStreamSummaryEmailParams): Promise<void> {
    await logInfo({
        message: '[STREAM SUMMARY EMAIL] ==========================================',
        step: 'EMAIL_START',
        channelID: params.channelID,
        channelName: params.channelName,
        timestamp: new Date().toISOString()
    }, { channelId: params.channelID, destination: 'both' });

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Step 1: Looking up user in MongoDB',
        step: 'FIND_USER',
        channelID: params.channelID,
        query: { 'accounts.id': params.channelID, 'accounts.type': 'twitch' }
    }, { channelId: params.channelID, destination: 'both' });

    // Get user to check plan tier and activation status
    const user = await UsersSchema.findOne({
        'accounts.id': params.channelID,
        'accounts.type': 'twitch'
    }).lean();

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] User lookup result',
        step: 'USER_FOUND',
        channelID: params.channelID,
        found: !!user,
        hasEmail: !!user?.email,
        emailValue: user?.email,
        accountsCount: user?.accounts?.length || 0
    }, { channelId: params.channelID, destination: 'both' });

    if (!user) {
        await logWarn({
            message: '[STREAM SUMMARY EMAIL] User not found in database - cannot send email',
            step: 'USER_NOT_FOUND',
            channelID: params.channelID,
            query: { 'accounts.id': params.channelID, 'accounts.type': 'twitch' }
        }, { channelId: params.channelID, destination: 'both' });
        return;
    }

    // Check if user has an active account
    const twitchAccount = user.accounts.find((acc: any) => acc.type === 'twitch' && acc.id === params.channelID);

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Checking Twitch account status',
        step: 'CHECK_ACCOUNT',
        channelID: params.channelID,
        twitchAccountFound: !!twitchAccount,
        isActive: twitchAccount?.actived,
        hasEmail: !!twitchAccount?.email
    }, { channelId: params.channelID, destination: 'both' });

    if (!twitchAccount || !twitchAccount.actived) {
        await logWarn({
            message: '[STREAM SUMMARY EMAIL] Twitch account not active - cannot send email',
            step: 'ACCOUNT_NOT_ACTIVE',
            channelID: params.channelID,
            twitchAccountFound: !!twitchAccount,
            isActive: twitchAccount?.actived,
            accountDetails: twitchAccount ? {
                id: twitchAccount.id,
                type: twitchAccount.type,
                actived: twitchAccount.actived,
                hasEmail: !!twitchAccount.email
            } : null
        }, { channelId: params.channelID, destination: 'both' });
        return;
    }

    // Get user email
    const email = user.email || twitchAccount.email;

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Email address resolved',
        step: 'GOT_EMAIL',
        channelID: params.channelID,
        email,
        emailSource: user.email ? 'user.email' : 'twitchAccount.email'
    }, { channelId: params.channelID, destination: 'both' });

    if (!email) {
        await logWarn({
            message: '[STREAM SUMMARY EMAIL] No email address found - cannot send email',
            step: 'NO_EMAIL',
            channelID: params.channelID,
            userEmail: user.email,
            twitchAccountEmail: twitchAccount.email
        }, { channelId: params.channelID, destination: 'both' });
        return;
    }

    // Get user's language preference
    const language = user.language === 'es' ? 'es' : 'en';

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] User language preference',
        step: 'GOT_LANGUAGE',
        channelID: params.channelID,
        userLanguage: user.language,
        resolvedLanguage: language
    }, { channelId: params.channelID, destination: 'both' });

    // Format stream date based on language
    const locale = language === 'es' ? 'es-ES' : 'en-US';
    const streamDate = params.context.session.startedAt
        ? new Date(params.context.session.startedAt).toLocaleDateString(locale, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric'
          })
        : language === 'es' ? 'Stream Reciente' : 'Recent Stream';

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Stream date formatted',
        step: 'FORMATTED_DATE',
        channelID: params.channelID,
        streamDate,
        startedAt: params.context.session.startedAt,
        locale
    }, { channelId: params.channelID, destination: 'both' });

    // Truncate recap to ~300 characters
    const maxRecapLength = 300;
    let recapSnippet = params.summary.recap;
    if (recapSnippet.length > maxRecapLength) {
        recapSnippet = recapSnippet.substring(0, maxRecapLength).trim() + '...';
    }

    // Count created memories
    const memoryCount = params.appliedActions.filter(
        (action: any) => action.status === 'applied' && (action.action === 'create' || action.action === 'edit')
    ).length;

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Email content prepared',
        step: 'CONTENT_READY',
        channelID: params.channelID,
        headline: params.summary.headline,
        recapLength: params.summary.recap.length,
        truncatedRecap: recapSnippet.length,
        highlightsCount: params.summary.highlights?.length || 0,
        memoryCount
    }, { channelId: params.channelID, destination: 'both' });

    // Build the full summary link
    const fullSummaryLink = `${DASHBOARD_URL}/${params.channelName}/modules/stream-summary/${params.context.session.streamID || 'latest'}`;

    await logInfo({
        message: '[STREAM SUMMARY EMAIL] Step 2: Sending email via Resend',
        step: 'SEND_EMAIL',
        channelID: params.channelID,
        to: email,
        subject: getStreamSummaryEmailSubject(streamDate, language),
        dashboardUrl: DASHBOARD_URL,
        summaryLink: fullSummaryLink
    }, { channelId: params.channelID, destination: 'both' });

    try {
        await sendEmail({
            to: email,
            subject: getStreamSummaryEmailSubject(streamDate, language),
            from: "DomDimaBot <summaries@notifications.domdimabot.com>",
            emailComponent: StreamSummaryEmail({
                streamerName: params.channelName,
                streamDate,
                streamDuration: params.context.session.durationMinutes,
                headline: params.summary.headline,
                recapSnippet,
                highlights: params.summary.highlights,
                stats: {
                    averageViewers: params.context.session.averageViewers,
                    peakViewers: params.context.session.peakViewers,
                    follows: params.context.session.follows,
                    subs: params.context.session.subs,
                    bits: params.context.session.bits,
                    donations: params.context.session.donations
                },
                memoryCount,
                fullSummaryLink,
                dashboardLink: DASHBOARD_URL,
                language
            })
        });

        await logInfo({
            message: '[STREAM SUMMARY EMAIL] ========================================== EMAIL SENT SUCCESSFULLY',
            step: 'EMAIL_COMPLETE',
            channelID: params.channelID,
            recipient: email,
            streamDate,
            timestamp: new Date().toISOString()
        }, { channelId: params.channelID, destination: 'both' });
    } catch (sendError) {
        await logError({
            message: '[STREAM SUMMARY EMAIL] Failed to send email',
            step: 'EMAIL_ERROR',
            channelID: params.channelID,
            recipient: email,
            error: sendError instanceof Error ? sendError.message : String(sendError),
            errorStack: sendError instanceof Error ? sendError.stack : undefined
        }, { channelId: params.channelID, destination: 'both' });
        throw sendError;
    }
}
