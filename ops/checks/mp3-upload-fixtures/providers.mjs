// Stage overlay-controls-fixtures/providers.mjs as startup-providers.mjs beside
// this file. Reuse its external-provider boundary and real API initialization.
import './startup-providers.mjs';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { s3Client } from '/app/dist/utils/s3.js';

// Only storage transport is replaced: multipart parsing, authorization, quota,
// S3 command construction, and MongoDB writes use the candidate implementation.
s3Client.send = async command => {
    if (command.constructor.name !== 'PutObjectCommand') throw new Error('Unexpected storage operation');
    const { Body, ContentType, Key } = command.input;
    const chunks = [];
    for await (const chunk of Body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (Key.includes('Storage_failure')) throw new Error('Fixture storage failure');
    appendFileSync('/tmp/saas-fixtures/storage.jsonl', JSON.stringify({
        key: Key, contentType: ContentType, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
    }) + '\n');
    return {};
};
