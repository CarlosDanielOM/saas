/** Run with tsx from the main checkout's dimabot directory. Only loopback is contacted.
 * Uses the frozen reference client; fixed Date controls the SDK signing clock.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`);
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const canonicals: string[] = [];
const { SignatureV4 } = require('@smithy/signature-v4');
const originalCanonical = SignatureV4.prototype.createCanonicalRequest;
SignatureV4.prototype.createCanonicalRequest = function(...args: any[]) { const c = originalCanonical.apply(this,args); canonicals.push(c); return c; };
const RealDate = Date;
class FixedDate extends RealDate { constructor(...args: any[]) { super(args.length ? args[0] : '2013-05-24T00:00:00Z'); } static now() { return new RealDate('2013-05-24T00:00:00Z').getTime(); } }
// @ts-ignore test clock
 globalThis.Date = FixedDate;
Object.assign(process.env, { S3_REGION: 'us-east-1', S3_ENDPOINT_URL: 'http://127.0.0.1:18743', S3_BUCKET: 'examplebucket', S3_ACCESS_KEY: 'AKIDEXAMPLE', S3_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
async function main() {
 const requests: any[] = [];
 const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push({ canonical: canonicals.shift(), method: req.method, target: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') });
  res.setHeader('date', 'Fri, 24 May 2013 00:00:00 GMT');
  res.setHeader('content-type', 'application/xml');
  res.end(req.method === 'POST' ? '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>' : req.method === 'GET' ? 'hello' : '');
 });
 await new Promise<void>(r => server.listen(18743, '127.0.0.1', r));
 const { s3Client, uploadTriggerFileToS3, deleteTriggerFileFromS3 } = await import(`${process.cwd()}/src/utils/s3.ts`);
 const key = "folder/a b+!*'()é😀/file.txt";
 try {
  await uploadTriggerFileToS3('123', Buffer.from('hello'), 'text/plain', key);
  for (const [ContentType, CacheControl, ACL] of [ ['text/plain; charset=utf-8', 'private, max-age=31536000, immutable', undefined], ['image/jpeg', 'public, max-age=31536000, immutable', 'public-read'], ['video/mp4', 'private, max-age=86400', 'public-read'] ]) {
   await s3Client.send(new PutObjectCommand({ Bucket: 'examplebucket', Key: key, Body: Buffer.from('hello'), ContentType, CacheControl, ACL }));
  }
  await uploadTriggerFileToS3('123', createReadStream(fileURLToPath(new URL('./payload.txt', import.meta.url))), 'text/plain', key);
  const response = await s3Client.send(new GetObjectCommand({ Bucket: 'examplebucket', Key: key }));
  await response.Body.transformToString();
  await deleteTriggerFileFromS3('123', key);
  await s3Client.send(new DeleteObjectsCommand({ Bucket: 'examplebucket', Delete: { Objects: [{Key:key}, {Key:'a&<b'}], Quiet: true } }));
  await writeFile(process.argv[2], JSON.stringify(requests, null, 2) + '\n');
 } finally { s3Client.destroy(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
