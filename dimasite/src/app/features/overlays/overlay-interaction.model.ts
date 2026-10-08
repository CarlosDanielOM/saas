export type InteractionKind = 'poll' | 'prediction';
export interface InteractionChoice { id: string; title: string; votes: number; users: number; points: number; color?: string }
export interface InteractionState {
  kind: InteractionKind; id: string; title: string; phase: 'active' | 'locked' | 'completed' | 'terminated' | 'archived' | 'resolved' | 'canceled';
  choices: InteractionChoice[]; startedAt: string; deadline: string | null; endedAt: string | null;
  winnerId: string | null; occurredAt: string; receipt: string; revision: number;
}
export interface InteractionSnapshot { poll: InteractionState | null; prediction: InteractionState | null; serverTime: number }
export interface InteractionReadiness { state: 'ready' | 'pending' | 'missing' | 'permission' | 'error'; events: { type: string; status: string }[] }
export type InteractionReadinessSnapshot = Record<InteractionKind, InteractionReadiness>;
export type InteractionPreview = 'begin' | 'progress' | 'locked' | 'result' | 'tie' | 'canceled';
export function sampleInteraction(kind: InteractionKind, stage: InteractionPreview, t: (key: string) => string): InteractionState {
  const now = new Date().toISOString(), beginning = stage === 'begin', ended = ['result', 'tie', 'canceled'].includes(stage);
  const phase = ended ? kind === 'poll' ? stage === 'canceled' ? 'terminated' : 'completed' : stage === 'canceled' ? 'canceled' : 'resolved' : stage === 'locked' && kind === 'prediction' ? 'locked' : 'active';
  const labels = kind === 'poll' ? ['pollSampleOne', 'pollSampleTwo', 'pollSampleThree'] : ['predictionSampleOne', 'predictionSampleTwo'];
  return { kind, id: 'preview-' + kind, title: t(kind + 'SampleTitle'), phase,
    choices: labels.map((label, index) => ({ id: String(index), title: t(label), votes: beginning ? 0 : stage === 'tie' ? 42 : [42, 28, 10][index],
      points: beginning ? 0 : [12400, 7600][index] ?? 0, users: beginning ? 0 : [24, 18][index] ?? 0, color: index === 1 ? 'pink' : 'blue' })),
    startedAt: now, deadline: ended || phase === 'locked' ? null : new Date(Date.now() + 90_000).toISOString(), endedAt: ended ? now : null,
    winnerId: phase === 'resolved' ? '0' : null, occurredAt: now, receipt: 'preview', revision: 1 };
}
