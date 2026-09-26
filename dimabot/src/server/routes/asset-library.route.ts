import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { AssetError, MAX_ASSET_BYTES, assetQuota, deleteAsset, findAsset, listAssets, uploadAsset } from '../../assets/library.js';
import { serveAsset } from '../../assets/http.js';

export const assetLibraryRoute = express.Router();
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => (req: AuthRequest, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const param = (req: Request, name: string) => String(req.params[name] ?? '');
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
const secret = () => { if (!process.env.SECRET_KEY) throw new AssetError('unavailable', 503); return process.env.SECRET_KEY; };
assetLibraryRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
assetLibraryRoute.get('/content/:id', wrap(async (req, res) => {
  let owner: string;
  try {
    const claims = jwt.verify(typeof req.query.ticket === 'string' ? req.query.ticket : '', secret(), { algorithms: ['HS256'], audience: 'asset-preview' });
    if (typeof claims === 'string' || claims.sub !== param(req, 'id') || typeof claims.owner !== 'string') throw new Error('Wrong scope');
    owner = claims.owner;
  } catch { throw new AssetError('unauthorized', 401); }
  return serveAsset(req, res, owner, param(req, 'id'));
}));
assetLibraryRoute.use(authMiddleware);
assetLibraryRoute.use('/:channelID', (req: AuthRequest, _res, next) => {
  if (req.user?.id !== param(req, 'channelID')) return next(new AssetError('owner_required', 403));
  void assetQuota(param(req, 'channelID')).then(() => next(), next);
});
assetLibraryRoute.get('/:channelID', wrap(async (req, res) => ok(res, await listAssets(param(req, 'channelID')))));
assetLibraryRoute.get('/:channelID/:id/access', wrap(async (req, res) => {
  const asset = await findAsset(param(req, 'channelID'), param(req, 'id'));
  const ticket = jwt.sign({ owner: param(req, 'channelID') }, secret(), { algorithm: 'HS256', audience: 'asset-preview', subject: asset.id, expiresIn: '15m' });
  return ok(res, { path: `/asset-library/content/${asset.id}?ticket=${encodeURIComponent(ticket)}` });
}));
// Bound ingress globally and per owner before accepting multipart bytes.
const uploading = new Set<string>();
assetLibraryRoute.post('/:channelID', wrap(async (req, res) => {
  const owner = param(req, 'channelID');
  if (uploading.has(owner) || uploading.size >= 4) throw new AssetError('upload_busy', 429);
  uploading.add(owner);
  let directory: string | undefined;
  const streams = new Set<Readable | Writable>();
  const deadline = setTimeout(() => req.destroy(), 120_000);
  try {
    directory = await mkdtemp(join(tmpdir(), 'design-asset-'));
    const path = join(directory, 'upload');
    const storage: multer.StorageEngine = {
      _handleFile(_req, file, callback) {
        const output = createWriteStream(path, { flags: 'wx' });
        streams.add(file.stream); streams.add(output);
        void pipeline(file.stream, output).then(() => callback(null, { path, size: output.bytesWritten }), error => callback(error));
      },
      _removeFile(_req, _file, callback) { void rm(path, { force: true }).then(() => callback(null), callback); }
    };
    const upload = multer({ storage, limits: { fileSize: MAX_ASSET_BYTES, files: 1, fields: 0, parts: 2 } }).single('file');
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { req.unpipe(); for (const stream of streams) stream.destroy(); reject(new AssetError('upload_aborted', 400)); };
      if (req.destroyed) { aborted(); return; }
      req.once('aborted', aborted);
      upload(req, res, error => { req.off('aborted', aborted); error ? reject(error) : resolve(); });
    });
    if (!req.file) throw new AssetError('file_required');
    return ok(res, await uploadAsset(owner, req.file));
  } finally {
    clearTimeout(deadline);
    for (const stream of streams) stream.destroy();
    uploading.delete(owner);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}));
assetLibraryRoute.delete('/:channelID/:id', wrap(async (req, res) => {
  await deleteAsset(param(req, 'channelID'), param(req, 'id'));
  return ok(res, { deleted: true });
}));
assetLibraryRoute.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.destroyed) return;
  if (res.headersSent) return next(error);
  const status = error instanceof AssetError ? error.status : error instanceof multer.MulterError ? 413 : 500;
  const code = error instanceof AssetError ? error.code : error instanceof multer.MulterError ? 'file_size' : 'unavailable';
  if (status === 500) console.error('Asset library request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(status).json({ error: true, status, code, message: code });
});
