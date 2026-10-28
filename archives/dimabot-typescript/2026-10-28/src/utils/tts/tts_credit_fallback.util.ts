import {
  DEFAULT_TTS_SETTINGS,
  type TtsLanguage,
  type TtsMode,
} from '../../schemas/channel_tts_settings.schema.js';
import type { RuntimeTtsProvider } from '../../server/services/tts/tts_provider.interface.js';
import type { AiCreditStatus } from '../billing.js';
import { filterExpressiveTtsTags } from './expressive_tts_tags.util.js';
import { DEFAULT_KOKORO_VOICES, resolveKokoroVoice } from './kokoro_voices.util.js';

export interface TtsCreditFallbackRequest {
  mode: TtsMode;
  text: string;
  provider: RuntimeTtsProvider;
  model?: string;
  language: TtsLanguage;
  voice: string;
  cloneName?: string;
  piperFallbackVoice?: string;
  kokoroFallbackVoice?: string;
}

export function resolveTtsForCreditStatus<T extends TtsCreditFallbackRequest>(
  request: T,
  creditStatus: AiCreditStatus,
  planTier?: string,
): T {
  if (request.provider === 'piper' || creditStatus === 'available') {
    return request;
  }

  const provider = creditStatus === 'exhausted' && (planTier === 'premium' || planTier === 'pro')
    ? 'kokoro' : 'piper';

  return {
    ...request,
    mode: request.mode === 'clone' ? 'speak' : request.mode,
    provider,
    text: filterExpressiveTtsTags(request.text, { provider }),
    model: undefined,
    voice: provider === 'kokoro'
      ? (request.provider === 'kokoro' ? resolveKokoroVoice(request.voice) : null)
        || resolveKokoroVoice(request.kokoroFallbackVoice)
        || DEFAULT_KOKORO_VOICES[request.language]
      : request.piperFallbackVoice || DEFAULT_TTS_SETTINGS.voices[request.language],
    cloneName: undefined,
  };
}
