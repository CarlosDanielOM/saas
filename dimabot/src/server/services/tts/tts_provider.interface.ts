import type { TtsLanguage, TtsMode, TtsProvider as ConfiguredTtsProvider } from '../../../schemas/channel_tts_settings.schema.js';

export type RuntimeTtsProvider = ConfiguredTtsProvider | 'fish';

export interface TtsSynthesisRequest {
    channelID: string;
    speechID: string;
    mode: TtsMode;
    provider: RuntimeTtsProvider;
    model?: string;
    text: string;
    language: TtsLanguage;
    voice: string;
    outputPath: string;
    cloneName?: string;
    /** Private callers own outputPath; defaults preserve normal overlay delivery. */
    privateOutput?: boolean;
    signal?: AbortSignal;
    maxAudioBytes?: number;
    singleAttempt?: boolean;
}

/** What a paid provider will charge us for one successful call; Piper runs on our host and has none. */
export interface TtsProviderCost {
    /** The model or backend that produced the audio, e.g. `fish-audio/drama-3` or `s2.1-pro`. */
    backend: string;
    /** UTF-8 bytes of the text the provider received; Fish and OpenRouter bill per byte. */
    bytes: number;
    /** OpenRouter's `x-generation-id`; the real charge is looked up with it once OpenRouter records it. */
    generationId?: string;
}

export interface TtsSynthesisResult {
    error: boolean;
    message: string;
    outputPath?: string;
    publicPath?: string;
    mimeType?: 'audio/wav' | 'audio/mpeg';
    providerCost?: TtsProviderCost;
}

export interface TtsProvider {
    name: string;
    synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}
