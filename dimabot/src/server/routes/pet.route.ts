import express, { type Request, type Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import UsersSchema from '../../schemas/users.schema.js';
import { getPetConfiguration, savePetConfiguration, PetSettingsError } from '../services/pet_settings.service.js';
import { PetError, cancelPetRequest, requestView } from '../../pets/state.js';
import { petOverlayToken, authenticatePetCapability, authorizePetAudio } from '../../pets/tokens.js';
import { getPetRuntime, assetUrls, MAX_PET_AUDIO_BYTES } from '../../pets/runtime.js';
import { PetRequest } from '../../schemas/pet_runtime.schema.js';
import { AssetError } from '../../assets/library.js';
import { serveAsset } from '../../assets/http.js';

export const petRoute = express.Router();
petRoute.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next(); });
function route(fn: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response) => { void fn(req, res).catch(error => {
        if (res.headersSent) { res.destroy(); return; }
        const known = error instanceof PetError || error instanceof PetSettingsError || error instanceof AssetError;
        res.status(known ? error.status : 503).json({ error: true, message: known ? error.code : 'temporarily_unavailable' });
    }); };
}
// Capability/media routes precede dashboard authentication. A capability cannot read prompts/credits/sessions.
petRoute.get('/public/:capability', route(async (req, res) => {
    const { runtime, configuration } = await authenticatePetCapability(req.params.capability);
    const active = runtime.activeRequestId ? await PetRequest.findById(runtime.activeRequestId).lean() : null;
    res.json({ error: false, data: { appearance: configuration.settings.appearance, playback: { target: configuration.settings.playback.target },
        runtime: { v: 1, generation: runtime.generation, active: requestView(active) },
        assets: assetUrls(String(req.params.capability), configuration.settings.appearance) } });
}));
petRoute.get('/public/:capability/assets/:assetId', route(async (req, res) => {
    const { runtime, configuration } = await authenticatePetCapability(req.params.capability);
    const assetId = String(req.params.assetId), appearance = configuration.settings.appearance;
    if (assetId !== appearance.idleAssetId && assetId !== appearance.talkingAssetId) throw new PetError('asset_not_found', 404);
    return serveAsset(req, res, runtime.channelId, assetId);
}));
petRoute.get('/playback/:requestId/audio', route(async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'ticket')) throw new PetError('invalid_ticket');
    const audio = await authorizePetAudio(String(req.params.requestId), req.query.ticket);
    const file = await stat(audio.path);
    if (file.size > MAX_PET_AUDIO_BYTES) throw new PetError('audio_too_large');
    res.type(audio.mimeType); res.set('Content-Length', String(file.size));
    await pipeline(createReadStream(audio.path), res);
}));
petRoute.use(authMiddleware);
async function owner(req: AuthRequest) {
    const channelID = String(req.params.channelID);
    if (!req.user?.id || req.user.id !== channelID) throw new PetError('access_denied', 403);
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('_id').lean();
    if (!user) throw new PetError('account_required', 404);
    return { ownerId: String(user._id), channelID };
}
petRoute.get('/:channelID/settings', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); res.json({ error: false, data: await getPetConfiguration(ownerId, channelID) });
}));
petRoute.put('/:channelID/settings', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); res.json({ error: false, data: await savePetConfiguration(ownerId, channelID, req.body) });
}));
petRoute.get('/:channelID/runtime', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); res.json({ error: false, data: await getPetRuntime(ownerId, channelID) });
}));
petRoute.get('/:channelID/overlay-token', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); res.json({ error: false, data: await petOverlayToken(ownerId, channelID) });
}));
petRoute.post('/:channelID/overlay-token', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); res.json({ error: false, data: await petOverlayToken(ownerId, channelID, req.body) });
}));
petRoute.post('/:channelID/requests/:requestId/cancel', route(async (req, res) => {
    const { ownerId, channelID } = await owner(req); await getPetConfiguration(ownerId, channelID);
    if (!req.body || Object.keys(req.body).some(key => key !== 'commandId')) throw new PetError('invalid_command');
    res.json({ error: false, data: await cancelPetRequest(ownerId, String(req.params.requestId), req.body.commandId) });
}));
