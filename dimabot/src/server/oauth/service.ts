import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Types } from 'mongoose';
import UsersSchema from '../../schemas/users.schema.js';
import { OAuthClient } from '../../schemas/oauth_client.schema.js';
import { OAuthGrant } from '../../schemas/oauth_grant.schema.js';
import { OAuthSession } from '../../schemas/oauth_session.schema.js';
import { OAuthRefreshToken } from '../../schemas/oauth_refresh_token.schema.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import { MCP_ADMIN_PERMISSION } from '../../middleware/channel_permissions.js';
import { resolveAccess } from '../../site_agent/access.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { ACCESS_TTL_SECONDS, CODE_TTL_SECONDS, OAuthError, OAUTH_RESOURCES, OAUTH_SCOPES, parseScopes, REFRESH_GRACE_SECONDS,
    REFRESH_IDLE_MS, REQUEST_TTL_SECONDS, scopeResource, SESSION_ABSOLUTE_MS, validateRedirect } from './catalog.js';
import { assertClientRegistry, FIRST_PARTY_CLIENTS, resolveClient, resolveSessionClient, type ClientRecord,
    type SessionClient } from './clients.js';
import { isCimdClientDenied, isCimdClientId } from './cimd.js';

export const oauthIssuer = () => new URL(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').origin;
export const oauthWebsite = () => new URL(process.env.DASHBOARD_URL || 'https://domdimabot.com').origin;
export const secret = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const redis = () => getDragonflyClient('OAuth');
const validSecret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
/** RFC 6749 state is opaque: optional, 1-500 VSCHAR, echoed back exactly. */
const validState = (value: unknown): value is string => typeof value === 'string' && /^[\x20-\x7e]{1,500}$/.test(value);
/** Control characters removed, cut to `max` UTF-16 units without splitting a surrogate pair. */
function label(value: string, max: number) {
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '') || 'App';
}

interface AuthorizationRequest {
    client_id: string; redirect_uri: string; scopes: string[]; state?: string;
    code_challenge: string; device_name: string; resource: string;
    /** CIMD only: the client as resolved when authorization started; its document is never fetched again. */
    client?: ClientRecord;
}
/** RFC 6749 §4.1.2.1: once client and redirect_uri are trusted, errors go back to the client. */
export class OAuthRedirectError extends OAuthError {
    constructor(code: string, public readonly location: string) { super(code); }
}
interface AuthorizationCode extends AuthorizationRequest { user_id: string; requester_id: string; channel_id: string }
export interface AccessIdentity {
    session_id: string; user_id: string; client_id: string;
    /** Twitch id of the account that approved; legacy records: = channel_id. */
    requester_id: string;
    /** Channel the connection acts on (Twitch id). */
    channel_id: string;
    /** Audience URI (RFC 8707); legacy records: OAUTH_RESOURCES.desktop. */
    resource: string;
    scopes: string[];
}
/** Records from before MCP v1 carry neither field: desktop grants, approved by the channel's own account. */
const binding = (record: { channel_id: string; requester_id?: string | null; resource?: string | null }) =>
    ({ requester_id: record.requester_id || record.channel_id, resource: record.resource || OAUTH_RESOURCES.desktop });
const redirectPolicy = (client: Pick<ClientRecord, 'kind'>) => ({ localhost: client.kind === 'cimd' });
/** Consent, decision and code exchange: first-party clients are reread from the DB; a CIMD client is the
 *  snapshot its authorization stored, still subject to the operator denylist. */
async function requestClient(request: AuthorizationRequest): Promise<ClientRecord> {
    if (!isCimdClientId(request.client_id)) return resolveClient(request.client_id);
    const client = request.client;
    if (client?.kind !== 'cimd' || client.client_id !== request.client_id || await isCimdClientDenied(request.client_id)) {
        throw new OAuthError('invalid_client');
    }
    return client;
}

export async function initializeOAuth(): Promise<void> {
    assertClientRegistry();
    await Promise.all([OAuthClient.init(), OAuthGrant.init(), OAuthSession.init(), OAuthRefreshToken.init()]);
    // Name, redirects and enabled are seeded once so DB edits (e.g. disabling a client) survive restarts.
    // A client gains only the scopes it lists; boot never removes one, since that cuts live sessions
    // (activeSession), so removal is a deliberate DB change. Newly listed scopes need fresh consent;
    // existing grants/sessions are never expanded.
    for (const { client_id, allowed_scopes, ...fields } of FIRST_PARTY_CLIENTS) {
        await OAuthClient.updateOne({ client_id }, { $setOnInsert: { ...fields, enabled: true },
            $addToSet: { allowed_scopes: { $each: allowed_scopes } } }, { upsert: true });
    }
}

/** Fixed one-minute window per bucket. `cost` counts several operations at once (e.g. a JSON-RPC batch). */
export async function rateLimit(bucket: string, limit: number, cost = 1): Promise<void> {
    const count = await (await redis()).eval(
        "local n=redis.call('INCRBY',KEYS[1],ARGV[1]); if n==tonumber(ARGV[1]) then redis.call('EXPIRE',KEYS[1],60) end; return n",
        { keys: [`oauth:rate:${hash(bucket)}`], arguments: [String(Math.max(1, Math.floor(cost)))] });
    if (Number(count) > limit) throw new OAuthError('slow_down', 429);
}

/** `options.source`: the caller's rate-limit identities (`clientIps`), charged for a CIMD document fetch. */
export async function startAuthorization(input: Record<string, unknown>, options: { source?: readonly string[] } = {}): Promise<string> {
    // Never redirect to an unverified client or callback: those failures stay JSON 400.
    // The only place a CIMD document is fetched.
    const client = await resolveClient(input.client_id, { source: options.source });
    const redirect = validateRedirect(input.redirect_uri, client.redirect_uris, redirectPolicy(client));
    const state = validState(input.state) ? input.state : undefined;
    const fail = (code: string, description: string) => {
        const url = new URL(redirect);
        url.searchParams.set('error', code);
        url.searchParams.set('error_description', description);
        if (state !== undefined) url.searchParams.set('state', state);
        url.searchParams.set('iss', oauthIssuer());
        return new OAuthRedirectError(code, url.href);
    };
    if (input.response_type !== 'code') throw fail(typeof input.response_type === 'string' ?
        'unsupported_response_type' : 'invalid_request', 'response_type must be code');
    if (input.code_challenge_method !== 'S256' || !validSecret(input.code_challenge)) {
        throw fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    if (input.state !== undefined && state === undefined) throw fail('invalid_request', 'state is invalid');
    // RFC 8707: one audience per grant. A client without a default (CIMD) must name it.
    const resource = input.resource === undefined ? client.default_resource : input.resource;
    if (typeof resource !== 'string' || !client.resources.includes(resource)) {
        throw fail('invalid_target', 'resource is missing, repeated or not allowed');
    }
    let scopes: string[] = [];
    try { scopes = parseScopes(input.scope); } catch { /* reported below */ }
    if (!scopes.length || scopes.some(scope => !client.allowed_scopes.includes(scope) || scopeResource(scope) !== resource)) {
        throw fail('invalid_scope', 'scope is invalid or not allowed');
    }
    const name = input.device_name;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))) {
        throw fail('invalid_request', 'device_name is invalid');
    }
    const request: AuthorizationRequest = { client_id: client.client_id, redirect_uri: redirect,
        scopes, state, code_challenge: input.code_challenge, resource,
        device_name: typeof name === 'string' ? name.trim() : client.kind === 'first_party' ? 'Desktop computer' : label(client.name, 80),
        ...(client.kind === 'cimd' ? { client } : {}) };
    const id = secret();
    await (await redis()).set(`oauth:request:${hash(id)}`, JSON.stringify(request), { EX: REQUEST_TTL_SECONDS });
    return id;
}

export async function getAuthorization(id: unknown): Promise<{ request: AuthorizationRequest; client: ClientRecord }> {
    if (!validSecret(id)) throw new OAuthError('invalid_request');
    const value = await (await redis()).get(`oauth:request:${hash(id)}`);
    if (!value) throw new OAuthError('invalid_request');
    const stored = JSON.parse(value) as AuthorizationRequest;
    const request = { ...stored, resource: stored.resource || OAUTH_RESOURCES.desktop };
    const client = await requestClient(request);
    validateRedirect(request.redirect_uri, client.redirect_uris, redirectPolicy(client));
    if (!client.resources.includes(request.resource)) throw new OAuthError('invalid_target');
    if (request.scopes.some(scope => !client.allowed_scopes.includes(scope))) throw new OAuthError('invalid_scope');
    return { request, client };
}

/** `channelID` is required on approval for channel-selection clients and refused for all others. */
export async function approveAuthorization(id: unknown, twitchID: string, approve: boolean, channelID?: string): Promise<string> {
    const { request, client } = await getAuthorization(id);
    if (channelID !== undefined ? !client.channel_selection || !/^\d{1,20}$/.test(channelID) :
        approve && client.channel_selection) throw new OAuthError('invalid_request');
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: twitchID } } }).lean();
    if (!user) throw new OAuthError('account_required', 403);
    // Checked before the request is consumed, so the user can still choose another channel.
    if (approve && client.channel_selection && !await resolveAccess(twitchID, channelID!, 'mcp')) {
        throw new OAuthError('channel_access_required', 403);
    }
    const value = await (await redis()).getDel(`oauth:request:${hash(id as string)}`);
    if (!value) throw new OAuthError('invalid_request');
    const url = new URL(request.redirect_uri);
    if (request.state !== undefined) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', oauthIssuer());
    if (!approve) url.searchParams.set('error', 'access_denied');
    else {
        const code = secret();
        const record: AuthorizationCode = { ...request, user_id: user._id.toString(), requester_id: twitchID,
            channel_id: client.channel_selection ? channelID! : twitchID };
        await (await redis()).set(`oauth:code:${hash(code)}`, JSON.stringify(record), { EX: CODE_TTL_SECONDS });
        url.searchParams.set('code', code);
    }
    return url.href;
}

async function makeAccess(session: AccessIdentity) {
    const access = secret('dima_at_');
    await (await redis()).set(`oauth:access:${hash(access)}`, JSON.stringify(session), { EX: ACCESS_TTL_SECONDS });
    return access;
}

export async function exchangeCode(input: Record<string, unknown>) {
    // Never fetches a CIMD document: the client snapshot travels with the code.
    const caller = await resolveSessionClient(input.client_id);
    if (!validSecret(input.code) || typeof input.code_verifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new OAuthError('invalid_grant');
    const key = `oauth:code:${hash(input.code)}`;
    const value = await (await redis()).get(key);
    if (!value) throw new OAuthError('invalid_grant');
    const stored = JSON.parse(value) as AuthorizationCode;
    const record = { ...stored, ...binding(stored) };
    if (record.client_id !== caller.client_id) throw new OAuthError('invalid_grant');
    const client = await requestClient(record);
    const challenge = hash(input.code_verifier);
    if (record.client_id !== client.client_id || record.redirect_uri !== input.redirect_uri ||
        !timingSafeEqual(Buffer.from(challenge), Buffer.from(record.code_challenge)) || !client.resources.includes(record.resource) ||
        record.scopes.some(scope => !client.allowed_scopes.includes(scope))) throw new OAuthError('invalid_grant');
    // RFC 8707 §2.2: an optional resource must name the audience that was approved.
    if (input.resource !== undefined && input.resource !== record.resource) throw new OAuthError('invalid_target');
    if (!await (await redis()).getDel(key)) throw new OAuthError('invalid_grant');
    const user = await UsersSchema.exists({ _id: record.user_id,
        accounts: { $elemMatch: { type: 'twitch', id: record.requester_id } } });
    if (!user || (client.channel_selection ? !await resolveAccess(record.requester_id, record.channel_id, 'mcp') :
        record.channel_id !== record.requester_id)) throw new OAuthError('invalid_grant');
    const grant = await OAuthGrant.findOneAndUpdate({ user_id: record.user_id, client_id: client.client_id,
        channel_id: record.channel_id }, { $addToSet: { scopes: { $each: record.scopes } },
        $set: { revoked_at: null } }, { upsert: true, new: true });
    const now = new Date();
    const refresh = secret('dima_rt_');
    const session = await OAuthSession.create({ grant_id: grant._id, user_id: record.user_id,
        client_id: record.client_id, client_name: label(client.name, 120), requester_id: record.requester_id,
        channel_id: record.channel_id, resource: record.resource, device_name: record.device_name,
        scopes: record.scopes, current_refresh_hash: hash(refresh), last_used_at: now,
        idle_expires_at: new Date(now.getTime() + REFRESH_IDLE_MS),
        expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_MS) });
    try {
        await OAuthRefreshToken.create({ token_hash: hash(refresh), session_id: session._id, expires_at: session.expires_at });
        return await tokenResponse(session, refresh);
    } catch (error) { await revokeSession(session._id.toString(), 'issuance_failed'); throw error; }
}

interface SessionRecord {
    _id: Types.ObjectId; user_id: Types.ObjectId; client_id: string; channel_id: string;
    requester_id?: string | null; resource?: string | null;
    scopes: string[]; idle_expires_at: Date; expires_at: Date;
}
async function tokenResponse(session: SessionRecord, refresh: string) {
    const { requester_id, resource } = binding(session);
    const identity: AccessIdentity = { session_id: session._id.toString(), user_id: session.user_id.toString(),
        client_id: session.client_id, requester_id, channel_id: session.channel_id, resource, scopes: session.scopes };
    return { access_token: await makeAccess(identity), token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS,
        refresh_token: refresh, scope: session.scopes.join(' '), session_id: identity.session_id,
        refresh_expires_in: Math.max(0, Math.floor((Math.min(session.idle_expires_at.getTime(), session.expires_at.getTime()) - Date.now()) / 1000)) };
}

async function activeSession(id: string) {
    const now = new Date();
    const session = await OAuthSession.findOne({ _id: id, revoked_at: null,
        expires_at: { $gt: now }, idle_expires_at: { $gt: now } }).select('+current_refresh_hash');
    if (!session) throw new OAuthError('invalid_token', 401);
    const { requester_id, resource } = binding(session);
    const grant = await OAuthGrant.findOne({ _id: session.grant_id, revoked_at: null }).select('scopes').lean();
    // A disabled first-party client or a denylisted CIMD client ends its sessions.
    const client = await resolveSessionClient(session.client_id).catch((error: unknown) => {
        throw error instanceof OAuthError ? new OAuthError('invalid_token', 401) : error;
    });
    // The approving account must still belong to this user. The bound channel is never retargeted.
    const user = await UsersSchema.exists({ _id: session.user_id,
        accounts: { $elemMatch: { type: 'twitch', id: requester_id } } });
    if (!grant || !user || !client.resources.includes(resource) || (!client.channel_selection && requester_id !== session.channel_id) ||
        session.scopes.some(scope => !client.allowed_scopes.includes(scope) ||
        !grant.scopes.includes(scope) || !Object.hasOwn(OAUTH_SCOPES, scope) ||
        !OAUTH_SCOPES[scope as keyof typeof OAUTH_SCOPES].active || scopeResource(scope) !== resource)) throw new OAuthError('invalid_token', 401);
    return session;
}

const REFRESH_TOKEN = /^dima_rt_[A-Za-z0-9_-]{43}$/;
/** How long a replay waits for a rotation that has passed its compare-and-set but not yet stored its grace record. */
const GRACE_WAIT_MS = 1500, GRACE_POLL_MS = 100;
/**
 * A rotation this recent (the session's last_used_at) may still be between its compare-and-set and its grace record:
 * a replay that finds no record then gets a retryable error instead of revoking the session.
 */
const ROTATION_IN_FLIGHT_MS = 10_000;
/** Validity could not be established (Dragonfly/Mongo trouble, a rotation still in flight): retry, never revoke. */
const retryLater = () => new OAuthError('temporarily_unavailable', 503);
const graceKey = (tokenHash: string) => `oauth:refresh:grace:${tokenHash}`;
/** Derived from the replaced token's plaintext: only its holder can open the grace record. */
const graceCipherKey = (refresh: string) => createHash('sha256').update('dima:oauth:refresh-grace:v1\n').update(refresh).digest();
const graceAad = (previousHash: string, sessionID: string, nextHash: string) => Buffer.from(`${previousHash}\n${sessionID}\n${nextHash}`);

/** The successor sealed with AES-256-GCM under the replaced token; Dragonfly never holds a usable plaintext token. */
function sealGrace(previous: string, next: string, sessionID: string): string {
    const iv = randomBytes(12), nextHash = hash(next);
    const cipher = createCipheriv('aes-256-gcm', graceCipherKey(previous), iv);
    cipher.setAAD(graceAad(hash(previous), sessionID, nextHash));
    const data = Buffer.concat([cipher.update(next, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, session_id: sessionID, next_hash: nextHash, iv: iv.toString('base64url'),
        data: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
}

/** Null for anything other than a grace record sealed for exactly this token. */
function openGrace(previous: string, value: string): { session_id: string; refresh: string } | null {
    try {
        const record = JSON.parse(value) as Record<string, unknown>;
        const { session_id, next_hash, iv, data, tag } = record;
        if (record.v !== 1 || typeof session_id !== 'string' || typeof next_hash !== 'string' || typeof iv !== 'string' ||
            typeof data !== 'string' || typeof tag !== 'string') return null;
        const nonce = Buffer.from(iv, 'base64url'), mac = Buffer.from(tag, 'base64url');
        if (nonce.length !== 12 || mac.length !== 16) return null;
        const decipher = createDecipheriv('aes-256-gcm', graceCipherKey(previous), nonce, { authTagLength: 16 });
        decipher.setAAD(graceAad(hash(previous), session_id, next_hash));
        decipher.setAuthTag(mac);
        const refresh = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
        return REFRESH_TOKEN.test(refresh) && hash(refresh) === next_hash ? { session_id, refresh } : null;
    } catch { return null; }
}

/** A failed write only removes the grace: the refresh itself still succeeds. */
async function storeGrace(previous: string, next: string, sessionID: string) {
    try {
        await (await redis()).set(graceKey(hash(previous)), sealGrace(previous, next, sessionID), { EX: REFRESH_GRACE_SECONDS });
    } catch { console.warn('[OAuth] Refresh grace record not stored'); }
}

/** With `wait`, polls briefly for a rotation still in flight. A read failure is retryable, never "no grace". */
async function findGrace(tokenHash: string, wait: boolean): Promise<string | null> {
    const deadline = Date.now() + (wait ? GRACE_WAIT_MS : 0);
    try {
        for (;;) {
            const value = await (await redis()).get(graceKey(tokenHash));
            if (value || Date.now() >= deadline) return value || null;
            await sleep(GRACE_POLL_MS);
        }
    } catch { throw retryLater(); }
}

/** The session as stored now; null when it is no longer active (revoked, expired, client or grant gone). */
async function sessionNow(sessionID: string) {
    try { return await activeSession(sessionID); }
    catch (error) {
        if (error instanceof OAuthError && error.status === 401) return null;
        throw retryLater();
    }
}

/** Request parameters a refresh must match; refused without ending the session. */
function checkRefreshRequest(session: SessionRecord, client: SessionClient, input: Record<string, unknown>) {
    if (session.client_id !== client.client_id) throw new OAuthError('invalid_grant');
    if (input.scope !== undefined && (typeof input.scope !== 'string' || input.scope !== session.scopes.join(' '))) {
        throw new OAuthError('invalid_scope');
    }
    if (input.resource !== undefined && input.resource !== binding(session).resource) throw new OAuthError('invalid_target');
}

/** A chosen channel keeps renewing only while the approver can still manage it. */
async function checkRefreshChannel(session: SessionRecord, client: SessionClient) {
    if (client.channel_selection && !await resolveAccess(binding(session).requester_id, session.channel_id, 'mcp')) {
        throw new OAuthError('invalid_grant');
    }
}

/**
 * A replay of a refresh token that is no longer current. Within REFRESH_GRACE_SECONDS of its rotation, while the
 * successor is still the session's current token, and after the same checks as a normal refresh, it gets a new access
 * token and the SAME successor: overlapping refreshes and lost responses keep the session. Anything else is reuse.
 */
async function replayOrRevoke(refresh: string, sessionID: string, client: SessionClient, input: Record<string, unknown>, wait: boolean) {
    const value = await findGrace(hash(refresh), wait);
    const grace = value ? openGrace(refresh, value) : null;
    const session = await sessionNow(sessionID);
    if (!grace && wait && session && session.current_refresh_hash !== hash(refresh)
        && Date.now() - new Date(session.last_used_at ?? 0).getTime() < ROTATION_IN_FLIGHT_MS) {
        // A rotation of this token just happened and has not stored its grace record yet (or could not): the winner
        // may still be answering. Retry instead of revoking the session it is handing out.
        throw retryLater();
    }
    if (!grace || grace.session_id !== sessionID || !session || session.current_refresh_hash !== hash(grace.refresh)) {
        await revokeSession(sessionID, 'refresh_reuse');
        throw new OAuthError('invalid_grant');
    }
    checkRefreshRequest(session, client, input);
    await checkRefreshChannel(session, client);
    return tokenResponse(session, grace.refresh);
}

export async function refreshAccess(input: Record<string, unknown>) {
    // A denylisted CIMD client's grants are void, like the sessions it holds.
    const client = await resolveSessionClient(input.client_id).catch((error: unknown) => {
        throw error instanceof OAuthError && isCimdClientId(input.client_id) ? new OAuthError('invalid_grant') : error;
    });
    if (typeof input.refresh_token !== 'string' || !REFRESH_TOKEN.test(input.refresh_token)) throw new OAuthError('invalid_grant');
    const presented = input.refresh_token;
    const tokenHash = hash(presented);
    const record = await OAuthRefreshToken.findOne({ token_hash: tokenHash, expires_at: { $gt: new Date() } });
    if (!record) throw new OAuthError('invalid_grant');
    const sessionID = record.session_id.toString();
    let session;
    try { session = await activeSession(sessionID); }
    catch { throw new OAuthError('invalid_grant'); }
    checkRefreshRequest(session, client, input);
    if (record.used_at || session.current_refresh_hash !== tokenHash) {
        // Not current but never marked used: its rotation may still be between the swap and the grace write.
        return replayOrRevoke(presented, sessionID, client, input, !record.used_at);
    }
    await checkRefreshChannel(session, client);
    const refresh = secret('dima_rt_');
    const nextHash = hash(refresh);
    await OAuthRefreshToken.create({ token_hash: nextHash, session_id: session._id, expires_at: session.expires_at });
    const now = new Date();
    const rotated = await OAuthSession.findOneAndUpdate({ _id: session._id, revoked_at: null,
        current_refresh_hash: tokenHash, idle_expires_at: { $gt: now }, expires_at: { $gt: now } },
        { $set: { current_refresh_hash: nextHash, last_used_at: now,
            idle_expires_at: new Date(Math.min(now.getTime() + REFRESH_IDLE_MS, session.expires_at.getTime())) } }, { new: true });
    if (!rotated) {
        // Lost a race with a concurrent refresh of the same token: this successor is never issued; the winner's is.
        try { await OAuthRefreshToken.deleteOne({ token_hash: nextHash, session_id: session._id }); }
        catch { /* unissued and unknown to anyone; it expires with the session */ }
        return replayOrRevoke(presented, sessionID, client, input, true);
    }
    // Swap → grace → used_at: a replay that sees used_at set never has to wait for the grace record.
    await storeGrace(presented, refresh, sessionID);
    try {
        await OAuthRefreshToken.updateOne({ _id: record._id }, { $set: { used_at: now } });
        return await tokenResponse(rotated, refresh);
    } catch (error) { await revokeSession(sessionID, 'rotation_failed'); throw error; }
}

/** With `options.resource`, only a token issued for that audience is accepted (RFC 8707). */
export async function authenticateAccess(token: unknown, options: { resource?: string } = {}): Promise<AccessIdentity> {
    if (typeof token !== 'string' || !/^dima_at_[A-Za-z0-9_-]{43}$/.test(token)) throw new OAuthError('invalid_token', 401);
    const value = await (await redis()).get(`oauth:access:${hash(token)}`);
    if (!value) throw new OAuthError('invalid_token', 401);
    const stored = JSON.parse(value) as AccessIdentity;
    const identity: AccessIdentity = { ...stored, ...binding(stored) };
    if (options.resource !== undefined && identity.resource !== options.resource) throw new OAuthError('invalid_token', 401);
    const session = await activeSession(identity.session_id);
    const bound = binding(session);
    if (identity.user_id !== session.user_id.toString() || identity.client_id !== session.client_id ||
        identity.channel_id !== session.channel_id || identity.requester_id !== bound.requester_id ||
        identity.resource !== bound.resource || identity.scopes.some(scope => !session.scopes.includes(scope))) {
        throw new OAuthError('invalid_token', 401);
    }
    return identity;
}

export async function revokeSession(id: string, reason = 'user_revoked') {
    await OAuthSession.updateOne({ _id: id, revoked_at: null }, { $set: { revoked_at: new Date(), revoke_reason: reason } });
}

/** RFC 7009: an unknown token returns success without exposing its existence. */
export async function revokeToken(input: Record<string, unknown>) {
    // Never fetches a CIMD document: an unreachable one must not keep tokens alive.
    const client = await resolveSessionClient(input.client_id);
    if (typeof input.token !== 'string' || input.token.length > 100) throw new OAuthError('invalid_request');
    if (/^dima_rt_[A-Za-z0-9_-]{43}$/.test(input.token)) {
        const record = await OAuthRefreshToken.findOne({ token_hash: hash(input.token) });
        if (record) {
            const session = await OAuthSession.findOne({ _id: record.session_id, client_id: client.client_id });
            if (session) await revokeSession(session._id.toString());
        }
    } else if (/^dima_at_[A-Za-z0-9_-]{43}$/.test(input.token)) {
        const key = `oauth:access:${hash(input.token)}`;
        const value = await (await redis()).get(key);
        if (value) {
            const identity = JSON.parse(value) as AccessIdentity;
            if (identity.client_id === client.client_id) {
                await revokeSession(identity.session_id);
                await (await redis()).del(key);
            }
        }
    }
}

/** Channels an account may connect an app to: its own, and those it administers with website access. */
export async function browserChannels(twitchID: string): Promise<{ id: string; name: string; role: 'owner' | 'admin' }[]> {
    // Only channels whose owner gave this account AI apps (MCP); resolveAccess in mcp mode re-checks it.
    const rows = await AdminSchema.find({ adminID: twitchID, actived: true, permissions: MCP_ADMIN_PERMISSION })
        .select('channelID -_id').limit(100).lean();
    const ids = [...new Set([twitchID, ...rows.map(row => row.channelID).filter(Boolean)])];
    const channels = await Promise.all(ids.map(id => resolveAccess(twitchID, id, 'mcp')));
    // The label is the account's relationship to the channel: platform staff get owner-level access everywhere
    // (resolveAccess role 'owner'), but only their own channel is theirs.
    return channels.filter(access => access !== null).map(access => ({ id: access.channelId, name: access.channelLogin,
        role: access.channelId === twitchID ? 'owner' as const : 'admin' as const }));
}

/** The connections page, from stored names only. Legacy sessions get their client's registry name and the
 *  desktop audience; sessions of a denylisted CIMD client are dead, so they are left out like revoked ones. */
export async function listConnections(userID: Types.ObjectId) {
    const now = new Date();
    const found = await OAuthSession.find({ user_id: userID, revoked_at: null, expires_at: { $gt: now }, idle_expires_at: { $gt: now } })
        .select('_id client_id client_name grant_id channel_id resource device_name scopes last_used_at expires_at createdAt').lean();
    const apps = [...new Set(found.map(session => session.client_id).filter(id => isCimdClientId(id)))];
    const checks = await Promise.all(apps.map(id => isCimdClientDenied(id)));
    const denied = new Set(apps.filter((_id, index) => checks[index]));
    const sessions = found.filter(session => !denied.has(session.client_id));
    return sessions.map(session => ({ ...session, resource: session.resource || OAUTH_RESOURCES.desktop,
        client_name: session.client_name || FIRST_PARTY_CLIENTS.find(item => item.client_id === session.client_id)?.name || session.client_id }));
}

/** Account deletion: the user's own connections, and other users' connections to the deleted channel (admins' MCP apps). */
export async function revokeUserOAuth(userID: string, channelID?: string) {
    const filters: Record<string, unknown>[] = [];
    if (Types.ObjectId.isValid(userID)) filters.push({ user_id: userID });
    if (channelID && /^\d{1,30}$/.test(channelID)) filters.push({ channel_id: channelID });
    if (!filters.length) return;
    const filter = { $or: filters };
    await OAuthGrant.updateMany(filter, { $set: { revoked_at: new Date() } });
    await OAuthSession.updateMany(filter, { $set: { revoked_at: new Date(), revoke_reason: 'account_deleted' } });
    const sessions = await OAuthSession.find(filter).select('_id').lean();
    await OAuthRefreshToken.deleteMany({ session_id: { $in: sessions.map(session => session._id) } });
    await OAuthSession.deleteMany(filter);
    await OAuthGrant.deleteMany(filter);
}
