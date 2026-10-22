import express, { type Request, type Response, type NextFunction } from 'express';
import { Types } from 'mongoose';
import UsersSchema from '../../schemas/users.schema.js';
import { OAuthGrant } from '../../schemas/oauth_grant.schema.js';
import { OAuthSession } from '../../schemas/oauth_session.schema.js';
import { getAiCredits } from '../../utils/billing.js';
import { getFreeAiCreditDisplay } from '../../utils/ai_credit_display.js';
import { getPetConfiguration, PetSettingsError } from '../services/pet_settings.service.js';
import { PetError, cancelPetRequest } from '../../pets/state.js';
import { getPetRuntime } from '../../pets/runtime.js';
import { selectOwnPetPlayback } from '../../pets/selection.js';
import { ACCESS_TTL_SECONDS, DESKTOP_CLIENT_ID, OAuthError, OAUTH_SCOPES } from './catalog.js';
import { approveAuthorization, authenticateAccess, exchangeCode, getAuthorization, getClient,
    oauthIssuer, oauthWebsite, rateLimit, refreshAccess, revokeSession, revokeToken,
    startAuthorization, type AccessIdentity } from './service.js';

const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

export function oauthBoundary(req: Request, res: Response, next: NextFunction) {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff' });
    const origin = req.get('origin');
    if (origin && origin !== oauthWebsite()) return res.status(403).json({ error: 'access_denied' });
    if (origin) {
        res.set('Access-Control-Allow-Origin', origin);
        res.vary('Origin');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
}

function body(req: Request): Record<string, unknown> {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new OAuthError('invalid_request');
    const value = req.body as Record<string, unknown>;
    // Duplicate form parameters are arrays; reject them instead of guessing.
    if (Object.values(value).some(item => typeof item !== 'string' && typeof item !== 'boolean')) throw new OAuthError('invalid_request');
    return value;
}

/** Fresh provider proof, not the legacy profile-sync endpoint or its long-lived identity cache. */
async function browserUser(req: Request) {
    const token = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{10,512})$/)?.[1];
    if (!token || token.startsWith('dima_')) throw new OAuthError('login_required', 401);
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new OAuthError('login_required', 401);
    const proof = await response.json() as { client_id?: string; user_id?: string; expires_in?: number };
    if (proof.client_id !== process.env.CLIENT_ID || !proof.user_id || !proof.expires_in || proof.expires_in <= 0) {
        throw new OAuthError('login_required', 401);
    }
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: proof.user_id } } }).lean();
    if (!user) throw new OAuthError('account_required', 403);
    return { user, twitchID: proof.user_id };
}

async function access(req: Request, scope?: string): Promise<AccessIdentity> {
    const token = req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    const identity = await authenticateAccess(token);
    if (scope && !identity.scopes.includes(scope)) throw new OAuthError('insufficient_scope', 403);
    // Beta routes never accept a client-selected account/channel.
    if (Object.keys(req.query).length) throw new OAuthError('invalid_request');
    return identity;
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
    const known = error instanceof OAuthError || error instanceof PetError || error instanceof PetSettingsError;
    const status = known ? error.status : 503;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    if (status === 429) res.set('Retry-After', '60');
    // Do not log request bodies, bearer tokens, codes or provider error responses.
    if (!known) console.error('[OAuth] Request failed', error instanceof Error ? error.name : 'UnknownError');
    res.status(status).json({ error: known ? error.code : 'temporarily_unavailable' });
}

export const oauthRoute = express.Router();
oauthRoute.use(oauthBoundary);
oauthRoute.use((req, _res, next) => { void rateLimit(`oauth:${req.ip}`, 600).then(() => next(), next); });

export function oauthMetadata(_req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const issuer = oauthIssuer();
    res.json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/revoke`, scopes_supported: Object.entries(OAUTH_SCOPES)
            .filter(([, scope]) => scope.active).map(([name]) => name),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        beta: { client_id: DESKTOP_CLIENT_ID, protocol_version: 1, access_token_lifetime: ACCESS_TTL_SECONDS,
            websocket_endpoint: `${issuer.replace(/^http/, 'ws')}/v1/desktop/ws`,
            socket_io: { path: '/socket.io/', namespace: '/desktop', protocol_version: 1 },
            planned_scopes: Object.entries(OAUTH_SCOPES).filter(([, scope]) => !scope.active).map(([name]) => name) } });
}
oauthRoute.get('/metadata', oauthMetadata);

oauthRoute.get('/authorize', asyncRoute(async (req, res) => {
    const requestID = await startAuthorization(req.query);
    const url = new URL('/oauth/authorize', oauthWebsite());
    url.searchParams.set('request', requestID);
    res.redirect(302, url.href);
}));

oauthRoute.get('/requests/:request', asyncRoute(async (req, res) => {
    const request = await getAuthorization(req.params.request);
    const client = await getClient(request.client_id);
    res.json({ client_id: client.client_id, client_name: client.name, device_name: request.device_name,
        scopes: request.scopes, redirect_uri: request.redirect_uri });
}));

oauthRoute.post('/requests/:request/decision', asyncRoute(async (req, res) => {
    const input = body(req);
    if (typeof input.approve !== 'boolean') throw new OAuthError('invalid_request');
    const { twitchID } = await browserUser(req);
    await rateLimit(`approval:${twitchID}`, 30);
    const redirect_uri = await approveAuthorization(req.params.request, twitchID, input.approve);
    res.json({ redirect_uri });
}));

oauthRoute.post('/token', asyncRoute(async (req, res) => {
    const input = body(req);
    if (input.client_secret !== undefined || req.get('authorization')) throw new OAuthError('invalid_client');
    if (input.grant_type === 'authorization_code') res.json(await exchangeCode(input));
    else if (input.grant_type === 'refresh_token') res.json(await refreshAccess(input));
    else throw new OAuthError('unsupported_grant_type');
}));

oauthRoute.post('/revoke', asyncRoute(async (req, res) => {
    await revokeToken(body(req));
    res.status(200).json({});
}));

oauthRoute.get('/browser-session', asyncRoute(async (req, res) => {
    const { user, twitchID } = await browserUser(req);
    const account = user.accounts.find(item => item.type === 'twitch' && item.id === twitchID);
    res.json({ user_id: user._id.toString(), channel_id: twitchID, name: account?.name || user.name });
}));

// Management uses browser identity, never a desktop scope that can revoke other installations.
oauthRoute.get('/connections', asyncRoute(async (req, res) => {
    const { user } = await browserUser(req);
    const sessions = await OAuthSession.find({ user_id: user._id, revoked_at: null,
        expires_at: { $gt: new Date() }, idle_expires_at: { $gt: new Date() } })
        .select('_id client_id grant_id device_name scopes last_used_at expires_at createdAt').lean();
    res.json({ sessions });
}));

oauthRoute.delete('/connections/:session', asyncRoute(async (req, res) => {
    const { user } = await browserUser(req);
    if (!Types.ObjectId.isValid(String(req.params.session))) throw new OAuthError('invalid_request');
    const session = await OAuthSession.findOne({ _id: req.params.session, user_id: user._id });
    if (!session) throw new OAuthError('not_found', 404);
    await revokeSession(session._id.toString());
    res.json({ revoked: true });
}));

oauthRoute.delete('/grants/:grant', asyncRoute(async (req, res) => {
    const { user } = await browserUser(req);
    if (!Types.ObjectId.isValid(String(req.params.grant))) throw new OAuthError('invalid_request');
    const grant = await OAuthGrant.findOne({ _id: req.params.grant, user_id: user._id });
    if (!grant) throw new OAuthError('not_found', 404);
    // Revoke every installation too, so approving the application again cannot resurrect it.
    await OAuthSession.updateMany({ grant_id: grant._id }, { $set: { revoked_at: new Date(), revoke_reason: 'grant_revoked' } });
    await OAuthGrant.updateOne({ _id: grant._id }, { $set: { revoked_at: new Date() } });
    res.json({ revoked: true });
}));
oauthRoute.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
oauthRoute.use(errorHandler);

export const oauthApiRoute = express.Router();
oauthApiRoute.use(oauthBoundary);
oauthApiRoute.use((req, _res, next) => {
    void rateLimit(`desktop:${req.ip}`, 1200).then(() => next(), next);
});
oauthApiRoute.get('/me', asyncRoute(async (req, res) => {
    const identity = await access(req, 'profile:read');
    const user = await UsersSchema.findById(identity.user_id).select('name accounts.type accounts.id accounts.name').lean();
    const account = user?.accounts.find(item => item.type === 'twitch' && item.id === identity.channel_id);
    if (!account) throw new OAuthError('invalid_token', 401);
    res.json({ user_id: identity.user_id, name: user!.name, channel: { platform: 'twitch', id: account.id, name: account.name } });
}));
oauthApiRoute.get('/me/credits', asyncRoute(async (req, res) => {
    const identity = await access(req, 'credits:read');
    const user = await UsersSchema.findById(identity.user_id);
    if (!user) throw new OAuthError('invalid_token', 401);
    const credits = await getAiCredits(user, identity.channel_id);
    const display = await getFreeAiCreditDisplay(user, identity.channel_id, credits);
    res.json({ ...credits, ...(display ? { display } : {}) });
}));
oauthApiRoute.get('/me/pet', asyncRoute(async (req, res) => {
    const identity = await access(req, 'pet:read');
    try {
        const { profiles: _profiles, voices: _voices, ...configuration } =
            await getPetConfiguration(identity.user_id, identity.channel_id);
        res.json(configuration);
    } catch (error) {
        if (error instanceof PetSettingsError) throw new OAuthError(error.code, error.status);
        throw error;
    }
}));
oauthApiRoute.get('/me/pet/runtime', asyncRoute(async (req, res) => {
    const identity = await access(req, 'pet:read');
    res.json(await getPetRuntime(identity.user_id, identity.channel_id));
}));
oauthApiRoute.put('/me/pet/playback', asyncRoute(async (req, res) => {
    const identity = await access(req, 'pet:playback:select');
    res.json(await selectOwnPetPlayback(identity, req.body));
}));
oauthApiRoute.post('/me/pet/requests/:requestId/cancel', asyncRoute(async (req, res) => {
    const identity = await access(req, 'pet:control');
    await getPetConfiguration(identity.user_id, identity.channel_id);
    if (!req.body || Object.keys(req.body).some(key => key !== 'commandId')) throw new PetError('invalid_command');
    res.json(await cancelPetRequest(identity.user_id, String(req.params.requestId), req.body.commandId));
}));
oauthApiRoute.get('/desktop/session', asyncRoute(async (req, res) => {
    const identity = await access(req, 'desktop:connect');
    const session = await OAuthSession.findById(identity.session_id).select('device_name expires_at').lean();
    res.json({ ...identity, device_name: session?.device_name, expires_at: session?.expires_at,
        protocol_version: 1, pet_available: identity.scopes.includes('pet:receive'),
        socket_io: { path: '/socket.io/', namespace: '/desktop', protocol_version: 1 } });
}));
oauthApiRoute.delete('/desktop/session', asyncRoute(async (req, res) => {
    const identity = await access(req);
    await revokeSession(identity.session_id, 'signed_out');
    res.json({ revoked: true });
}));
oauthApiRoute.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
oauthApiRoute.use(errorHandler);
