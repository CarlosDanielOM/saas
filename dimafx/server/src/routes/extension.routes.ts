import express, { type Response } from 'express';
import { dimabotClient } from '../services/dimabot-client.js';
import { ensureChannelMatches, twitchExtensionAuth, type TwitchExtensionRequest } from '../middleware/twitch-extension-auth.js';

const router = express.Router();

function getParamValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value || '';
}

function extensionIdentityBody(req: TwitchExtensionRequest): Record<string, unknown> {
  return {
    userID: req.extension?.userID,
    opaqueUserID: req.extension?.opaqueUserID,
    displayName: undefined
  };
}

function proxyResponse<T>(res: Response, payload: { error: boolean; status?: number; message?: string; data?: T; meta?: Record<string, unknown> }): Response {
  return res.status(payload.status || (payload.error ? 500 : 200)).json(payload);
}

router.use(twitchExtensionAuth);

router.get('/me', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    if (!req.extension) {
      return res.status(401).json({ error: true, message: 'Unauthorized', status: 401 });
    }

    if (!req.extension.userID) {
      return res.status(200).json({
        error: false,
        status: 200,
        data: {
          identityShared: false,
          platform: 'twitch',
          opaqueUserID: req.extension.opaqueUserID,
          channelID: req.extension.channelID,
          balance: 0,
          inventory: null
        }
      });
    }

    const payload = await dimabotClient.post<Record<string, unknown>>(
      `/extensions/dimafx/internal/channels/${encodeURIComponent(req.extension.channelID)}/viewers/${encodeURIComponent(req.extension.userID)}/init`,
      {}
    );

    return res.status(payload.status || 200).json({
      ...payload,
      data: {
        identityShared: true,
        platform: 'twitch',
        channelID: req.extension.channelID,
        userID: req.extension.userID,
        inventory: payload.data,
        balance: Number((payload.data as { balance?: number } | undefined)?.balance || 0)
      }
    });
  } catch (error) {
    console.error('Error in GET /v1/me:', { error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

router.get('/channels/:channelID/items', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    const channelID = getParamValue(req.params.channelID);
    if (!ensureChannelMatches(req, res, channelID)) return;

    const payload = await dimabotClient.get<unknown[]>(`/extensions/dimafx/internal/channels/${encodeURIComponent(channelID)}/items`);
    return proxyResponse(res, payload);
  } catch (error) {
    console.error('Error in GET /v1/channels/:channelID/items:', { channelID: req.params.channelID, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

router.patch('/channels/:channelID/me/config', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    const channelID = getParamValue(req.params.channelID);
    if (!ensureChannelMatches(req, res, channelID)) return;
    if (!req.extension?.userID) {
      return res.status(403).json({ error: true, message: 'Share your Twitch identity to save DimaFX preferences', status: 403 });
    }

    const payload = await dimabotClient.patch<Record<string, unknown>>(
      `/extensions/dimafx/internal/channels/${encodeURIComponent(channelID)}/viewers/${encodeURIComponent(req.extension.userID)}/config`,
      {
        quickPurchasePriority: req.body?.quickPurchasePriority,
        quickPurchaseAction: req.body?.quickPurchaseAction
      }
    );
    return proxyResponse(res, payload);
  } catch (error) {
    console.error('Error in PATCH /v1/channels/:channelID/me/config:', { channelID: req.params.channelID, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

router.post('/channels/:channelID/items/:itemID/purchase', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    const channelID = getParamValue(req.params.channelID);
    const itemID = getParamValue(req.params.itemID);
    if (!ensureChannelMatches(req, res, channelID)) return;

    const payload = await dimabotClient.post<Record<string, unknown>>(
      `/extensions/dimafx/internal/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(itemID)}/purchase`,
      {
        ...extensionIdentityBody(req),
        sku: req.body?.sku,
        transactionID: req.body?.transactionID,
        action: req.body?.action
      }
    );
    return proxyResponse(res, payload);
  } catch (error) {
    console.error('Error in POST /v1/channels/:channelID/items/:itemID/purchase:', { channelID: req.params.channelID, itemID: req.params.itemID, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

router.post('/channels/:channelID/items/:itemID/use-credit', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    const channelID = getParamValue(req.params.channelID);
    const itemID = getParamValue(req.params.itemID);
    if (!ensureChannelMatches(req, res, channelID)) return;
    if (!req.extension?.userID) {
      return res.status(403).json({ error: true, message: 'Share your Twitch identity to use DimaFX credits', status: 403 });
    }

    const payload = await dimabotClient.post<Record<string, unknown>>(
      `/extensions/dimafx/internal/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(itemID)}/use-credit`,
      { ...extensionIdentityBody(req), action: req.body?.action }
    );
    return proxyResponse(res, payload);
  } catch (error) {
    console.error('Error in POST /v1/channels/:channelID/items/:itemID/use-credit:', { channelID: req.params.channelID, itemID: req.params.itemID, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

router.post('/channels/:channelID/items/:itemID/redeem', async (req: TwitchExtensionRequest, res: Response) => {
  try {
    const channelID = getParamValue(req.params.channelID);
    const itemID = getParamValue(req.params.itemID);
    if (!ensureChannelMatches(req, res, channelID)) return;
    if (!req.extension?.userID) {
      return res.status(403).json({ error: true, message: 'Share your Twitch identity to redeem saved items', status: 403 });
    }

    const payload = await dimabotClient.post<Record<string, unknown>>(
      `/extensions/dimafx/internal/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(itemID)}/redeem`,
      extensionIdentityBody(req)
    );
    return proxyResponse(res, payload);
  } catch (error) {
    console.error('Error in POST /v1/channels/:channelID/items/:itemID/redeem:', { channelID: req.params.channelID, itemID: req.params.itemID, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
    return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
  }
});

export const extensionRouter = router;
