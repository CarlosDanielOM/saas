export function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  // The caller may abandon this promise when the deadline wins. Observe it so a
  // later rejection is not reported as unhandled.
  promise.then(
    () => {},
    () => {},
  );

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export async function readAudioStream(
  audio: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) {
    await audio.cancel(signal.reason).catch(() => {});
    throw new Error("Fish Audio TTS timed out");
  }

  const reader = audio.getReader();
  let finished = false;

  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await readNextChunk(reader, signal);
      if (done) {
        finished = true;
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }

    return Buffer.concat(chunks);
  } finally {
    try {
      if (finished) {
        reader.releaseLock();
      } else {
        await reader.cancel(signal.reason);
      }
    } catch {
      // The reader is already cancelled when the deadline aborts the stream.
    }
  }
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const pending = reader.read();
  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => {});
    throw new Error("Fish Audio TTS timed out");
  }

  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => {});
      reject(new Error("Fish Audio TTS timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
