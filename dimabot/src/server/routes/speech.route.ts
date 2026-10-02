import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';

import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { ttsQueueHandler, type TtsRequestPayload } from '../../handlers/tts_queue.handler.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { hasGlobalChannelOwnerAccess } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import { addFishVoiceFavorite, getFishVoiceFavorites, removeFishVoiceFavorite, renameFishVoiceFavorite, FavoriteAliasError, MAX_FISH_VOICE_FAVORITES } from '../../schemas/channel_fish_voice_favorites.schema.js';
import {
    getChannelTtsSettings,
    normalizeChannelTtsSettings,
    upsertChannelTtsSettings,
    type ChannelTtsSettingsData,
    type TtsProvider,
    type TtsLanguage,
    type TtsMode
} from '../../schemas/channel_tts_settings.schema.js';
import { KOKORO_VOICES, resolveKokoroVoice } from '../../utils/tts/kokoro_voices.util.js';
import { FISH_VOICES } from '../services/tts/fish_tts.service.js';
import { resolveFishVoice, getFishVoice, searchFishVoices, parseVoiceSearch, VoiceRequestError } from '../services/tts/fish_voice_catalog.service.js';
import { createPreviewTicket } from '../services/tts/voice_preview.service.js';
import type { RuntimeTtsProvider } from '../services/tts/tts_provider.interface.js';
import { getDirname } from '../../utils/pollyfills.js';
import { filterExpressiveTtsTags, normalizeTtsMessage } from '../../utils/tts/normalize_tts_message.util.js';

const __dirname = getDirname(import.meta.url);
const router = express.Router();
const publicDir = path.join(__dirname, 'public');

interface SpeechPostBody {
    mode?: TtsMode;
    provider?: TtsProvider;
    text?: string;
    language?: TtsLanguage;
    voice?: string;
    cloneName?: string;
    requestedBy?: {
        userID?: string;
        userLogin?: string;
        userName?: string;
        userLevel?: number;
    };
    meta?: {
        source?: 'chat-command' | 'ast' | 'redemption';
        originalText?: string;
        skipEmotes?: boolean;
        stripLinks?: boolean;
    };
}

type TtsAccessRole = 'owner' | 'manager' | 'admin' | 'none';
type TtsAccessPermission = 'tts:view' | 'tts:manage';

function normalizeRouteParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] || '' : value || '';
}

function resolveRequestedProvider(
    settings: ChannelTtsSettingsData,
    mode: TtsMode,
    requestedProvider?: TtsProvider
): RuntimeTtsProvider {
    if (requestedProvider === 'kokoro' || requestedProvider === 'piper' || requestedProvider === 'fish') return requestedProvider;
    if (mode === 'clone') return 'fish';
    return settings.provider;
}

async function resolveVoice(settings: ChannelTtsSettingsData, mode: TtsMode, provider: RuntimeTtsProvider, language: TtsLanguage, cloneName?: string, voice?: string): Promise<string | null> {
    if (provider === 'kokoro') return resolveKokoroVoice(voice ?? settings.voices.kokoroDefault);
    if (provider === 'fish') {
        const requested = mode === 'clone' && cloneName ? cloneName : settings.voices.cloneDefault;
        const builtIn = resolveFishVoice(requested);
        if (builtIn) return builtIn;
        const favorite = (await getFishVoiceFavorites(settings.channelID)).find(item => item.alias === requested?.toLowerCase());
        return favorite?.id ?? null;
    }

    return language === 'en' ? settings.voices.en : settings.voices.es;
}

async function getTtsAccess(requesterID: string, channelID: string, permission: TtsAccessPermission = 'tts:view'): Promise<TtsAccessRole> {
    if (requesterID === channelID) {
        return 'owner';
    }

    if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) {
        return 'owner';
    }

    const admin = await AdminSchema.findOne({
        channelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: ['*', permission] }
    }).lean();

    return admin ? (admin.permissions.includes('*') || admin.permissions.includes('tts:manage') ? 'manager' : 'admin') : 'none';
}

router.get('/settings/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const channelID = normalizeRouteParam(req.params.channelID);
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const role = await getTtsAccess(requesterID, channelID);
        if (role === 'none') {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to view TTS settings',
                status: 403
            });
        }

        const settings = await getChannelTtsSettings(channelID, streamer.name);
        return res.status(200).json({
            error: false,
            message: 'TTS settings fetched successfully',
            status: 200,
            data: {
                role,
                settings,
                kokoroVoices: KOKORO_VOICES
            }
        });
    } catch (error) {
        console.error('Error in GET /speech/settings/:channelID:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
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

router.put('/settings/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const channelID = normalizeRouteParam(req.params.channelID);
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const role = await getTtsAccess(requesterID, channelID, 'tts:manage');
        if (role === 'none') {
            return res.status(403).json({
                error: true,
                message: 'TTS Manage permission required to update TTS settings',
                status: 403
            });
        }

        if (req.body?.voices?.kokoroDefault !== undefined && !resolveKokoroVoice(req.body.voices.kokoroDefault)) {
            return res.status(400).json({ error: true, message: 'Invalid Kokoro voice', status: 400 });
        }
        const nextSettings = normalizeChannelTtsSettings(req.body as Partial<ChannelTtsSettingsData>, channelID, streamer.name);
        const previous = await getChannelTtsSettings(channelID, streamer.name);
        const selected = nextSettings.voices.cloneDefault!;
        if (selected !== previous.voices.cloneDefault) {
            const voiceId = resolveFishVoice(selected);
            if (!voiceId) return res.status(400).json({ error: true, status: 400, code: 'invalid_voice', message: 'Invalid Fish voice' });
            if (!Object.hasOwn(FISH_VOICES, selected)) await getFishVoice(voiceId);
        }
        const savedSettings = await upsertChannelTtsSettings(channelID, nextSettings, streamer.name);

        return res.status(200).json({
            error: false,
            message: 'TTS settings updated successfully',
            status: 200,
            data: {
                role,
                settings: savedSettings
            }
        });
    } catch (error) {
        if (error instanceof VoiceRequestError) return res.status(error.status).json({ error: true, status: error.status, code: error.code, message: error.message });
        console.error('Error in PUT /speech/settings/:channelID:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
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

// These routes share TTS authorization; preview tickets are single-use.
router.get('/voices/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!req.user || await getTtsAccess(req.user.id, channelID) === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'Access denied' });
        }
        const data = await searchFishVoices(parseVoiceSearch(req.query));
        return res.json({ error: false, status: 200, data });
    } catch (error) {
        const status = error instanceof VoiceRequestError ? error.status : 503;
        return res.status(status).json({ error: true, status, code: error instanceof VoiceRequestError ? error.code : 'catalog_unavailable', message: 'Unable to search voices' });
    }
});
router.get('/favorites/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!req.user || await getTtsAccess(req.user.id, channelID) === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'Access denied' });
        }
        return res.json({ error: false, status: 200, data: await getFishVoiceFavorites(channelID) });
    } catch {
        return res.status(500).json({ error: true, status: 500, message: 'Unable to load favorite voices' });
    }
});
router.post('/favorites/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!req.user || await getTtsAccess(req.user.id, channelID, 'tts:manage') === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'TTS Manage permission required to save voices' });
        }
        const id = req.body?.id;
        if (typeof id !== 'string' || !/^[a-f\d]{32}$/i.test(id)) {
            return res.status(400).json({ error: true, status: 400, message: 'Invalid voice ID' });
        }
        const voice = await getFishVoice(id.toLowerCase());
        const favorite = await addFishVoiceFavorite(channelID, voice.id.toLowerCase(), voice.name);
        return res.json({ error: false, status: 200, data: favorite });
    } catch (error) {
        if (error instanceof VoiceRequestError) return res.status(error.status).json({ error: true, status: error.status, code: error.code, message: error.message });
        if (error instanceof Error && error.message === 'favorites_full') return res.status(409).json({ error: true, status: 409, code: 'favorites_full', message: `You can save up to ${MAX_FISH_VOICE_FAVORITES} voices` });
        return res.status(500).json({ error: true, status: 500, message: 'Unable to save favorite voice' });
    }
});
router.patch('/favorites/:channelID/:voiceID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!req.user || await getTtsAccess(req.user.id, channelID, 'tts:manage') === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'TTS Manage permission required to rename favorite voices' });
        }
        const id = normalizeRouteParam(req.params.voiceID).toLowerCase();
        if (!/^[a-f\d]{32}$/.test(id)) return res.status(400).json({ error: true, status: 400, message: 'Invalid voice ID' });
        const favorite = await renameFishVoiceFavorite(channelID, id, req.body?.alias);
        return res.json({ error: false, status: 200, data: favorite });
    } catch (error) {
        if (error instanceof FavoriteAliasError) {
            return res.status(error.status).json({ error: true, status: error.status, code: error.code, message: error.message });
        }
        return res.status(500).json({ error: true, status: 500, message: 'Unable to rename favorite voice' });
    }
});
router.delete('/favorites/:channelID/:voiceID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!req.user || await getTtsAccess(req.user.id, channelID, 'tts:manage') === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'TTS Manage permission required to remove voices' });
        }
        const id = normalizeRouteParam(req.params.voiceID).toLowerCase();
        if (!/^[a-f\d]{32}$/i.test(id)) return res.status(400).json({ error: true, status: 400, message: 'Invalid voice ID' });
        await removeFishVoiceFavorite(channelID, id);
        return res.json({ error: false, status: 200, data: await getFishVoiceFavorites(channelID) });
    } catch {
        return res.status(500).json({ error: true, status: 500, message: 'Unable to remove favorite voice' });
    }
});
router.post('/preview-session/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        if (!/^\d+$/.test(channelID) || !req.user || await getTtsAccess(req.user.id, channelID, 'tts:manage') === 'none') {
            return res.status(403).json({ error: true, status: 403, message: 'TTS Manage permission required to preview voices' });
        }
        const ticket = await createPreviewTicket(channelID);
        return res.json({ error: false, status: 200, data: { ticket } });
    } catch {
        return res.status(503).json({ error: true, status: 503, message: 'Preview connection unavailable' });
    }
});

router.get('/audio/:channelID/:speechID', async (req: Request, res: Response) => {
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        const speechID = normalizeRouteParam(req.params.speechID);

        const wavPath = path.join(publicDir, 'speech', channelID, `${speechID}.wav`);
        const mp3Path = path.join(publicDir, 'speech', channelID, `${speechID}.mp3`);

        let audioPath: string;
        let mimeType: string;

        if (fs.existsSync(wavPath)) {
            audioPath = wavPath;
            mimeType = 'audio/wav';
        } else if (fs.existsSync(mp3Path)) {
            audioPath = mp3Path;
            mimeType = 'audio/mpeg';
        } else {
            return res.status(404).json({
                error: true,
                message: 'Speech audio not found',
                status: 404
            });
        }

        res.type(mimeType);
        return res.sendFile(audioPath);
    } catch (error) {
        console.error('Error in GET /speech/audio/:channelID/:speechID:', {
            channelID: req.params.channelID,
            speechID: req.params.speechID,
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

router.get('/:channelID', async (req: Request, res: Response) => {
    try {
        return res.status(200).sendFile(path.join(publicDir, 'speech.html'));
    } catch (error) {
        console.error('Error in GET /speech/:channelID:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Error loading speech overlay',
            status: 500
        });
    }
});

router.post('/:channelID', async (req: Request, res: Response) => {
    try {
        const channelID = normalizeRouteParam(req.params.channelID);
        const body = req.body as SpeechPostBody;
        const mode = body.mode || 'speak';

        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const settings = await getChannelTtsSettings(channelID, streamer.name);
        if (!settings.enabled) {
            return res.status(403).json({
                error: true,
                message: 'TTS is disabled for this channel',
                status: 403
            });
        }

        const language = body.language === 'en' ? 'en' : settings.defaultLanguage;
        const provider = resolveRequestedProvider(settings, mode, body.provider);

        const filteredText = filterExpressiveTtsTags(String(body.text || ''), {
            provider,
            enabledTags: settings.filters.expressiveTags
        });

        const normalizedText = normalizeTtsMessage(filteredText, {
            skipEmotes: false,
            stripLinks: settings.filters.stripLinks,
            normalizeWhitespace: settings.filters.normalizeWhitespace,
            maxLength: settings.filters.maxLength,
            emoteNames: []
        });

        if (normalizedText.error) {
            return res.status(400).json({
                error: true,
                message: normalizedText.message,
                status: 400
            });
        }

        const voice = await resolveVoice(settings, mode, provider, language, body.cloneName, body.voice);
        if (!voice) {
            return res.status(400).json({
                error: true,
                message: 'No voice is configured for this request',
                status: 400
            });
        }

        const requestPayload: TtsRequestPayload = {
            channelID,
            source: body.meta?.source || 'chat-command',
            mode,
            provider,
            text: normalizedText.text,
            language,
            voice,
            cloneName: body.cloneName,
            requestedBy: body.requestedBy,
            meta: {
                originalText: body.meta?.originalText || String(body.text || ''),
                skipEmotes: body.meta?.skipEmotes,
                stripLinks: body.meta?.stripLinks
            }
        };

        const result = await ttsQueueHandler.queueRequest(requestPayload, settings);
        return res.status(result.status).json({
            error: result.error,
            message: result.message,
            status: result.status,
            data: result.data
        });
    } catch (error) {
        console.error('Error in POST /speech/:channelID:', {
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

export const speechRoute = router;
