import { readFile as nodeReadFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

export async function readFile(filePath: string): Promise<string> {
    const resolvedPath = resolve(filePath);

    // Check file size first
    const stats = await stat(resolvedPath);
    if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE} bytes`);
    }

    const content = await nodeReadFile(resolvedPath, 'utf-8');
    return content;
}