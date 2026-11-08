// Where things live. The recorder only reads the repo; it writes to marketing/video/{out,.cache,sounds/tts}.
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const VIDEO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKETING = resolve(VIDEO, '..');
export const REPO = resolve(MARKETING, '..');
export const SCENES = resolve(VIDEO, 'scenes');
export const SOUNDS = resolve(VIDEO, 'sounds');
export const TTS_CLIPS = resolve(SOUNDS, 'tts');
export const OUT = resolve(VIDEO, 'out');
export const CACHE = resolve(VIDEO, '.cache');
export const VOICES = resolve(VIDEO, 'voices.json');
/** The live site bundle (what domdimabot.com serves), read-only. */
export const LIVE_BUNDLE = resolve(REPO, 'dimasite/dist/dimasite/browser');
export const SCENE_MODULE = resolve(REPO, 'dimasite/src/app/features/demo-video/demo-scene.ts');
export const DEMO_PATH = '/mocks/dev/demo';
