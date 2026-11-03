export type PetMoodWarning = 'settings' | 'metadata' | 'asset';
const lastWarning: Partial<Record<PetMoodWarning, number>> = {};
/** Fixed keys, no timers, and at most one warning per code per minute. */
export function warnPetMood(code: PetMoodWarning): void {
  try {
    const now = Date.now(), previous = lastWarning[code];
    if (previous !== undefined && now >= previous && now - previous < 60_000) return;
    lastWarning[code] = now;
    console.warn(`[pet moods:${code}] Optional mood data or image unavailable; using the normal pet.`);
  } catch { /* Diagnostics cannot interrupt the pet or its settings page. */ }
}
