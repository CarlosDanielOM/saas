/** Identity comes only from the authenticated API or the server AST context. */
export interface DrawActor { userId: string; userLogin: string; userDisplayName: string; argument?: string }
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface WinnerAction {
  drawId: string; rouletteId: string; itemId: string; label: string; source: string;
  dueAt: number; status: ActionStatus; actor?: DrawActor; startedAt?: number; finishedAt?: number;
}
