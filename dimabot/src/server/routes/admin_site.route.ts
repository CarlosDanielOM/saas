import express, { type Request, type Response } from 'express';
import UsersSchema from '../../schemas/users.schema.js';
import { CommandsSchema } from '../../schemas/commands.schema.js';
import EventsubSchema from '../../schemas/eventsub.schema.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getTwitchAppHeader } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { grantPolarAiCredits } from '../../utils/polarsh.js';
import {
    AI_CREDITS_CACHE_SCHEMA_VERSION,
    AI_CREDITS_CACHE_TTL_SECONDS,
    AI_CREDITS_METER_ID,
    getAiCredits
} from '../../utils/billing.js';
import { sendEmail, EMAIL_AUTH_BASE_URL, signEmailActivationToken } from '../../utils/email/email.service.js';
import { ActivationReminderEmail, getActivationReminderSubject } from '../../utils/email/templates/activation-reminder.js';

interface AuthRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

interface TwitchLiveStream {
    user_id: string;
    viewer_count?: number;
}

interface AggregatedUser {
    channelID: string;
    channel: string;
    email: string;
    plan_tier: 'free' | 'premium' | 'pro';
    actived: boolean;
    chat_enabled: boolean;
    has_permissions: boolean;
    up_to_date_permissions: boolean;
    reminder_sent_at?: Date | null;
    created_at?: Date;
    updated_at?: Date;
}

interface AdminUserRow extends AggregatedUser {
    isLive: boolean;
    liveViewers: number;
    commandsCount: number;
    eventsubsActiveCount: number;
    eventsubsDisabledCount: number;
}

const SUPER_ADMIN_LOGIN = 'cdom201';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_SORT_BY = 'channel';
const DEFAULT_SORT_ORDER = 'asc';
const MAX_AI_CREDIT_GRANT = 5_000_000;

type SortOrder = 'asc' | 'desc';

const router = express.Router();

function parsePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

function parseCreditGrantAmount(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 0;
    }

    return Math.floor(parsed);
}

function chunkArray<T>(items: T[], size: number): T[][] {
    if (size <= 0) {
        return [items];
    }

    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

function normalizeSortOrder(value: unknown): SortOrder {
    return String(value || '').toLowerCase() === 'desc' ? 'desc' : 'asc';
}

function compareValues(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }

    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return Number(a) - Number(b);
    }

    const left = String(a ?? '').toLowerCase();
    const right = String(b ?? '').toLowerCase();
    return left.localeCompare(right);
}

function ensureSuperAdmin(req: AuthRequest, res: Response): boolean {
    const requesterLogin = String(req.user?.login || '').toLowerCase();
    if (requesterLogin !== SUPER_ADMIN_LOGIN) {
        res.status(403).json({
            error: true,
            message: 'You do not have permission to access this endpoint',
            status: 403
        });
        return false;
    }

    return true;
}

async function fetchLiveByChannelIds(channelIDs: string[]): Promise<Map<string, TwitchLiveStream>> {
    const liveByChannelID = new Map<string, TwitchLiveStream>();
    const uniqueIDs = Array.from(new Set(channelIDs.filter((id) => Boolean(id))));

    if (!uniqueIDs.length) {
        return liveByChannelID;
    }

    const appHeader = await getTwitchAppHeader();
    const batches = chunkArray(uniqueIDs, 100);

    for (const batch of batches) {
        const params = new URLSearchParams({ type: 'live' });
        for (const channelID of batch) {
            params.append('user_id', channelID);
        }

        const response = await fetch(getTwitchHelixUrl('streams', params.toString()), {
            headers: {
                'Client-Id': appHeader['Client-Id'],
                'Authorization': appHeader.Authorization,
                'Content-Type': appHeader['Content-Type']
            }
        });

        if (!response.ok) {
            continue;
        }

        const payload = await response.json();
        const streams = Array.isArray(payload?.data) ? payload.data as TwitchLiveStream[] : [];
        for (const stream of streams) {
            if (!stream.user_id) {
                continue;
            }
            liveByChannelID.set(stream.user_id, stream);
        }
    }

    return liveByChannelID;
}

router.get('/users', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const page = parsePositiveInt(req.query.page, 1);
        const limit = Math.min(MAX_LIMIT, parsePositiveInt(req.query.limit, DEFAULT_LIMIT));
        const search = String(req.query.search || '').trim().toLowerCase();
        const sortBy = String(req.query.sortBy || DEFAULT_SORT_BY);
        const sortOrder = normalizeSortOrder(req.query.sortOrder || DEFAULT_SORT_ORDER);

        const matchStage: Record<string, unknown> = {
            'accounts.type': 'twitch'
        };

        if (search) {
            matchStage.$or = [
                { 'accounts.name': { $regex: search, $options: 'i' } },
                { 'accounts.id': { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        const aggregateBase = [
            { $unwind: '$accounts' },
            { $match: matchStage }
        ];

        const users: AggregatedUser[] = await UsersSchema.aggregate([
            ...aggregateBase,
            {
                $project: {
                    _id: 0,
                    channelID: '$accounts.id',
                    channel: '$accounts.name',
                    email: '$accounts.email',
                    plan_tier: '$plan_tier',
                    actived: '$accounts.actived',
                    chat_enabled: '$accounts.chat_enabled',
                    has_permissions: '$accounts.has_permissions',
                    up_to_date_permissions: '$accounts.up_to_date_permissions',
                    reminder_sent_at: '$reminder_sent_at',
                    created_at: '$created_at',
                    updated_at: '$updated_at'
                }
            }
        ]);
        
        const total = users.length;
        const channelIDs = users.map((user) => user.channelID).filter((channelID) => Boolean(channelID));

        if (!channelIDs.length) {
            return res.status(200).json({
                error: false,
                message: 'Admin users fetched successfully',
                status: 200,
                data: {
                    rows: [],
                    pagination: {
                        page,
                        limit,
                        total: 0,
                        totalPages: 1
                    },
                    summary: {
                        totalChannels: 0,
                        activeBots: 0,
                        inactiveBots: 0,
                        withPermissions: 0,
                        permissionsNeedUpdate: 0,
                        liveChannels: 0,
                        liveViewers: 0,
                        totalCommands: 0,
                        totalEventsubsActive: 0,
                        totalEventsubsDisabled: 0
                    }
                }
            });
        }

        const [commandsCountAgg, eventsubCountAgg, liveByChannelID] = await Promise.all([
            CommandsSchema.aggregate([
                { $match: { channelID: { $in: channelIDs } } },
                { $group: { _id: '$channelID', count: { $sum: 1 } } }
            ]),
            EventsubSchema.aggregate([
                { $match: { channelID: { $in: channelIDs } } },
                {
                    $group: {
                        _id: '$channelID',
                        activeCount: {
                            $sum: {
                                $cond: [{ $eq: ['$enabled', true] }, 1, 0]
                            }
                        },
                        disabledCount: {
                            $sum: {
                                $cond: [{ $eq: ['$enabled', false] }, 1, 0]
                            }
                        }
                    }
                }
            ]),
            fetchLiveByChannelIds(channelIDs)
        ]);

        const commandsByChannel = new Map<string, number>(
            commandsCountAgg.map((row) => [String(row._id), Number(row.count || 0)])
        );

        const eventsubsByChannel = new Map<string, { active: number; disabled: number }>(
            eventsubCountAgg.map((row) => [
                String(row._id),
                {
                    active: Number(row.activeCount || 0),
                    disabled: Number(row.disabledCount || 0)
                }
            ])
        );

        const fullRows: AdminUserRow[] = users.map((user) => {
            const live = liveByChannelID.get(user.channelID);
            const eventsubs = eventsubsByChannel.get(user.channelID) || { active: 0, disabled: 0 };

            return {
                ...user,
                isLive: Boolean(live),
                liveViewers: Number(live?.viewer_count || 0),
                commandsCount: Number(commandsByChannel.get(user.channelID) || 0),
                eventsubsActiveCount: eventsubs.active,
                eventsubsDisabledCount: eventsubs.disabled
            };
        });

        const sortableGetters: Record<string, (row: AdminUserRow) => unknown> = {
            channel: (row) => row.channel,
            plan_tier: (row) => row.plan_tier,
            actived: (row) => row.actived,
            has_permissions: (row) => row.has_permissions && row.up_to_date_permissions,
            chat_enabled: (row) => row.chat_enabled,
            isLive: (row) => row.isLive,
            liveViewers: (row) => row.liveViewers,
            commandsCount: (row) => row.commandsCount,
            eventsubsActiveCount: (row) => row.eventsubsActiveCount,
            eventsubsDisabledCount: (row) => row.eventsubsDisabledCount,
            created_at: (row) => row.created_at ? new Date(row.created_at).getTime() : 0,
            updated_at: (row) => row.updated_at ? new Date(row.updated_at).getTime() : 0
        };

        const getSortValue = sortableGetters[sortBy] || sortableGetters[DEFAULT_SORT_BY];
        const sortedRows = [...fullRows].sort((left, right) => {
            const compared = compareValues(getSortValue(left), getSortValue(right));
            if (compared === 0) {
                return compareValues(left.channel, right.channel);
            }
            return sortOrder === 'asc' ? compared : -compared;
        });

        const totalPages = Math.max(1, Math.ceil(total / limit));
        const normalizedPage = Math.min(page, totalPages);
        const skip = (normalizedPage - 1) * limit;
        const rows = sortedRows.slice(skip, skip + limit);

        const summary = fullRows.reduce((acc, row) => {
            acc.totalChannels += 1;
            if (row.actived) {
                acc.activeBots += 1;
            }
            if (row.has_permissions && row.up_to_date_permissions) {
                acc.withPermissions += 1;
            }
            if (row.isLive) {
                acc.liveChannels += 1;
                acc.liveViewers += row.liveViewers;
            }
            acc.totalCommands += row.commandsCount;
            acc.totalEventsubsActive += row.eventsubsActiveCount;
            acc.totalEventsubsDisabled += row.eventsubsDisabledCount;
            return acc;
        }, {
            totalChannels: 0,
            activeBots: 0,
            withPermissions: 0,
            liveChannels: 0,
            liveViewers: 0,
            totalCommands: 0,
            totalEventsubsActive: 0,
            totalEventsubsDisabled: 0
        });

        return res.status(200).json({
            error: false,
            message: 'Admin users fetched successfully',
            status: 200,
            data: {
                rows,
                pagination: {
                    page: normalizedPage,
                    limit,
                    total,
                    totalPages
                },
                summary: {
                    totalChannels: summary.totalChannels,
                    activeBots: summary.activeBots,
                    inactiveBots: Math.max(0, summary.totalChannels - summary.activeBots),
                    withPermissions: summary.withPermissions,
                    permissionsNeedUpdate: Math.max(0, summary.totalChannels - summary.withPermissions),
                    liveChannels: summary.liveChannels,
                    liveViewers: summary.liveViewers,
                    totalCommands: summary.totalCommands,
                    totalEventsubsActive: summary.totalEventsubsActive,
                    totalEventsubsDisabled: summary.totalEventsubsDisabled
                }
            }
        });
    } catch (error) {
        console.error('Error in GET /admin-site/users:', {
            user: req.user?.login,
            query: req.query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/users/:channelID/commands', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const page = parsePositiveInt(req.query.page, 1);
        const limit = Math.min(MAX_LIMIT, parsePositiveInt(req.query.limit, DEFAULT_LIMIT));
        const skip = (page - 1) * limit;
        const search = String(req.query.search || '').trim();
        const sortBy = String(req.query.sortBy || 'createdAt');
        const sortOrder = normalizeSortOrder(req.query.sortOrder || 'desc');

        const match: Record<string, unknown> = { channelID: channelIdStr };
        if (search) {
            match.$or = [
                { name: { $regex: search, $options: 'i' } },
                { cmd: { $regex: search, $options: 'i' } },
                { func: { $regex: search, $options: 'i' } },
                { message: { $regex: search, $options: 'i' } }
            ];
        }

        const commandSortMap: Record<string, string> = {
            createdAt: 'createdAt',
            name: 'name',
            cmd: 'cmd',
            func: 'func',
            enabled: 'enabled',
            cooldown: 'cooldown',
            userLevelName: 'userLevelName'
        };
        const mongoSortField = commandSortMap[sortBy] || 'createdAt';
        const mongoSortOrder = sortOrder === 'asc' ? 1 : -1;

        const [total, rows] = await Promise.all([
            CommandsSchema.countDocuments(match),
            CommandsSchema.find(match)
                .select('_id name cmd func message enabled cooldown userLevelName createdAt')
                .sort({ [mongoSortField]: mongoSortOrder })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        return res.status(200).json({
            error: false,
            message: 'Admin user commands fetched successfully',
            status: 200,
            data: {
                rows: rows.map((row) => ({
                    id: String(row._id),
                    name: row.name || '',
                    cmd: row.cmd || '',
                    func: row.func || '',
                    message: row.message || '',
                    enabled: Boolean(row.enabled),
                    cooldown: Number(row.cooldown || 0),
                    userLevelName: row.userLevelName || '',
                    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined
                })),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / limit))
                }
            }
        });
    } catch (error) {
        console.error('Error in GET /admin-site/users/:channelID/commands:', {
            user: req.user?.login,
            channelID: req.params.channelID,
            query: req.query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/users/:channelID/eventsubs', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const page = parsePositiveInt(req.query.page, 1);
        const limit = Math.min(MAX_LIMIT, parsePositiveInt(req.query.limit, DEFAULT_LIMIT));
        const skip = (page - 1) * limit;
        const search = String(req.query.search || '').trim();
        const sortBy = String(req.query.sortBy || 'created_at');
        const sortOrder = normalizeSortOrder(req.query.sortOrder || 'desc');

        const match: Record<string, unknown> = { channelID: channelIdStr };
        if (search) {
            match.$or = [
                { type: { $regex: search, $options: 'i' } },
                { status: { $regex: search, $options: 'i' } },
                { message: { $regex: search, $options: 'i' } },
                { endMessage: { $regex: search, $options: 'i' } }
            ];
        }

        const eventsubSortMap: Record<string, string> = {
            created_at: 'created_at',
            type: 'type',
            status: 'status',
            version: 'version',
            enabled: 'enabled'
        };
        const mongoSortField = eventsubSortMap[sortBy] || 'created_at';
        const mongoSortOrder = sortOrder === 'asc' ? 1 : -1;

        const [total, rows] = await Promise.all([
            EventsubSchema.countDocuments(match),
            EventsubSchema.find(match)
                .select('_id type status version enabled message endMessage created_at')
                .sort({ [mongoSortField]: mongoSortOrder })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        return res.status(200).json({
            error: false,
            message: 'Admin user eventsubs fetched successfully',
            status: 200,
            data: {
                rows: rows.map((row) => ({
                    id: String(row._id),
                    type: row.type || '',
                    status: row.status || '',
                    version: row.version || '',
                    enabled: Boolean(row.enabled),
                    message: row.message || '',
                    endMessage: row.endMessage || '',
                    created_at: row.created_at || ''
                })),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / limit))
                }
            }
        });
    } catch (error) {
        console.error('Error in GET /admin-site/users/:channelID/eventsubs:', {
            user: req.user?.login,
            channelID: req.params.channelID,
            query: req.query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

// Send real (production-style) activation reminder email
router.post('/users/:channelID/send-reminder', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const user = await UsersSchema.findOne({ 'accounts.id': channelIdStr }).lean();
        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const twitchAccount = (user as any).accounts?.find((acc: any) => acc.type === 'twitch' && acc.id === channelIdStr);
        if (!twitchAccount) {
            return res.status(404).json({
                error: true,
                message: 'Twitch account not found for this user',
                status: 404
            });
        }

        const email = twitchAccount.email || (user as any).email;
        if (!email) {
            return res.status(400).json({
                error: true,
                message: 'User has no email address on file',
                status: 400
            });
        }

        const twitchLogin = twitchAccount.name || channelIdStr;
        const userLanguage = (user as any).language === 'es' ? 'es' : 'en';

        // Generate real activation JWT + link (same as the cron worker)
        const token = signEmailActivationToken(String((user as any)._id), twitchLogin);
        const activationLink = `${EMAIL_AUTH_BASE_URL}?token=${encodeURIComponent(token)}`;

        // Send the real production reminder email (no [TEST] prefix)
        const emailResult = await sendEmail({
            to: email,
            subject: getActivationReminderSubject(userLanguage),
            emailComponent: ActivationReminderEmail({
                streamerName: twitchLogin,
                activationLink,
                language: userLanguage
            })
        });

        if (emailResult.error) {
            console.error('[ADMIN] Failed to send reminder email:', {
                channelID: channelIdStr,
                email,
                error: emailResult.message
            });
            return res.status(500).json({
                error: true,
                message: 'Failed to send reminder email',
                status: 500
            });
        }

        // Update reminder_sent_at for audit (best effort)
        try {
            await UsersSchema.updateOne(
                { _id: (user as any)._id },
                { $set: { reminder_sent_at: new Date() } }
            );
        } catch (updateErr) {
            console.warn('[ADMIN] Could not update reminder_sent_at:', updateErr);
        }

        return res.status(200).json({
            error: false,
            message: `Reminder sent to ${twitchLogin}`,
            status: 200
        });
    } catch (error) {
        console.error('Error in POST /admin-site/users/:channelID/send-reminder:', {
            user: req.user?.login,
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/users/:channelID/ai-credits', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const user = await UsersSchema.findOne({
            'accounts.id': channelIdStr,
            'accounts.type': 'twitch'
        });

        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const credits = await getAiCredits(user, channelIdStr);

        return res.status(200).json({
            error: false,
            message: 'AI credits fetched successfully',
            status: 200,
            data: credits
        });
    } catch (error) {
        console.error('Error in GET /admin-site/users/:channelID/ai-credits:', {
            user: req.user?.login,
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.post('/users/:channelID/ai-credits/grant', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        if (!ensureSuperAdmin(req, res)) {
            return;
        }

        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const credits = parseCreditGrantAmount(req.body?.credits);
        const reason = String(req.body?.reason || 'admin_manual_credit_grant').trim().slice(0, 180);

        if (!credits || credits <= 0) {
            return res.status(400).json({
                error: true,
                message: 'credits must be a positive number',
                status: 400
            });
        }

        if (credits > MAX_AI_CREDIT_GRANT) {
            return res.status(400).json({
                error: true,
                message: `credits cannot exceed ${MAX_AI_CREDIT_GRANT}`,
                status: 400
            });
        }

        const user = await UsersSchema.findOne({
            'accounts.id': channelIdStr,
            'accounts.type': 'twitch'
        });

        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        if (!user.polar_sh_customer_id) {
            return res.status(400).json({
                error: true,
                message: 'User does not have a Polar customer ID',
                status: 400
            });
        }

        const grantResult = await grantPolarAiCredits({
            customerId: user.polar_sh_customer_id,
            credits,
            reason,
            adminLogin: req.user?.login
        });

        if (grantResult.error) {
            return res.status(502).json({
                error: true,
                message: grantResult.message || 'Failed to grant credits in Polar',
                status: 502,
                data: grantResult.details
            });
        }

        // Optimistically reflect the grant locally. Polar webhook/customer state will reconcile later.
        const cache = await getDragonflyClient('adminGrantAiCredits');
        const before = await getAiCredits(user, channelIdStr);
        const after = {
            ...before,
            version: AI_CREDITS_CACHE_SCHEMA_VERSION,
            limit: before.limit + credits,
            balance: before.balance + credits,
            meterId: AI_CREDITS_METER_ID,
            updatedAt: new Date().toISOString(),
            available: true
        };

        await cache.set(`twitch:${channelIdStr}:ai:credits`, JSON.stringify(after), { EX: AI_CREDITS_CACHE_TTL_SECONDS });

        const exhaustKeys = [`twitch:${channelIdStr}:ai:exhaust`, `${channelIdStr}:ai:exhaust`];
        if (after.balance > 0) {
            await Promise.all(exhaustKeys.map((key) => cache.del(key)));
        }

        return res.status(200).json({
            error: false,
            message: `Granted ${credits} AI credits to channel ${channelIdStr}`,
            status: 200,
            data: {
                granted: credits,
                before,
                after
            }
        });
    } catch (error) {
        console.error('Error in POST /admin-site/users/:channelID/ai-credits/grant:', {
            user: req.user?.login,
            channelID: req.params.channelID,
            body: req.body,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

export const adminSiteRoute = router;
