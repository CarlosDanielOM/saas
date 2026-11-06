/** Wait for the actual displayed pictures and videos, including async signed-URL resolution.
 * A separate preloaded <img> is insufficient for no-store URLs or newly mounted variants.
 * Pictures must be loaded and decoded; videos must have their first frame (HAVE_CURRENT_DATA).
 * Resolves once every item is ready (true) or some have failed (false), or at `timeoutMs`.
 * A failed item never ends the wait for healthy ones; a removed root no longer counts.
 */
export function waitForOverlayMedia(root: HTMLElement, signal: AbortSignal, timeoutMs = 8000): Promise<boolean> {
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
    const snapshot = () => [...root.querySelectorAll<HTMLElement>('[data-overlay-image],[data-overlay-video]')].map(layer => {
      // A layer that reported failure may have replaced its element with a message.
      const marked = !!layer.hasAttribute?.('data-overlay-failed');
      if (layer.hasAttribute?.('data-overlay-video')) {
        const video = layer.querySelector('video'), failed = marked || !!video?.error;
        return { element: video as Element | null, img: null, failed, ready: !failed && !!video && !video.seeking && video.readyState >= 2 /* HAVE_CURRENT_DATA */ };
      }
      const img = layer.querySelector('img');
      const failed = marked || !!img && img.complete && !!img.currentSrc && !img.naturalWidth;
      return { element: img as Element | null, img, failed, ready: !failed && !!img?.complete && !!img.naturalWidth };
    });
    const inspect = async () => {
      if (finished) return;
      if (root.isConnected === false) { finish(true); return; }
      const states = snapshot();
      if (states.every(state => state.failed || state.ready)) {
        const decoded = await Promise.allSettled(states.filter(state => state.ready && state.img).map(state => state.img!.decode()));
        if (finished) return;
        // If a variant, element or its readiness changed while decoding (a video seeking), wait again.
        const current = snapshot();
        if (current.length === states.length && current.every((state, i) => state.element === states[i].element && state.failed === states[i].failed && state.ready === states[i].ready)) {
          finish(states.every(state => state.ready) && decoded.every(result => result.status === 'fulfilled')); return;
        }
      }
      if (!finished) poll = setTimeout(() => void inspect(), 25);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else void inspect();
  });
}
