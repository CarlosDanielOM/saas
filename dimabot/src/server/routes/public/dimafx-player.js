/* DimaFX's own player. Future global-overlay embedding uses this same protocol. */
(() => {
  const channelID = window.location.pathname.split('/')[3];
  const storageKey = `dimafx-playback:${channelID}`;
  const active = new Map();
  let completed;
  try { completed = JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { completed = {}; }
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) completed = {};
  const socket = io(`/overlays/dimafx/${channelID}`, {
    auth: { token: new URLSearchParams(window.location.search).get('token') },
    reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000,
  });
  const acknowledge = triggerID => socket.emit('dimafx-ended', { triggerID });
  socket.on('connect', () => { socket.emit('dimafx-ready'); });
  socket.on('dimafx-play', data => {
    const { triggerID, url, mediaType, volume } = data || {};
    if (typeof triggerID !== 'string' || typeof url !== 'string' || typeof mediaType !== 'string') return;
    if (completed[triggerID]) { acknowledge(triggerID); return; }
    if (active.has(triggerID)) return;
    const type = mediaType.split('/')[0];
    if (!['audio', 'video', 'image'].includes(type)) return;
    const media = document.createElement(type === 'image' ? 'img' : type);
    active.set(triggerID, media);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      completed[triggerID] = Date.now();
      // The server persists terminal jobs indefinitely. A week of browser
      // receipts additionally covers a crash before it persisted the last ack.
      for (const [id, at] of Object.entries(completed)) if (at < Date.now() - 7 * 86400000) delete completed[id];
      try { localStorage.setItem(storageKey, JSON.stringify(completed)); } catch { /* In-memory dedup still survives a socket reconnect. */ }
      active.delete(triggerID);
      media.remove();
      acknowledge(triggerID);
    };
    media.addEventListener('error', done, { once: true });
    if (type === 'image') {
      media.addEventListener('load', () => setTimeout(done, 5000), { once: true });
    } else {
      media.autoplay = true;
      media.playsInline = true;
      media.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1;
      media.addEventListener('ended', done, { once: true });
    }
    media.src = url;
    document.getElementById('dimafx-player').appendChild(media);
  });
})();
