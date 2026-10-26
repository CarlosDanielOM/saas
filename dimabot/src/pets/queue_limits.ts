/** Waiting independent requests per pet (the active one is not counted). Mirrors the TTS queue limit. */
export const PET_DEFAULT_QUEUE_SIZE = 5;
export const PET_MAX_QUEUE_SIZE = 10;
/** A queued independent request expires if it cannot start within this window. */
export const PET_QUEUE_WAIT_MS = 10 * 60_000;
