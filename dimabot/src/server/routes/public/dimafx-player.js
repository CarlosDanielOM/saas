/* DimaFX player: stable receipts preserve the actual outcome across reconnects. */
(() => {
  const channelID = window.location.pathname.split('/')[3];
  const storageKey = `dimafx-playback:${channelID}`;
  const active = new Map();
  let completed;
  try { completed = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { completed = {}; }
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) completed = {};
  const socket = io(`/overlays/dimafx/${channelID}`, {
    auth: { token: new URLSearchParams(window.location.search).get('token') },
    reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000,
  });
  const acknowledge = (triggerID, status = 'completed') => socket.emit('dimafx-ended', { triggerID, status });
  socket.on('connect', () => { socket.emit('dimafx-ready', { captions: true }); });
  socket.on('dimafx-stop', data => active.get(data?.triggerID)?.(data?.reason === 'removed_by_broadcaster' ? 'skipped' : 'failed'));
  socket.on('dimafx-play', data => {
    const { triggerID, url, mediaType, volume, durationMs, timeoutMs } = data || {};
    if (typeof triggerID !== 'string' || typeof url !== 'string' || typeof mediaType !== 'string') return;
    if (completed[triggerID]) { acknowledge(triggerID, completed[triggerID].status || 'completed'); return; }
    if (active.has(triggerID)) return;
    const type = mediaType.split('/')[0];
    if (!['audio', 'video', 'image'].includes(type)) { acknowledge(triggerID, 'failed'); return; }
    const media = document.createElement(type === 'image' ? 'img' : type);
    let caption;
    if (data.viewer) {
      if (typeof data.viewer.name !== 'string' || !data.viewer.name.trim() || typeof data.viewer.text !== 'string') { acknowledge(triggerID, 'failed'); return; }
      caption = document.createElement('div');
      caption.textContent = `${data.viewer.name}: “${data.viewer.text}”`;
      caption.setAttribute('role', 'status');
      Object.assign(caption.style, { position: 'fixed', bottom: '5%', left: '50%', transform: 'translateX(-50%)', maxWidth: '90vw', padding: '12px 20px', borderRadius: '8px', background: 'rgba(0,0,0,.9)', color: '#fff', font: '600 24px/1.4 system-ui,sans-serif', textAlign: 'center', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', zIndex: '9999' });
      document.getElementById('dimafx-player').appendChild(caption);
    }
    let finished = false, timer, watchdog;
    const done = (status = 'completed') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(watchdog);
      // Stop actual audio/video before acknowledging and allowing another job.
      if (type !== 'image') media.pause();
      media.removeAttribute('src');
      if (type !== 'image') media.load();
      media.remove(); caption?.remove(); active.delete(triggerID);
      completed[triggerID] = { at: Date.now(), status };
      for (const [id, receipt] of Object.entries(completed)) if ((receipt.at || receipt) < Date.now() - 7 * 86400000) delete completed[id];
      try { localStorage.setItem(storageKey, JSON.stringify(completed)); } catch { /* In-memory dedup still survives a socket reconnect. */ }
      acknowledge(triggerID, status);
    };
    active.set(triggerID, done);
    media.addEventListener('error', () => done('failed'), { once: true });
    watchdog = setTimeout(() => done('failed'), Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, timeoutMs - 100) : 120000);
    if (type === 'image') {
      media.addEventListener('load', () => { timer = setTimeout(() => done(), Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 5000); }, { once: true });
    } else {
      media.autoplay = true; media.playsInline = true;
      media.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1;
      media.addEventListener('ended', () => done(), { once: true });
    }
    media.src = url;
    document.getElementById('dimafx-player').appendChild(media);
    if (type !== 'image') media.play().catch(() => done('failed'));
  });
})();
