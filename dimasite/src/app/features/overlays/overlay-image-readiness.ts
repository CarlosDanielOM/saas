/** Wait for the actual displayed images, including async signed-URL resolution.
 * A separate preloaded <img> is insufficient for no-store URLs or newly mounted variants.
 * Resolves once every picture is decoded (true) or some have failed (false), or at `timeoutMs`.
 * A failed picture never ends the wait for healthy ones; a removed root no longer counts.
 */
export function waitForOverlayImages(root: HTMLElement, signal: AbortSignal, timeoutMs = 8000): Promise<boolean> {
  return new Promise(resolve => {
    let finished = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => finish(false), timeoutMs);
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(deadline); clearTimeout(poll);
      signal.removeEventListener('abort', abort); resolve(ready);
    };
    const abort = () => finish(false);
    const snapshot = () => [...root.querySelectorAll<HTMLElement>('[data-overlay-image]')].map(layer => {
      const img = layer.querySelector('img');
      // A layer that reported failure may have replaced its <img> with a message.
      const failed = !!layer.hasAttribute?.('data-overlay-failed') || !!img && img.complete && !!img.currentSrc && !img.naturalWidth;
      return { img, failed, ready: !failed && !!img?.complete && !!img.naturalWidth };
    });
    const inspect = async () => {
      if (finished) return;
      if (root.isConnected === false) { finish(true); return; }
      const states = snapshot();
      if (states.every(state => state.failed || state.ready)) {
        const decoded = await Promise.allSettled(states.filter(state => state.ready).map(state => state.img!.decode()));
        if (finished) return;
        // If a variant or image changed while decoding, wait for its new DOM too.
        const current = snapshot();
        if (current.length === states.length && current.every((state, i) => state.img === states[i].img && state.failed === states[i].failed)) {
          finish(states.every(state => state.ready) && decoded.every(result => result.status === 'fulfilled')); return;
        }
      }
      if (!finished) poll = setTimeout(() => void inspect(), 25);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else void inspect();
  });
}
