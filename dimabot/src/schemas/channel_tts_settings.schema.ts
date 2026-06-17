import { Schema, model, type HydratedDocument, type Model, Types } from 'mongoose';

export type TtsLanguage = 'en' | 'es';
export type TtsMode = 'speak' | 'ai' | 'clone';
export type TtsProvider = 'piper' | 'xai' | 'openrouter' | 'fish';
export type AiTtsProvider = 'xai' | 'openrouter';
export type OpenRouterTtsModel = 'openai/gpt-4o-mini-tts-2025-12-15' | 'hexgrad/kokoro-82m';

export interface XaiInlineSpeechTagSettings {
    pause: boolean;
    longPause: boolean;
    humTune: boolean;
    laugh: boolean;
    chuckle: boolean;
    giggle: boolean;
    cry: boolean;
    tsk: boolean;
    tongueClick: boolean;
    lipSmack: boolean;
    breath: boolean;
    inhale: boolean;
    exhale: boolean;
    sigh: boolean;
}

export interface XaiWrappingSpeechTagSettings {
    soft: boolean;
    whisper: boolean;
    loud: boolean;
    buildIntensity: boolean;
    decreaseIntensity: boolean;
    higherPitch: boolean;
    lowerPitch: boolean;
    slow: boolean;
    fast: boolean;
    singSong: boolean;
    singing: boolean;
    laughSpeak: boolean;
    emphasis: boolean;
}

export interface XaiExpressiveTagSettings {
    inline: XaiInlineSpeechTagSettings;
    wrapping: XaiWrappingSpeechTagSettings;
}

export interface AiVoiceMap {
    en: string;
    es: string;
}

export interface AiVoicesByProvider {
    xai: AiVoiceMap;
    openrouter: AiVoiceMap;
}

export interface ChannelTtsSettingsData {
    channelID: string;
    channel: string;
    enabled: boolean;
    provider: TtsProvider;
    aiProvider: AiTtsProvider;
    defaultLanguage: TtsLanguage;
    voices: {
        en: string;
        es: string;
        aiDefault: string | null;
        aiVoices?: AiVoiceMap;
        aiVoicesByProvider?: AiVoicesByProvider;
        cloneDefault?: string;
    };
    filters: {
        skipEmotes: boolean;
        stripLinks: boolean;
        normalizeWhitespace: boolean;
        maxLength: number;
        expressiveTags: XaiExpressiveTagSettings;
    };
    queue: {
        maxItems: number;
    };
    providerSettings: {
        openrouter: {
            model: OpenRouterTtsModel;
        };
    };
}

export interface IChannelTtsSettings extends ChannelTtsSettingsData {
    _id: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export type ChannelTtsSettingsDocument = HydratedDocument<IChannelTtsSettings>;

export function createDefaultXaiExpressiveTagSettings(): XaiExpressiveTagSettings {
    return {
        inline: {
            pause: true,
            longPause: true,
            humTune: true,
            laugh: true,
            chuckle: true,
            giggle: true,
            cry: true,
            tsk: true,
            tongueClick: true,
            lipSmack: true,
            breath: true,
            inhale: true,
            exhale: true,
            sigh: true
        },
        wrapping: {
            soft: true,
            whisper: true,
            loud: true,
            buildIntensity: true,
            decreaseIntensity: true,
            higherPitch: true,
            lowerPitch: true,
            slow: true,
            fast: true,
            singSong: true,
            singing: true,
            laughSpeak: true,
            emphasis: true
        }
    };
}

export const DEFAULT_TTS_SETTINGS: Omit<ChannelTtsSettingsData, 'channelID' | 'channel'> = {
    enabled: true,
    provider: 'piper',
    aiProvider: 'xai',
    defaultLanguage: 'es',
    voices: {
        en: 'en_US-ryan-medium',
        es: 'es_MX-ald-medium',
        aiDefault: null,
        aiVoices: {
            en: 'eve',
            es: 'eve'
        },
        aiVoicesByProvider: {
            xai: {
                en: 'eve',
                es: 'eve'
            },
            openrouter: {
                en: 'alloy',
                es: 'alloy'
            }
        }
    },
    filters: {
        skipEmotes: true,
        stripLinks: true,
        normalizeWhitespace: true,
        maxLength: 280,
        expressiveTags: createDefaultXaiExpressiveTagSettings()
    },
    queue: {
        maxItems: 5
    },
    providerSettings: {
        openrouter: {
            model: 'openai/gpt-4o-mini-tts-2025-12-15'
        }
    }
};

const VALID_XAI_VOICES = new Set(['eve', 'ara', 'rex', 'sal', 'leo']);
const VALID_OPENROUTER_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
const VALID_OPENROUTER_TTS_MODELS = new Set<OpenRouterTtsModel>(['openai/gpt-4o-mini-tts-2025-12-15', 'hexgrad/kokoro-82m']);

function sanitizeXaiVoice(value: unknown, fallback: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (VALID_XAI_VOICES.has(normalized)) {
        return normalized;
    }

    return fallback;
}

function sanitizeOpenRouterVoice(value: unknown, fallback: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (VALID_OPENROUTER_VOICES.has(normalized)) {
        return normalized;
    }

    return fallback;
}

function sanitizeOpenRouterTtsModel(value: unknown, fallback: OpenRouterTtsModel): OpenRouterTtsModel {
    const normalized = String(value || '').trim() as OpenRouterTtsModel;
    if (VALID_OPENROUTER_TTS_MODELS.has(normalized)) {
        return normalized;
    }

    return fallback;
}

function sanitizeProvider(value: unknown, fallback: TtsProvider): TtsProvider {
    return value === 'xai' || value === 'openrouter' || value === 'piper' || value === 'fish' ? value : fallback;
}

function sanitizeAiProvider(value: unknown, fallback: AiTtsProvider): AiTtsProvider {
    return value === 'xai' || value === 'openrouter' ? value : fallback;
}

function sanitizeAiVoice(provider: AiTtsProvider, value: unknown, fallback: string): string {
    return provider === 'openrouter'
        ? sanitizeOpenRouterVoice(value, fallback)
        : sanitizeXaiVoice(value, fallback);
}

function sanitizeMaxLength(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(30, Math.min(500, Math.trunc(parsed)));
}

function sanitizeMaxItems(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function createDefaultChannelTtsSettings(channelID: string, channel: string = ''): ChannelTtsSettingsData {
    return {
        channelID,
        channel,
        enabled: DEFAULT_TTS_SETTINGS.enabled,
        provider: DEFAULT_TTS_SETTINGS.provider,
        aiProvider: DEFAULT_TTS_SETTINGS.aiProvider,
        defaultLanguage: DEFAULT_TTS_SETTINGS.defaultLanguage,
        voices: {
            ...DEFAULT_TTS_SETTINGS.voices,
            aiVoices: DEFAULT_TTS_SETTINGS.voices.aiVoices ? { ...DEFAULT_TTS_SETTINGS.voices.aiVoices } : undefined,
            aiVoicesByProvider: DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider
                ? {
                    xai: { ...DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider.xai },
                    openrouter: { ...DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider.openrouter }
                }
                : undefined
        },
        filters: {
            ...DEFAULT_TTS_SETTINGS.filters,
            expressiveTags: createDefaultXaiExpressiveTagSettings()
        },
        queue: { ...DEFAULT_TTS_SETTINGS.queue },
        providerSettings: {
            openrouter: {
                ...DEFAULT_TTS_SETTINGS.providerSettings.openrouter
            }
        }
    };
}

export function normalizeChannelTtsSettings(
    input: Partial<ChannelTtsSettingsData> | null | undefined,
    channelID: string,
    channel: string = ''
): ChannelTtsSettingsData {
    const defaults = createDefaultChannelTtsSettings(channelID, channel);

    const provider = sanitizeProvider(input?.provider, defaults.provider);
    const aiProvider = sanitizeAiProvider(input?.aiProvider, defaults.aiProvider);
    const aiVoicesInput = input?.voices?.aiVoices;
    const aiVoicesDefault = defaults.voices.aiVoices || { en: 'eve', es: 'eve' };
    const aiVoicesByProviderInput = input?.voices?.aiVoicesByProvider;
    const aiVoicesByProviderDefault = defaults.voices.aiVoicesByProvider || {
        xai: { en: 'eve', es: 'eve' },
        openrouter: { en: 'alloy', es: 'alloy' }
    };
    const expressiveTagsInput = input?.filters?.expressiveTags;
    const expressiveTagsDefault = defaults.filters.expressiveTags;

    return {
        channelID,
        channel: String(input?.channel || channel || defaults.channel).trim(),
        enabled: input?.enabled ?? defaults.enabled,
        provider,
        aiProvider,
        defaultLanguage: input?.defaultLanguage === 'en' ? 'en' : defaults.defaultLanguage,
        voices: {
            en: String(input?.voices?.en || defaults.voices.en).trim() || defaults.voices.en,
            es: String(input?.voices?.es || defaults.voices.es).trim() || defaults.voices.es,
            aiDefault: typeof input?.voices?.aiDefault === 'string' && input.voices.aiDefault.trim() !== ''
                ? input.voices.aiDefault.trim()
                : defaults.voices.aiDefault,
            aiVoices: {
                en: sanitizeAiVoice(aiProvider, aiVoicesInput?.en, aiProvider === 'openrouter' ? 'alloy' : aiVoicesDefault.en),
                es: sanitizeAiVoice(aiProvider, aiVoicesInput?.es, aiProvider === 'openrouter' ? 'alloy' : aiVoicesDefault.es)
            },
            aiVoicesByProvider: {
                xai: {
                    en: sanitizeXaiVoice(
                        aiVoicesByProviderInput?.xai?.en ?? aiVoicesInput?.en,
                        aiVoicesByProviderDefault.xai.en
                    ),
                    es: sanitizeXaiVoice(
                        aiVoicesByProviderInput?.xai?.es ?? aiVoicesInput?.es,
                        aiVoicesByProviderDefault.xai.es
                    )
                },
                openrouter: {
                    en: sanitizeOpenRouterVoice(
                        aiVoicesByProviderInput?.openrouter?.en,
                        aiVoicesByProviderDefault.openrouter.en
                    ),
                    es: sanitizeOpenRouterVoice(
                        aiVoicesByProviderInput?.openrouter?.es,
                        aiVoicesByProviderDefault.openrouter.es
                    )
                }
            },
            cloneDefault: typeof input?.voices?.cloneDefault === 'string' && input.voices.cloneDefault.trim() !== ''
                ? input.voices.cloneDefault.trim()
                : defaults.voices.cloneDefault ?? 'gojo'
        },
        filters: {
            skipEmotes: input?.filters?.skipEmotes ?? defaults.filters.skipEmotes,
            stripLinks: input?.filters?.stripLinks ?? defaults.filters.stripLinks,
            normalizeWhitespace: input?.filters?.normalizeWhitespace ?? defaults.filters.normalizeWhitespace,
            maxLength: sanitizeMaxLength(input?.filters?.maxLength, defaults.filters.maxLength),
            expressiveTags: {
                inline: {
                    pause: sanitizeBoolean(expressiveTagsInput?.inline?.pause, expressiveTagsDefault.inline.pause),
                    longPause: sanitizeBoolean(expressiveTagsInput?.inline?.longPause, expressiveTagsDefault.inline.longPause),
                    humTune: sanitizeBoolean(expressiveTagsInput?.inline?.humTune, expressiveTagsDefault.inline.humTune),
                    laugh: sanitizeBoolean(expressiveTagsInput?.inline?.laugh, expressiveTagsDefault.inline.laugh),
                    chuckle: sanitizeBoolean(expressiveTagsInput?.inline?.chuckle, expressiveTagsDefault.inline.chuckle),
                    giggle: sanitizeBoolean(expressiveTagsInput?.inline?.giggle, expressiveTagsDefault.inline.giggle),
                    cry: sanitizeBoolean(expressiveTagsInput?.inline?.cry, expressiveTagsDefault.inline.cry),
                    tsk: sanitizeBoolean(expressiveTagsInput?.inline?.tsk, expressiveTagsDefault.inline.tsk),
                    tongueClick: sanitizeBoolean(expressiveTagsInput?.inline?.tongueClick, expressiveTagsDefault.inline.tongueClick),
                    lipSmack: sanitizeBoolean(expressiveTagsInput?.inline?.lipSmack, expressiveTagsDefault.inline.lipSmack),
                    breath: sanitizeBoolean(expressiveTagsInput?.inline?.breath, expressiveTagsDefault.inline.breath),
                    inhale: sanitizeBoolean(expressiveTagsInput?.inline?.inhale, expressiveTagsDefault.inline.inhale),
                    exhale: sanitizeBoolean(expressiveTagsInput?.inline?.exhale, expressiveTagsDefault.inline.exhale),
                    sigh: sanitizeBoolean(expressiveTagsInput?.inline?.sigh, expressiveTagsDefault.inline.sigh)
                },
                wrapping: {
                    soft: sanitizeBoolean(expressiveTagsInput?.wrapping?.soft, expressiveTagsDefault.wrapping.soft),
                    whisper: sanitizeBoolean(expressiveTagsInput?.wrapping?.whisper, expressiveTagsDefault.wrapping.whisper),
                    loud: sanitizeBoolean(expressiveTagsInput?.wrapping?.loud, expressiveTagsDefault.wrapping.loud),
                    buildIntensity: sanitizeBoolean(expressiveTagsInput?.wrapping?.buildIntensity, expressiveTagsDefault.wrapping.buildIntensity),
                    decreaseIntensity: sanitizeBoolean(expressiveTagsInput?.wrapping?.decreaseIntensity, expressiveTagsDefault.wrapping.decreaseIntensity),
                    higherPitch: sanitizeBoolean(expressiveTagsInput?.wrapping?.higherPitch, expressiveTagsDefault.wrapping.higherPitch),
                    lowerPitch: sanitizeBoolean(expressiveTagsInput?.wrapping?.lowerPitch, expressiveTagsDefault.wrapping.lowerPitch),
                    slow: sanitizeBoolean(expressiveTagsInput?.wrapping?.slow, expressiveTagsDefault.wrapping.slow),
                    fast: sanitizeBoolean(expressiveTagsInput?.wrapping?.fast, expressiveTagsDefault.wrapping.fast),
                    singSong: sanitizeBoolean(expressiveTagsInput?.wrapping?.singSong, expressiveTagsDefault.wrapping.singSong),
                    singing: sanitizeBoolean(expressiveTagsInput?.wrapping?.singing, expressiveTagsDefault.wrapping.singing),
                    laughSpeak: sanitizeBoolean(expressiveTagsInput?.wrapping?.laughSpeak, expressiveTagsDefault.wrapping.laughSpeak),
                    emphasis: sanitizeBoolean(expressiveTagsInput?.wrapping?.emphasis, expressiveTagsDefault.wrapping.emphasis)
                }
            }
        },
        queue: {
            maxItems: sanitizeMaxItems(input?.queue?.maxItems, defaults.queue.maxItems)
        },
        providerSettings: {
            openrouter: {
                model: sanitizeOpenRouterTtsModel(
                    input?.providerSettings?.openrouter?.model,
                    defaults.providerSettings.openrouter.model
                )
            }
        }
    };
}

const channelTtsSettingsSchema = new Schema<IChannelTtsSettings>({
    channelID: { type: String, required: true, unique: true },
    channel: { type: String, default: '' },
    enabled: { type: Boolean, default: DEFAULT_TTS_SETTINGS.enabled },
    provider: { type: String, enum: ['piper', 'xai', 'openrouter', 'fish'], default: DEFAULT_TTS_SETTINGS.provider },
    aiProvider: { type: String, enum: ['xai', 'openrouter'], default: DEFAULT_TTS_SETTINGS.aiProvider },
    defaultLanguage: { type: String, enum: ['en', 'es'], default: DEFAULT_TTS_SETTINGS.defaultLanguage },
    voices: {
        en: { type: String, default: DEFAULT_TTS_SETTINGS.voices.en },
        es: { type: String, default: DEFAULT_TTS_SETTINGS.voices.es },
        aiDefault: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiDefault },
        aiVoices: {
            en: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoices?.en || 'eve' },
            es: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoices?.es || 'eve' }
        },
        aiVoicesByProvider: {
            xai: {
                en: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider?.xai.en || 'eve' },
                es: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider?.xai.es || 'eve' }
            },
            openrouter: {
                en: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider?.openrouter.en || 'alloy' },
                es: { type: String, default: DEFAULT_TTS_SETTINGS.voices.aiVoicesByProvider?.openrouter.es || 'alloy' }
            }
        },
        cloneDefault: { type: String, default: 'gojo' }
    },
    filters: {
        skipEmotes: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.skipEmotes },
        stripLinks: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.stripLinks },
        normalizeWhitespace: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.normalizeWhitespace },
        maxLength: { type: Number, default: DEFAULT_TTS_SETTINGS.filters.maxLength },
        expressiveTags: {
            inline: {
                pause: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.pause },
                longPause: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.longPause },
                humTune: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.humTune },
                laugh: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.laugh },
                chuckle: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.chuckle },
                giggle: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.giggle },
                cry: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.cry },
                tsk: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.tsk },
                tongueClick: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.tongueClick },
                lipSmack: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.lipSmack },
                breath: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.breath },
                inhale: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.inhale },
                exhale: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.exhale },
                sigh: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.inline.sigh }
            },
            wrapping: {
                soft: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.soft },
                whisper: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.whisper },
                loud: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.loud },
                buildIntensity: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.buildIntensity },
                decreaseIntensity: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.decreaseIntensity },
                higherPitch: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.higherPitch },
                lowerPitch: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.lowerPitch },
                slow: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.slow },
                fast: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.fast },
                singSong: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.singSong },
                singing: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.singing },
                laughSpeak: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.laughSpeak },
                emphasis: { type: Boolean, default: DEFAULT_TTS_SETTINGS.filters.expressiveTags.wrapping.emphasis }
            }
        }
    },
    queue: {
        maxItems: { type: Number, default: DEFAULT_TTS_SETTINGS.queue.maxItems }
    },
    providerSettings: {
        openrouter: {
            model: { type: String, default: DEFAULT_TTS_SETTINGS.providerSettings.openrouter.model }
        }
    }
}, {
    timestamps: true
});

export const ChannelTtsSettingsSchema = model<IChannelTtsSettings>('channel_tts_settings', channelTtsSettingsSchema);

export async function getChannelTtsSettings(channelID: string, channel: string = ''): Promise<ChannelTtsSettingsData> {
    const doc = await ChannelTtsSettingsSchema.findOne({ channelID }).lean<ChannelTtsSettingsData | null>();
    return normalizeChannelTtsSettings(doc, channelID, channel);
}

export async function upsertChannelTtsSettings(
    channelID: string,
    input: Partial<ChannelTtsSettingsData>,
    channel: string = ''
): Promise<ChannelTtsSettingsData> {
    const normalized = normalizeChannelTtsSettings(input, channelID, channel);
    const existingDoc = await ChannelTtsSettingsSchema.findOne({ channelID }).exec();

    if (existingDoc) {
        existingDoc.set(normalized);
        await existingDoc.save();
    } else {
        const nextDoc = new ChannelTtsSettingsSchema(normalized);
        await nextDoc.save();
    }

    return await getChannelTtsSettings(channelID, channel);
}

export function getChannelTtsSettingsModel(): Model<IChannelTtsSettings> {
    return ChannelTtsSettingsSchema;
}
