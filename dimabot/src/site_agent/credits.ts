/**
 * AI-credit pricing and charging for tool calls (site assistant and MCP share the tool registry).
 * CONTRACT STUB for the MCP v1 build (2026-11-14): signatures are fixed, the implementation lands separately.
 * Nothing imports this module yet.
 */
import type { ToolKind } from './types.js';

export type ToolSurface = 'site' | 'mcp';

/** Credits one successful call costs on a surface. 0 = free (no reservation, no charge). */
export function toolPrice(_tool: { name: string; kind: ToolKind }, _surface: ToolSurface): number {
    return 0;
}

export class CreditError extends Error {
    constructor(public readonly code: 'credits_exhausted' | 'credits_unavailable') { super(code); }
}

export interface CreditReservation {
    channelId: string;
    credits: number;
    /** Server-generated id of this one tool call; the billing idempotency key. */
    operationId: string;
}

/** Atomically holds `credits` against the channel's balance. Throws CreditError when the balance is short or unknown. */
export async function reserveToolCredits(_channelId: string, _credits: number, _operationId: string): Promise<CreditReservation> {
    throw new CreditError('credits_unavailable');
}

/** The call succeeded: charge through the Polar AI-credit path (idempotent by operationId) and drop the hold. */
export async function settleToolCredits(_reservation: CreditReservation, _meta: { tool: string; surface: ToolSurface }): Promise<void> {
    throw new CreditError('credits_unavailable');
}

/** The call definitely did not happen or was not billable: drop the hold without charging. */
export async function releaseToolCredits(_reservation: CreditReservation): Promise<void> {
    return;
}
