import { Schema, model } from 'mongoose';
import { loserLogin, winnerLogin, type DuelRecord, type DuelRun } from './model.js';

/**
 * One finished duel. Only fights shown on the OBS overlay (a Premium feature) are
 * recorded; chat-only duels never count. The run ID is the key, so a retried
 * completion cannot count a fight twice.
 */
interface DuelResult { _id: string; channel: string; winner: string; loser: string; streamer: string | null; at: number }
const schema = new Schema<DuelResult>({ _id: String, channel: { type: String, required: true }, winner: { type: String, required: true }, loser: { type: String, required: true }, streamer: { type: String, default: null }, at: { type: Number, required: true } }, { versionKey: false, collection: 'duel_results' });
schema.index({ channel: 1, winner: 1, loser: 1 });
export const DuelResult = model<DuelResult>('DuelResult', schema);

export async function recordDuelResult(channel: string, run: DuelRun): Promise<void> {
  const streamer = run.enraged ? (run.enraged === 'left' ? run.challenger : run.opponent) : null;
  try { await DuelResult.create({ _id: run.id, channel, winner: winnerLogin(run), loser: loserLogin(run), streamer, at: run.endsAt }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
}
/** Wins of each side against the other, before the current fight. */
export async function headToHead(channel: string, left: string, right: string): Promise<DuelRecord> {
  const [leftWins, rightWins] = await Promise.all([DuelResult.countDocuments({ channel, winner: left, loser: right }), DuelResult.countDocuments({ channel, winner: right, loser: left })]);
  return { left: leftWins, right: rightWins };
}
export interface DuelRanking { login: string; kills: number; deaths: number; kd: number }
export const LEADERBOARD_SIZE = 10;
/**
 * Ranked by K/D (wins ÷ losses, wins alone while unbeaten), so fighting often is
 * never a penalty. Ties go to more wins, then fewer losses. The streamer fights
 * enraged with doubled odds, so they are tracked but not ranked.
 */
export async function duelLeaderboard(channel: string): Promise<{ players: DuelRanking[]; ranked: number; duels: number }> {
  const one = { $literal: 1 }, zero = { $literal: 0 };
  const rows = await DuelResult.aggregate<{ _id: string; kills: number; deaths: number; streamer: boolean }>([
    { $match: { channel } },
    { $project: { sides: [{ login: '$winner', kills: one, deaths: zero, streamer: { $eq: ['$winner', '$streamer'] } }, { login: '$loser', kills: zero, deaths: one, streamer: { $eq: ['$loser', '$streamer'] } }] } },
    { $unwind: '$sides' },
    { $group: { _id: '$sides.login', kills: { $sum: '$sides.kills' }, deaths: { $sum: '$sides.deaths' }, streamer: { $max: '$sides.streamer' } } }
  ]);
  const duels = rows.reduce((sum, row) => sum + row.kills, 0);
  const players = rows.filter(row => !row.streamer).map(row => ({ login: row._id, kills: row.kills, deaths: row.deaths, kd: row.deaths ? row.kills / row.deaths : row.kills }));
  players.sort((a, b) => b.kd - a.kd || b.kills - a.kills || a.deaths - b.deaths || a.login.localeCompare(b.login));
  return { players: players.slice(0, LEADERBOARD_SIZE), ranked: players.length, duels };
}
