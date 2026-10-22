import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

import { readAudioStream } from '../../../utils/tts/tts_deadline.util.js';
import { getDirname } from '../../../utils/pollyfills.js';
import type { TtsProvider, TtsSynthesisRequest, TtsSynthesisResult } from './tts_provider.interface.js';

const __dirname = getDirname(import.meta.url);
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../../routes/public/speech');

function getPiperPythonBin(): string {
    return process.env.PIPER_PYTHON_BIN || 'python3';
}

function getPiperDataDir(): string | null {
    const configured = process.env.PIPER_DATA_DIR;
    if (configured && configured.trim() !== '') {
        return configured.trim();
    }

    return null;
}

function getPiperHttpUrl(): string | null {
    const configured = process.env.PIPER_HTTP_URL;
    if (!configured || configured.trim() === '') {
        return null;
    }

    return configured.replace(/\/+$/, '');
}

function getPublicApiUrl(): string {
    const configured = process.env.PUBLIC_API_URL;
    if (configured && configured.trim() !== '') {
        return configured.replace(/\/+$/, '');
    }

    return process.env.NODE_ENV === 'production'
        ? 'https://api.domdimabot.com'
        : 'http://localhost:3000';
}

function buildPublicPath(channelID: string, speechID: string): string {
    return `${getPublicApiUrl()}/speech/audio/${encodeURIComponent(channelID)}/${encodeURIComponent(speechID)}`;
}

async function ensureSpeechOutputDir(channelID: string): Promise<string> {
    const outputDir = path.join(DEFAULT_PUBLIC_DIR, channelID);
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
}

async function writeHttpResult(response: Response, outputPath: string, request: TtsSynthesisRequest): Promise<void> {
    const buffer = response.body ? await readAudioStream(response.body, request.signal ?? AbortSignal.timeout(30_000), request.maxAudioBytes) : Buffer.alloc(0);
    await fs.writeFile(outputPath, buffer);
}

async function runPiperCli(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const args = ['-m', 'piper', '-m', request.voice, '-f', request.outputPath];
    const dataDir = getPiperDataDir();
    if (dataDir) {
        args.push('--data-dir', dataDir);
    }
    args.push('--', request.text);

    return await new Promise<TtsSynthesisResult>((resolve) => {
        const child = spawn(getPiperPythonBin(), args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            signal: request.signal, timeout: 30_000
        });

        let stderr = '';

        child.stderr.on('data', (chunk: Buffer | string) => {
            stderr = (stderr + String(chunk)).slice(-4096);
        });

        child.on('error', (error) => {
            resolve({
                error: true,
                message: `Failed to start Piper CLI: ${error.message}`
            });
        });

        child.on('close', (code) => {
            if (code !== 0) {
                resolve({
                    error: true,
                    message: stderr.trim() || `Piper CLI exited with code ${code}`
                });
                return;
            }

            resolve({
                error: false,
                message: 'Speech synthesized with Piper CLI',
                outputPath: request.outputPath,
                publicPath: request.privateOutput ? undefined : buildPublicPath(request.channelID, request.speechID),
                mimeType: 'audio/wav'
            });
        });
    });
}

async function runPiperHttp(request: TtsSynthesisRequest, baseUrl: string): Promise<TtsSynthesisResult> {
    const response = await fetch(`${baseUrl}/synthesize`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text: request.text,
            voice: request.voice
        }),
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
        const body = request.privateOutput ? (await response.body?.cancel(), '') : await response.text();
        return {
            error: true,
            message: body || `Piper HTTP synthesis failed with ${response.status}`
        };
    }

    await writeHttpResult(response, request.outputPath, request);

    return {
        error: false,
        message: 'Speech synthesized with Piper HTTP',
        outputPath: request.outputPath,
        publicPath: request.privateOutput ? undefined : buildPublicPath(request.channelID, request.speechID),
        mimeType: 'audio/wav'
    };
}

class PiperTtsService implements TtsProvider {
    readonly name = 'piper';

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
        try {
            request.signal?.throwIfAborted();
            const outputDir = request.privateOutput ? path.dirname(request.outputPath) : await ensureSpeechOutputDir(request.channelID);
            await fs.mkdir(outputDir, { recursive: true });
            const outputPath = request.privateOutput ? request.outputPath : path.join(outputDir, `${request.speechID}.wav`);
            const normalizedRequest: TtsSynthesisRequest = {
                ...request,
                outputPath
            };

            const httpUrl = getPiperHttpUrl();
            if (httpUrl) {
                return await runPiperHttp(normalizedRequest, httpUrl);
            }

            const result = await runPiperCli(normalizedRequest);
            if (!result.error && request.maxAudioBytes && (await fs.stat(outputPath)).size > request.maxAudioBytes) {
                await fs.rm(outputPath, { force: true });
                return { error: true, message: 'Piper audio exceeds byte limit' };
            }
            return result;
        } catch (error) {
            return {
                error: true,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

const piperTtsService = new PiperTtsService();

export { piperTtsService, DEFAULT_PUBLIC_DIR as PIPER_PUBLIC_SPEECH_DIR, buildPublicPath };
