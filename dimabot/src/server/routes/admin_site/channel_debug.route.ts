import express from 'express';
import {
    BOT_LOG_LEVELS, channelLogs, commandStats, eventsubActivity, type BotLogFilter
} from '../../services/admin_channel_debug.service.js';
import { AdminRequestError, ownerGet, queryEnum, queryInt, queryTwitchId, type AuthRequest } from './shared.js';

/** Owner-only admin site routes, mounted under `/admin-site` by `admin_site.route.ts`. */
const router = express.Router();

const LOG_FILTERS: readonly BotLogFilter[] = ['problems', ...BOT_LOG_LEVELS];

function channelParam(req: AuthRequest): string {
    const channelID = queryTwitchId(req.params.channelID, 'channel');
    if (!channelID) throw new AdminRequestError('Invalid channel');
    return channelID;
}

/** The bot's own log lines for the channel (7 days, from the Dragonfly logger). */
ownerGet(router, '/users/:channelID/logs', (req) => {
    const channelID = channelParam(req);
    const level = queryEnum(req.query.level, 'level', LOG_FILTERS, 'problems');
    const limit = queryInt(req.query.limit, 'limit', 50, 1, 200);
    return channelLogs(channelID, level, limit);
});

ownerGet(router, '/users/:channelID/command-stats', (req) => {
    const channelID = channelParam(req);
    return commandStats(channelID, queryInt(req.query.days, 'days', 7, 1, 30));
});

ownerGet(router, '/users/:channelID/eventsub-activity', (req) => eventsubActivity(channelParam(req)));

export const adminChannelDebugRouter = router;
