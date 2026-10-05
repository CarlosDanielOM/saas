import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { AssetError, findAsset, readAsset } from './library.js';

export async function serveAsset(req: Request, res: Response, owner: string, id: string, cacheImages = false) {
  const asset = await findAsset(owner, id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Accept-Ranges', 'bytes');
  res.type(asset.mime);
  // Uploaded bytes are immutable per ID. Revalidate access before reusing bytes;
  // private library previews and non-image playback retain their existing policy.
  if (cacheImages && asset.kind === 'image') {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', `"asset-${asset.id}"`);
    if (req.fresh) return res.status(304).end();
  }
  let start = 0, end = asset.bytes - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || !match[1] && !match[2]) { res.setHeader('Content-Range', `bytes */${asset.bytes}`); throw new AssetError('invalid_range', 416); }
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    else start = Math.max(0, asset.bytes - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.bytes) { res.setHeader('Content-Range', `bytes */${asset.bytes}`); throw new AssetError('invalid_range', 416); }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${asset.bytes}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  const { stream } = await readAsset(owner, id, start, end + 1);
  try { await pipeline(stream, res); }
  catch (error) { if (!res.destroyed) throw error; }
}
