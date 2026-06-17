import fs from 'fs';
import { exec } from 'node:child_process';

interface DownloadClipResult {
    error: boolean;
    message: string;
    filePath?: string;
}

export async function downloadClip(
    url: string,
    channelID: string,
    downloadDir: string
): Promise<DownloadClipResult> {
    return new Promise((resolve) => {
        // Use the provided downloadDir parameter instead of rebuilding the path
        const absoluteDownloadDir = downloadDir;
        const filePath = `${absoluteDownloadDir}/${channelID}-clip.mp4`;

        if (!fs.existsSync(absoluteDownloadDir)) {
            fs.mkdirSync(absoluteDownloadDir, { recursive: true });
        }

        // yt-dlp with --no-progress to keep stderr clean for our logging.
        // -S "res:480" preserves the previous "cap at 480p" intent from the old
        // twitch-dl -q 480p flag (clips are single-file so this is mostly a no-op,
        // but it keeps parity in case this is ever reused for VODs).
        // -o with an absolute path ending in .mp4 makes yt-dlp write to that path.
        const command = `yt-dlp --no-progress -S "res:480" -o "${filePath}" "${url}"`;
        const downloadProcess = exec(command);

        let stdoutData = '';
        let stderrData = '';

        if (downloadProcess.stdout) {
            downloadProcess.stdout.on('data', (data) => {
                stdoutData += data;
            });
        }

        if (downloadProcess.stderr) {
            downloadProcess.stderr.on('data', (data) => {
                stderrData += data;
            });
        }

        // Increased timeout to 60 seconds (clips can take longer than 10s)
        const timeout = setTimeout(() => {
            console.error(`Timeout triggered for ${channelID} downloading ${url} after 60 seconds`);
            downloadProcess.kill();

            resolve({
                error: true,
                message: `Download timeout after 60 seconds for URL: ${url}`
            });
        }, 60000);

        downloadProcess.on('exit', (code) => {
            clearTimeout(timeout);

            if (code === 0) {
                // Verify file exists before reporting success
                if (fs.existsSync(filePath)) {
                    resolve({
                        error: false,
                        message: 'Success',
                        filePath
                    });
                } else {
                    console.error(`Download reported success but file not found: ${filePath}`);
                    resolve({
                        error: true,
                        message: `Download completed but file not found at: ${filePath}`
                    });
                }
            } else {
                const errorMessage = `Clip download failed with exit code: ${code}. Stderr: ${stderrData || 'No stderr output.'} Stdout: ${stdoutData || 'No stdout output.'}`;

                console.error(`Error in downloadClip:`, {
                    channelID,
                    clipUrl: url,
                    exitCode: code,
                    errorMessage,
                    stdout: stdoutData,
                    stderr: stderrData,
                    timestamp: new Date().toISOString()
                });

                resolve({
                    error: true,
                    message: errorMessage
                });
            }
        });

        downloadProcess.on('error', (err) => {
            clearTimeout(timeout);

            console.error(`Error in downloadClip:`, {
                channelID,
                clipUrl: url,
                error: err.message,
                timestamp: new Date().toISOString()
            });

            resolve({
                error: true,
                message: `Clip download failed to start or run: ${err.message}`
            });
        });
    });
}

export async function deleteOldClip(
    channelID: string,
    deleteDir: string
): Promise<void> {
    const filePath = `${deleteDir}/${channelID}-clip.mp4`;

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error(`Error in deleteOldClip:`, {
            channelID,
            filePath,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
    }
}

export async function checkIfClipExists(
    channelID: string,
    downloadDir: string
): Promise<boolean> {
    const filePath = `${downloadDir}/${channelID}-clip.mp4`;
    return fs.existsSync(filePath);
}
