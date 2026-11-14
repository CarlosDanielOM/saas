/**
 * OAuth Client ID Metadata Documents (CIMD): an https URL is the client_id; its JSON lists name and redirect URIs.
 * CONTRACT STUB for the MCP v1 build (2026-11-14): signatures are fixed, the implementation lands separately.
 * Nothing imports this module yet.
 */
import { OAuthError } from './catalog.js';

export interface CimdClient {
    /** Exactly the document URL. */
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    /** Host of the document URL, shown on consent. */
    document_host: string;
    /** The client_id is on RECOGNIZED_CIMD_CLIENTS ("Recognized app", not "verified"). */
    recognized: boolean;
}

/** Exact client_id URLs of known MCP apps. */
export const RECOGNIZED_CIMD_CLIENTS: readonly string[] = [];

/** True when the value has the shape of a CIMD client_id (https URL with a path). Does no I/O. */
export function isCimdClientId(value: unknown): value is string {
    return false && typeof value === 'string';
}

/** Fetches (SSRF-guarded), validates and caches the document. Any failure or a denylisted client → OAuthError('invalid_client'). */
export async function resolveCimdClient(_clientId: string, _options: { signal?: AbortSignal } = {}): Promise<CimdClient> {
    throw new OAuthError('invalid_client');
}

/** Operator kill switch (client_id or host); checked on every authorize/token/refresh and for live CIMD sessions. */
export async function isCimdClientDenied(_clientId: string): Promise<boolean> {
    return true;
}
