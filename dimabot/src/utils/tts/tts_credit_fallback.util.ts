import {
  DEFAULT_TTS_SETTINGS,
  type TtsLanguage,
  type TtsMode,
} from '../../schemas/channel_tts_settings.schema.js';
import type { RuntimeTtsProvider } from '../../server/services/tts/tts_provider.interface.js';
import type { AiCreditStatus } from '../billing.js';
import { filterExpressiveTtsTags } from './expressive_tts_tags.util.js';

export interface TtsCreditFallbackRequest {
  mode: TtsMode;
  text: string;
  provider: RuntimeTtsProvider;
  model?: string;
  language: TtsLanguage;
  voice: string;
  cloneName?: string;
  piperFallbackVoice?: string;
}

export function resolveTtsForCreditStatus<T extends TtsCreditFallbackRequest>(
  request: T,
  creditStatus: AiCreditStatus,
): T {
  if (request.provider !== 'fish' || creditStatus === 'available') {
    return request;
  }

  return {
    ...request,
    mode: request.mode === 'clone' ? 'speak' : request.mode,
    provider: 'piper',
    text: filterExpressiveTtsTags(request.text),
    model: undefined,
    voice:
      request.piperFallbackVoice ||
      DEFAULT_TTS_SETTINGS.voices[request.language],
    cloneName: undefined,
  };
}
