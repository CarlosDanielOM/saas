import cors from 'cors';
import { assertProductionConfiguration } from './middleware/twitch-extension-auth.js';
import express from 'express';
import { extensionRouter } from './routes/extension.routes.js';

export function createServer(): express.Express {
  try {
    assertProductionConfiguration();
  } catch (error) {
    // Stay up (health checks pass) but loud: the auth middleware answers every extension request with 503 until fixed.
    console.error(`${String(error)}. Set the missing values and redeploy dimafx-server.`);
  }
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ error: false, status: 200, data: { ok: true } });
  });

  app.use('/v1', extensionRouter);

  return app;
}
