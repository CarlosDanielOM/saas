import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import UsersSchema from '../../schemas/users.schema.js';
import { OAuthClient } from '../../schemas/oauth_client.schema.js';
import { OAuthGrant } from '../../schemas/oauth_grant.schema.js';
import { OAuthSession } from '../../schemas/oauth_session.schema.js';
import { OAuthRefreshToken } from '../../schemas/oauth_refresh_token.schema.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { ACCESS_TTL_SECONDS, CODE_TTL_SECONDS, DESKTOP_CLIENT_ID, OAuthError, OAUTH_SCOPES,
    parseScopes, REFRESH_IDLE_MS, REQUEST_TTL_SECONDS, SESSION_ABSOLUTE_MS, validateRedirect } from './catalog.js';

export const oauthIssuer = () => new URL(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').origin;
export const oauthWebsite = () => new URL(process.env.DASHBOARD_URL || 'https://domdimabot.com').origin;
export const secret = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const redis = () => getDragonflyClient('OAuth');
const validSecret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

interface AuthorizationRequest {
    client_id: string; redirect_uri: string; scopes: string[]; state: string;
    code_challenge: string; device_name: string;
}
interface AuthorizationCode extends AuthorizationRequest { user_id: string; channel_id: string }
export interface AccessIdentity { session_id: string; user_id: string; client_id: string; channel_id: string; scopes: string[] }

export async function initializeOAuth(): Promise<void> {
    await Promise.all([OAuthClient.init(), OAuthGrant.init(), OAuthSession.init(), OAuthRefreshToken.init()]);
    await OAuthClient.updateOne({ client_id: DESKTOP_CLIENT_ID }, { $setOnInsert: {
        name: 'Dima Desktop Beta', type: 'public', enabled: true,
        redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
        allowed_scopes: Object.entries(OAUTH_SCOPES).filter(([, value]) => value.active).map(([key]) => key)
    } }, { upsert: true });
    // Advertise configuration reads for the built-in desktop client. Existing grants and
    // sessions retain their original scopes; users must explicitly authorize pet:read.
    await OAuthClient.updateOne({ client_id: DESKTOP_CLIENT_ID }, { $addToSet: { allowed_scopes: 'pet:read' } });
}

export async function getClient(clientID: unknown) {
    if (typeof clientID !== 'string' || clientID.length > 100) throw new OAuthError('invalid_client');
    const client = await OAuthClient.findOne({ client_id: clientID, enabled: true }).lean();
    if (!client) throw new OAuthError('invalid_client');
    return client;
}

export async function rateLimit(bucket: string, limit: number): Promise<void> {
    const count = await (await redis()).eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
        { keys: [`oauth:rate:${hash(bucket)}`], arguments: [] });
    if (Number(count) > limit) throw new OAuthError('slow_down', 429);
}

export async function startAuthorization(input: Record<string, unknown>): Promise<string> {
    if (input.response_type !== 'code' || input.code_challenge_method !== 'S256' ||
        !validSecret(input.code_challenge) || !validSecret(input.state)) throw new OAuthError('invalid_request');
    const client = await getClient(input.client_id);
    const redirect = validateRedirect(input.redirect_uri, client.redirect_uris);
    const scopes = parseScopes(input.scope);
    if (scopes.some(scope => !client.allowed_scopes.includes(scope))) throw new OAuthError('invalid_scope');
    const name = input.device_name;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))) {
        throw new OAuthError('invalid_request');
    }
    const request: AuthorizationRequest = { client_id: client.client_id, redirect_uri: redirect,
        scopes, state: input.state, code_challenge: input.code_challenge,
        device_name: typeof name === 'string' ? name.trim() : 'Desktop computer' };
    const id = secret();
    await (await redis()).set(`oauth:request:${hash(id)}`, JSON.stringify(request), { EX: REQUEST_TTL_SECONDS });
    return id;
}

export async function getAuthorization(id: unknown): Promise<AuthorizationRequest> {
    if (!validSecret(id)) throw new OAuthError('invalid_request');
    const value = await (await redis()).get(`oauth:request:${hash(id)}`);
    if (!value) throw new OAuthError('invalid_request');
    const request = JSON.parse(value) as AuthorizationRequest;
    const client = await getClient(request.client_id);
    validateRedirect(request.redirect_uri, client.redirect_uris);
    if (request.scopes.some(scope => !client.allowed_scopes.includes(scope))) throw new OAuthError('invalid_scope');
    return request;
}

export async function approveAuthorization(id: unknown, twitchID: string, approve: boolean): Promise<string> {
    const request = await getAuthorization(id);
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: twitchID } } }).lean();
    if (!user) throw new OAuthError('account_required', 403);
    const value = await (await redis()).getDel(`oauth:request:${hash(id as string)}`);
    if (!value) throw new OAuthError('invalid_request');
    const url = new URL(request.redirect_uri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('iss', oauthIssuer());
    if (!approve) url.searchParams.set('error', 'access_denied');
    else {
        const code = secret();
        const record: AuthorizationCode = { ...request, user_id: user._id.toString(), channel_id: twitchID };
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
    const client = await getClient(input.client_id);
    if (!validSecret(input.code) || typeof input.code_verifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new OAuthError('invalid_grant');
    const key = `oauth:code:${hash(input.code)}`;
    const value = await (await redis()).get(key);
    if (!value) throw new OAuthError('invalid_grant');
    const record = JSON.parse(value) as AuthorizationCode;
    const challenge = hash(input.code_verifier);
    if (record.client_id !== client.client_id || record.redirect_uri !== input.redirect_uri ||
        !timingSafeEqual(Buffer.from(challenge), Buffer.from(record.code_challenge)) ||
        record.scopes.some(scope => !client.allowed_scopes.includes(scope))) throw new OAuthError('invalid_grant');
    if (!await (await redis()).getDel(key)) throw new OAuthError('invalid_grant');
    const user = await UsersSchema.exists({ _id: record.user_id,
        accounts: { $elemMatch: { type: 'twitch', id: record.channel_id } } });
    if (!user) throw new OAuthError('invalid_grant');
    const grant = await OAuthGrant.findOneAndUpdate({ user_id: record.user_id, client_id: client.client_id,
        channel_id: record.channel_id }, { $addToSet: { scopes: { $each: record.scopes } },
        $set: { revoked_at: null } }, { upsert: true, new: true });
    const now = new Date();
    const refresh = secret('dima_rt_');
    const session = await OAuthSession.create({ grant_id: grant._id, user_id: record.user_id,
        client_id: record.client_id, channel_id: record.channel_id, device_name: record.device_name,
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
    scopes: string[]; idle_expires_at: Date; expires_at: Date;
}
async function tokenResponse(session: SessionRecord, refresh: string) {
    const identity: AccessIdentity = { session_id: session._id.toString(), user_id: session.user_id.toString(),
        client_id: session.client_id, channel_id: session.channel_id, scopes: session.scopes };
    return { access_token: await makeAccess(identity), token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS,
        refresh_token: refresh, scope: session.scopes.join(' '), session_id: identity.session_id,
        refresh_expires_in: Math.max(0, Math.floor((Math.min(session.idle_expires_at.getTime(), session.expires_at.getTime()) - Date.now()) / 1000)) };
}

async function activeSession(id: string) {
    const now = new Date();
    const session = await OAuthSession.findOne({ _id: id, revoked_at: null,
        expires_at: { $gt: now }, idle_expires_at: { $gt: now } }).select('+current_refresh_hash');
    if (!session) throw new OAuthError('invalid_token', 401);
    const grant = await OAuthGrant.findOne({ _id: session.grant_id, revoked_at: null }).select('scopes').lean();
    const client = await getClient(session.client_id);
    const user = await UsersSchema.exists({ _id: session.user_id,
        accounts: { $elemMatch: { type: 'twitch', id: session.channel_id } } });
    if (!grant || !user || session.scopes.some(scope => !client.allowed_scopes.includes(scope) ||
        !grant.scopes.includes(scope) || !Object.hasOwn(OAUTH_SCOPES, scope) ||
        !OAUTH_SCOPES[scope as keyof typeof OAUTH_SCOPES].active)) throw new OAuthError('invalid_token', 401);
    return session;
}

export async function refreshAccess(input: Record<string, unknown>) {
    const client = await getClient(input.client_id);
    if (typeof input.refresh_token !== 'string' || !/^dima_rt_[A-Za-z0-9_-]{43}$/.test(input.refresh_token)) throw new OAuthError('invalid_grant');
    const tokenHash = hash(input.refresh_token);
    const record = await OAuthRefreshToken.findOne({ token_hash: tokenHash, expires_at: { $gt: new Date() } });
    if (!record) throw new OAuthError('invalid_grant');
    let session;
    try { session = await activeSession(record.session_id.toString()); }
    catch { throw new OAuthError('invalid_grant'); }
    if (session.client_id !== client.client_id) throw new OAuthError('invalid_grant');
    if (input.scope !== undefined && (typeof input.scope !== 'string' || input.scope !== session.scopes.join(' '))) {
        throw new OAuthError('invalid_scope');
    }
    if (record.used_at || session.current_refresh_hash !== tokenHash) {
        await revokeSession(session._id.toString(), 'refresh_reuse');
        throw new OAuthError('invalid_grant');
    }
    const refresh = secret('dima_rt_');
    const nextHash = hash(refresh);
    await OAuthRefreshToken.create({ token_hash: nextHash, session_id: session._id, expires_at: session.expires_at });
    const now = new Date();
    const rotated = await OAuthSession.findOneAndUpdate({ _id: session._id, revoked_at: null,
        current_refresh_hash: tokenHash, idle_expires_at: { $gt: now }, expires_at: { $gt: now } },
        { $set: { current_refresh_hash: nextHash, last_used_at: now,
            idle_expires_at: new Date(Math.min(now.getTime() + REFRESH_IDLE_MS, session.expires_at.getTime())) } }, { new: true });
    if (!rotated) {
        await revokeSession(session._id.toString(), 'refresh_reuse');
        throw new OAuthError('invalid_grant');
    }
    try {
        await OAuthRefreshToken.updateOne({ _id: record._id }, { $set: { used_at: now } });
        return await tokenResponse(rotated, refresh);
    } catch (error) { await revokeSession(session._id.toString(), 'rotation_failed'); throw error; }
}

export async function authenticateAccess(token: unknown): Promise<AccessIdentity> {
    if (typeof token !== 'string' || !/^dima_at_[A-Za-z0-9_-]{43}$/.test(token)) throw new OAuthError('invalid_token', 401);
    const value = await (await redis()).get(`oauth:access:${hash(token)}`);
    if (!value) throw new OAuthError('invalid_token', 401);
    const identity = JSON.parse(value) as AccessIdentity;
    const session = await activeSession(identity.session_id);
    if (identity.user_id !== session.user_id.toString() || identity.client_id !== session.client_id ||
        identity.channel_id !== session.channel_id || identity.scopes.some(scope => !session.scopes.includes(scope))) {
        throw new OAuthError('invalid_token', 401);
    }
    return identity;
}

export async function revokeSession(id: string, reason = 'user_revoked') {
    await OAuthSession.updateOne({ _id: id, revoked_at: null }, { $set: { revoked_at: new Date(), revoke_reason: reason } });
}

/** RFC 7009: an unknown token returns success without exposing its existence. */
export async function revokeToken(input: Record<string, unknown>) {
    const client = await getClient(input.client_id);
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

export async function revokeUserOAuth(userID: string) {
    if (!Types.ObjectId.isValid(userID)) return;
    await OAuthGrant.updateMany({ user_id: userID }, { $set: { revoked_at: new Date() } });
    await OAuthSession.updateMany({ user_id: userID }, { $set: { revoked_at: new Date(), revoke_reason: 'account_deleted' } });
    const sessions = await OAuthSession.find({ user_id: userID }).select('_id').lean();
    await OAuthRefreshToken.deleteMany({ session_id: { $in: sessions.map(session => session._id) } });
    await OAuthSession.deleteMany({ user_id: userID });
    await OAuthGrant.deleteMany({ user_id: userID });
}
