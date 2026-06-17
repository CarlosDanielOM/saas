import cors from 'cors';
import express from 'express';
import { extensionRouter } from './routes/extension.routes.js';

export function createServer(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ error: false, status: 200, data: { ok: true } });
  });

  app.use('/v1', extensionRouter);

  return app;
}
