import express, { type Response } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import UsersSchema from '../../schemas/users.schema.js';
import { getPetConfiguration, savePetConfiguration, PetSettingsError } from '../services/pet_settings.service.js';

export const petRoute = express.Router();
petRoute.use(authMiddleware);
petRoute.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

async function handle(req: AuthRequest, res: Response) {
    try {
        const channelID = String(req.params.channelID);
        // A pet belongs to the account owner, not their delegated channel managers.
        if (!req.user?.id || req.user.id !== channelID) return res.status(403).json({ error: true, message: 'access_denied' });
        const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('_id').lean();
        if (!user) return res.status(404).json({ error: true, message: 'account_required' });
        const data = req.method === 'PUT' ? await savePetConfiguration(String(user._id), channelID, req.body) :
            await getPetConfiguration(String(user._id), channelID);
        return res.json({ error: false, data });
    } catch (error) {
        return res.status(error instanceof PetSettingsError ? error.status : 503).json({ error: true,
            message: error instanceof PetSettingsError ? error.code : 'temporarily_unavailable' });
    }
}
petRoute.get('/:channelID/settings', handle);
petRoute.put('/:channelID/settings', handle);
