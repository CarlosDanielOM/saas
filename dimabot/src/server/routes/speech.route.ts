import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';

import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { ttsQueueHandler, type TtsRequestPayload } from '../../handlers/tts_queue.handler.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { hasGlobalChannelOwnerAccess } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import {
    getChannelTtsSettings,
    normalizeChannelTtsSettings,
    upsertChannelTtsSettings,
    type ChannelTtsSettingsData,
    type TtsProvider,
    type TtsLanguage,
    type TtsMode
} from '../../schemas/channel_tts_settings.schema.js';
import { DEFAULT_FISH_TTS_REFERENCE_ID, FISH_VOICES } from '../services/tts/fish_tts.service.js';
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

type SettingsAccessRole = 'owner' | 'admin' | 'none';

function normalizeRouteParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] || '' : value || '';
}

function resolveRequestedProvider(
    settings: ChannelTtsSettingsData,
    mode: TtsMode,
    requestedProvider?: TtsProvider
): RuntimeTtsProvider {
    if (mode === 'speak') {
        if (settings.provider === 'fish') return 'fish';
        return 'piper';
    }

    if (mode === 'ai') {
        if (requestedProvider === 'xai' || requestedProvider === 'openrouter') {
            return requestedProvider;
        }

        return settings.aiProvider;
    }

    return 'fish';
}

function normalizeRequestedVoice(provider: RuntimeTtsProvider, requestedVoice?: string): string | null {
    if (provider !== 'xai') {
        return null;
    }

    const voice = String(requestedVoice || '').trim();
    return voice || null;
}

function resolveAiVoice(settings: ChannelTtsSettingsData, provider: RuntimeTtsProvider, language: TtsLanguage, requestedVoice?: string): string {
    const overrideVoice = normalizeRequestedVoice(provider, requestedVoice);
    if (overrideVoice) {
        return overrideVoice;
    }

    const aiVoicesByProvider = settings.voices.aiVoicesByProvider;

    if (provider === 'openrouter') {
        return language === 'en'
            ? aiVoicesByProvider?.openrouter?.en || 'alloy'
            : aiVoicesByProvider?.openrouter?.es || 'alloy';
    }

    return language === 'en'
        ? aiVoicesByProvider?.xai?.en || settings.voices.aiVoices?.en || 'eve'
        : aiVoicesByProvider?.xai?.es || settings.voices.aiVoices?.es || 'eve';
}

function resolveVoice(settings: ChannelTtsSettingsData, mode: TtsMode, provider: RuntimeTtsProvider, language: TtsLanguage, cloneName?: string, requestedVoice?: string): string | null {
    if (mode === 'ai') {
        return resolveAiVoice(settings, provider, language, requestedVoice);
    }

    if (mode === 'speak' && provider === 'fish') {
        const voiceName = settings.voices.cloneDefault;
        if (voiceName && voiceName in FISH_VOICES) {
            return FISH_VOICES[voiceName];
        }
        return DEFAULT_FISH_TTS_REFERENCE_ID;
    }

    if (mode === 'clone') {
        if (provider === 'fish') {
            if (cloneName) {
                // If it's a known alias, use the mapped reference ID
                if (cloneName in FISH_VOICES) {
                    return FISH_VOICES[cloneName];
                }
                // Otherwise pass it directly — Fish will use it as a raw reference ID
                return cloneName;
            }
            const defaultName = settings.voices.cloneDefault;
            if (defaultName && defaultName in FISH_VOICES) {
                return FISH_VOICES[defaultName];
            }
            return DEFAULT_FISH_TTS_REFERENCE_ID;
        }
        return null;
    }

    return language === 'en' ? settings.voices.en : settings.voices.es;
}

function resolveModel(settings: ChannelTtsSettingsData, provider: RuntimeTtsProvider): string | undefined {
    if (provider === 'openrouter') {
        return settings.providerSettings.openrouter.model;
    }

    return undefined;
}

async function getSettingsAccess(requesterID: string, channelID: string): Promise<SettingsAccessRole> {
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
        permissions: { $in: ['*', 'settings:view'] }
    }).lean();

    return admin ? 'admin' : 'none';
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

        const role = await getSettingsAccess(requesterID, channelID);
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
                settings
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

        const role = await getSettingsAccess(requesterID, channelID);
        if (role !== 'owner') {
            return res.status(403).json({
                error: true,
                message: 'Only the channel owner can update TTS settings',
                status: 403
            });
        }

        const nextSettings = normalizeChannelTtsSettings(req.body as Partial<ChannelTtsSettingsData>, channelID, streamer.name);
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

        const filteredText = filterExpressiveTtsTags(
            String(body.text || ''),
            provider,
            settings.filters.expressiveTags
        );

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

        const voice = resolveVoice(settings, mode, provider, language, body.cloneName, body.voice);
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
            model: resolveModel(settings, provider),
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
