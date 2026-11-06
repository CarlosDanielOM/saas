import { publishToWidgets } from './session-refresh.js';
import { MOOD_NAMES } from '../pets/moods.js';
import type { PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { loserLogin, winnerLogin, type DuelRun } from '../duel/model.js';

/**
 * Custom widget bot events produced outside the API process (or by more than one process): published on the
 * `widget-feed` channel, validated and deduplicated by the API (overlays/live.ts). Public fields only; never awaited.
 */

/** The pet started (`speaking`) or finished (`done`) a reply. Private desktop-app requests never reach widgets. */
export function petWidgetEvent(request: PetRequestRecord, phase: 'speaking' | 'done', status?: string): void {
  if (!request.channelId || request.origin?.kind === 'oauth_desktop') return;
  const mood = request.mood && (request.mood === 'neutral' || (MOOD_NAMES as readonly string[]).includes(request.mood)) ? request.mood : null;
  publishToWidgets(request.channelId, 'pet', { id: request._id, kind: request.operation, phase, text: String(request.outputText ?? '').slice(0, 2000), mood,
    result: phase === 'done' ? (status === 'completed' ? 'completed' : 'stopped') : null, at: Date.now(), test: false });
}

/** A duel started (fighters only: the result stays hidden) or ended (winner and loser, after the fight). */
export function duelWidgetEvent(channel: string, run: DuelRun, phase: 'started' | 'ended'): void {
  publishToWidgets(channel, 'duel', { id: run.id, phase, challenger: run.challenger, opponent: run.opponent, mode: run.mode,
    winner: phase === 'ended' ? winnerLogin(run) : null, loser: phase === 'ended' ? loserLogin(run) : null, endsAt: run.endsAt, at: Date.now(), test: false });
}

/** A roulette spin started. The winning label travels to the API, which keeps it until the spin ends. */
export function rouletteWidgetEvent(channel: string, draw: { id: string; rouletteId: string; endsAt: number; winner: { label: string } }, name: string): void {
  publishToWidgets(channel, 'roulette', { id: draw.id, rouletteId: draw.rouletteId, name, endsAt: draw.endsAt, label: draw.winner.label, at: Date.now() });
}
