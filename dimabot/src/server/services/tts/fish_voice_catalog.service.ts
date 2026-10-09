import { FISH_VOICES, DEFAULT_FISH_TTS_REFERENCE_ID } from './fish_tts.service.js';

export class VoiceRequestError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}
export interface FishVoice {
    id: string;
    name: string;
    languages: string[];
    gender: 'female' | 'male' | null;
    licensed: boolean | null;
    description: string;
    tags: string[];
    coverUrl: string | null;
    sample: { url: string; text: string } | null;
    uses: number | null;
}
export interface FishVoiceSearch {
    name: string;
    gender: 'all' | 'female' | 'male';
    language: 'all' | 'en' | 'es';
    license: 'all' | 'licensed' | 'unlicensed';
    page: number;
}
const cache = new Map<string, { until: number; value: unknown }>();
export function resolveFishVoice(value?: string): string | null {
    if (!value) return DEFAULT_FISH_TTS_REFERENCE_ID;
    const id = value.trim();
    if (Object.hasOwn(FISH_VOICES, id)) return FISH_VOICES[id];
    return /^[a-f\d]{32}$/i.test(id) ? id.toLowerCase() : null;
}
export function parseVoiceSearch(query: Record<string, unknown>): FishVoiceSearch {
    const { name = '', gender = 'all', language = 'all', license = 'all', page = '1' } = query;
    if (typeof name !== 'string' || name.length > 100 || !['all', 'female', 'male'].includes(String(gender)) ||
        !['all', 'en', 'es'].includes(String(language)) || !['all', 'licensed', 'unlicensed'].includes(String(license)) ||
        !/^\d+$/.test(String(page)) || Number(page) < 1 || Number(page) > 50 ||
        [gender, language, license, page].some(v => typeof v !== 'string')) {
        throw new VoiceRequestError(400, 'invalid_filters', 'Invalid voice search filters');
    }
    return { name: name.trim(), gender, language, license, page: Number(page) } as FishVoiceSearch;
}
async function fishGet(endpoint: string): Promise<unknown> {
    const entry = cache.get(endpoint);
    if (entry && entry.until > Date.now()) return entry.value;
    const key = process.env.FISH_AUDIO_API_KEY?.trim();
    if (!key) throw new VoiceRequestError(503, 'catalog_unavailable', 'Voice catalog is unavailable');
    let response: Response;
    try {
        response = await fetch(`https://api.fish.audio/model${endpoint}`, {
            headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12000)
        });
    } catch {
        throw new VoiceRequestError(503, 'catalog_unavailable', 'Voice catalog is temporarily unavailable');
    }
    if (!response.ok) throw new VoiceRequestError(response.status === 404 ? 404 : 503,
        response.status === 404 ? 'voice_unavailable' : 'catalog_unavailable', 'Voice catalog request failed');
    const value: unknown = await response.json();
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(endpoint, { until: Date.now() + 60000, value });
    return value;
}
// Browsers load these straight from Fish's CDN, so only its own cover/sample paths pass through.
const FISH_COVER_PATH = /^coverimage\/[a-f\d]{32}$/i;
const FISH_SAMPLE_URL = /^https:\/\/platform\.r2\.fish\.audio\/tasks?\/(?:\d{4}-\d{2}-\d{2}\/)?[a-f\d]{32}\.(?:mp3|wav|opus)$/i;
const NON_STYLE_TAGS = new Set(['female', 'male', 'english', 'spanish']);
function fishSample(samples: unknown): FishVoice['sample'] {
    if (!Array.isArray(samples)) return null;
    for (const sample of samples) {
        if (!sample || typeof sample !== 'object') continue;
        const { audio, text } = sample as Record<string, unknown>;
        if (typeof audio === 'string' && FISH_SAMPLE_URL.test(audio)) {
            return { url: audio, text: typeof text === 'string' ? text.trim().slice(0, 400) : '' };
        }
    }
    return null;
}
export function normalizeFishVoice(raw: unknown): FishVoice | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    if (typeof v._id !== 'string' || !/^[a-f\d]{32}$/i.test(v._id) || typeof v.title !== 'string' ||
        v.type !== 'tts' || v.visibility !== 'public' || v.dmca_taken_down === true || v.state === 'failed' ||
        v.pvc_release_state === 'retired') return null;
    const tags = Array.isArray(v.tags) ? v.tags.map(t => String(t).toLowerCase()) : [];
    return { id: v._id, name: v.title.slice(0, 200),
        languages: Array.isArray(v.languages) ? v.languages.filter((l): l is string => typeof l === 'string') : [],
        gender: tags.includes('female') ? 'female' : tags.includes('male') ? 'male' : null,
        licensed: typeof v.licensed === 'boolean' ? v.licensed : null,
        description: typeof v.description === 'string' ? v.description.trim().slice(0, 300) : '',
        tags: [...new Set(tags.filter(t => /^[a-z][a-z-]{1,23}$/.test(t) && !NON_STYLE_TAGS.has(t)))].slice(0, 6),
        coverUrl: typeof v.cover_image === 'string' && FISH_COVER_PATH.test(v.cover_image)
            ? `https://public-platform.r2.fish.audio/cdn-cgi/image/width=128/${v.cover_image}` : null,
        sample: fishSample(v.samples),
        uses: typeof v.task_count === 'number' && Number.isFinite(v.task_count) && v.task_count >= 0 ? Math.floor(v.task_count) : null };
}
export async function getFishVoice(id: string): Promise<FishVoice> {
    if (!/^[a-f\d]{32}$/i.test(id)) throw new VoiceRequestError(400, 'invalid_voice', 'Invalid voice ID');
    const voice = normalizeFishVoice(await fishGet(`/${id}`));
    if (!voice) throw new VoiceRequestError(404, 'voice_unavailable', 'This voice is no longer available');
    return voice;
}
export async function searchFishVoices(search: FishVoiceSearch) {
    const params = new URLSearchParams({ page_size: '20', page_number: String(search.page), sort_by: 'score' });
    if (search.name) params.set('title', search.name);
    if (search.gender !== 'all') params.set('tag', search.gender);
    if (search.language !== 'all') params.set('language', search.language);
    if (search.license === 'licensed') params.set('licensed', 'true');
    const raw = await fishGet(`?${params}`) as { items?: unknown[]; has_more?: boolean; total?: number };
    if (!Array.isArray(raw?.items)) throw new VoiceRequestError(503, 'catalog_unavailable', 'Invalid catalog response');
    const items = raw.items.map(normalizeFishVoice).filter((v): v is FishVoice => v !== null).filter(v =>
        (search.license === 'all' || v.licensed === (search.license === 'licensed')) &&
        (search.gender === 'all' || v.gender === search.gender) &&
        (search.language === 'all' || v.languages.includes(search.language)));
    return { items, page: search.page,
        hasMore: search.page < 50 && (raw.has_more ?? (search.page * 20 < (raw.total ?? 0))) };
}
