/** Wait for the actual displayed images, including async signed-URL resolution.
 * A separate preloaded <img> is insufficient for no-store URLs or newly mounted variants.
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
    const inspect = async () => {
      if (finished) return;
      const layers = [...root.querySelectorAll<HTMLElement>('[data-overlay-image]')];
      const images = layers.map(layer => layer.querySelector('img'));
      if (images.some(img => img?.complete && img.currentSrc && !img.naturalWidth)) { finish(false); return; }
      if (images.every(img => img?.complete && img.naturalWidth)) {
        try {
          await Promise.all(images.map(img => img!.decode()));
          if (finished) return;
          // If a variant or image changed while decoding, wait for its new DOM too.
          const current = [...root.querySelectorAll<HTMLElement>('[data-overlay-image]')].map(layer => layer.querySelector('img'));
          if (current.length === images.length && current.every((img, i) => img === images[i] && img?.complete && img.naturalWidth)) {
            finish(true); return;
          }
        } catch { finish(false); return; }
      }
      if (!finished) poll = setTimeout(() => void inspect(), 25);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else void inspect();
  });
}
