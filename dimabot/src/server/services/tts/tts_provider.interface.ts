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
}

export interface TtsSynthesisResult {
    error: boolean;
    message: string;
    outputPath?: string;
    publicPath?: string;
    mimeType?: 'audio/wav' | 'audio/mpeg';
}

export interface TtsProvider {
    name: string;
    synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}
