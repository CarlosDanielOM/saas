// DimaFX viewer storefront runtime, shared by panel.html (Twitch panel) and mobile.html.
let products = [];
let inventory = null;
let identityShared = false;
let authToken = null;
let channelID = null;
let channelName = "";
let currentFilter = "all";
let searchQuery = "";
let selectedItem = null;
let selectedAction = "use_now";
let pendingBitsPurchase = null;
let actionInFlight = false;
let isPlaying = false;
let previewPlayer = null;
let playInterval = null;
let overlayConnected = false;
let overlayChecked = false;
let overlayStatusTimer = null;
let overlayStatusRequest = null;
let loadFailed = false;
let confirmingCreditsFor = null;
let confirmTimer = null;
let drawerReturnFocus = null;
let thumbObserver = null;

const API_BASE = `${window.location.origin}/api/v1`;
const NEW_ITEM_MS = 14 * 24 * 60 * 60 * 1000;
const SEARCH_MIN_ITEMS = 8;
const DEFAULT_CONFIG = { quickPurchasePriority: "credits_first", quickPurchaseAction: "use_now" };

// ---------- i18n (Twitch passes ?language=xx to extension views) ----------

const STRINGS = {
  en: {
    "status.checkingShort": "Checking…",
    "status.checking": "Checking the stream overlay…",
    "status.readyShort": "On stream",
    "status.offlineShort": "Paused",
    "status.ready": "Plays on stream for everyone, instantly.",
    "status.offline": "Purchases are paused: {channel}'s overlay is offline. You won't be charged.",
    "store.title": "Play something on {channel}'s stream",
    "store.titleGeneric": "Play something on stream",
    "store.searchLabel": "Search items",
    "store.search": "Search",
    "store.filters": "Filter by type",
    "store.emptyTitle": "Nothing for sale yet",
    "store.emptyDesc": "The streamer hasn't added any items.",
    "store.noMatchTitle": "No matches",
    "store.noMatchDesc": "Try another word or type.",
    "store.loadFailedTitle": "Couldn't load the store",
    "store.loadFailedDesc": "Check your connection and try again.",
    "store.retry": "Try again",
    "filter.all": "All",
    "type.video": "Video",
    "type.gif": "GIF",
    "type.audio": "Sound",
    "type.tts": "Voice",
    "filter.video": "Videos",
    "filter.gif": "GIFs",
    "filter.audio": "Sounds",
    "filter.tts": "Voice",
    "tile.new": "New",
    "tile.owned": "{count} saved",
    "tile.open": "Preview {name}",
    "tile.offline": "Paused",
    "tile.free": "Play free",
    "tile.saveFree": "Save free",
    "tile.credits": "{price} credits",
    "tile.confirmCredits": "Spend {price}?",
    "tile.yourText": "Type your own message",
    "price.bits": "{price} Bits",
    "price.free": "Free",
    "nav.label": "DimaFX sections",
    "nav.store": "Store",
    "nav.saved": "Saved",
    "nav.settings": "Settings",
    "saved.title": "Your saved items",
    "saved.sub": "Already paid for. Play them on stream whenever you want.",
    "saved.play": "Play",
    "saved.playAria": "Play {name} on stream",
    "saved.count": "{count} saved",
    "saved.emptyTitle": "Nothing saved yet",
    "saved.emptyDesc": "Pick \"Save for later\" when buying to keep an item here.",
    "saved.browse": "Browse the store",
    "share.title": "Share your Twitch ID to unlock more",
    "share.desc": "Save items for later, pay with credits, and get credits back if something can't play.",
    "share.button": "Share Twitch ID",
    "settings.title": "Settings",
    "settings.volume": "Preview volume",
    "settings.volumeNote": "Only for previews in this panel. The stream uses the streamer's volume.",
    "settings.quickTitle": "Buy button on each item",
    "settings.quickPay": "Pay with",
    "settings.creditsFirst": "Credits first",
    "settings.bitsFirst": "Bits only",
    "settings.quickDo": "When you buy",
    "settings.playNow": "Play now",
    "settings.save": "Save for later",
    "settings.quickNeedsId": "Share your Twitch ID to change these.",
    "settings.creditsTitle": "What are credits?",
    "settings.creditsNote": "If something you paid for can't play, you get it back as credits for this channel. Spend them like Bits on any item.",
    "sheet.preview": "Preview",
    "sheet.close": "Close",
    "sheet.ttsLabel": "Your message",
    "sheet.ttsPlaceholder": "Type what the voice will say on stream…",
    "sheet.fixedTts": "Says:",
    "sheet.actionLabel": "What happens",
    "sheet.playNow": "Play now",
    "sheet.save": "Save for later",
    "sheet.buyBits": "Play now · {price} Bits",
    "sheet.saveBits": "Save · {price} Bits",
    "sheet.buyCredits": "Use {price} of your {balance} credits",
    "sheet.playFree": "Play it now · free",
    "sheet.saveFree": "Save it · free",
    "sheet.willPlay": "Plays on {channel}'s stream for everyone as soon as you pay.",
    "sheet.willSave": "Goes to your Saved tab. Play it on stream any time.",
    "sheet.needText": "Type a message above first.",
    "sheet.trust": "If it can't play, you get it back as credits.",
    "sheet.shareForMore": "to save items, use credits and get refunds as credits.",
    "sheet.shareLink": "Share your Twitch ID",
    "sheet.offline": "Paused while {channel}'s overlay is offline. You won't be charged.",
    "toast.preview": "Preview mode",
    "toast.previewDesc": "Open inside Twitch to load the live store.",
    "toast.unavailable": "DimaFX unavailable",
    "toast.loadFailed": "Unable to load the store.",
    "toast.triggered": "On its way!",
    "toast.triggeredDesc": "{name} is queued on stream.",
    "toast.saved": "Saved",
    "toast.savedDesc": "{name} is in your Saved tab.",
    "toast.purchaseIssue": "Purchase issue",
    "toast.bitsUnavailable": "Bits unavailable",
    "toast.bitsOnlyTwitch": "Bits purchases only work inside Twitch.",
    "toast.messageRequired": "Message required",
    "toast.messageRequiredDesc": "Type the message to speak on stream first.",
    "toast.creditsFailed": "Credits payment failed",
    "toast.redeemFailed": "Couldn't play it",
    "toast.previewUnavailable": "No preview",
    "toast.previewTts": "Voice items are spoken on stream, so there's no preview.",
    "toast.previewNone": "This item has no preview.",
    "toast.previewBlocked": "Preview blocked",
    "toast.previewBlockedDesc": "Tap again or allow audio for this page.",
    "toast.credits": "Your credits",
    "toast.creditsDesc": "{balance} credits to spend on this channel.",
    "toast.prefsSaved": "Saved",
    "toast.prefsSavedDesc": "Your buy button was updated.",
    "toast.saveFailed": "Couldn't save",
    "toast.identity": "Twitch ID needed",
    "toast.identityDesc": "Share your Twitch ID to change this.",
    "error.offline": "Purchases are paused while the overlay is offline.",
  },
  es: {
    "status.checkingShort": "Comprobando…",
    "status.checking": "Comprobando el overlay del stream…",
    "status.readyShort": "En el stream",
    "status.offlineShort": "En pausa",
    "status.ready": "Se reproduce en el stream para todos, al instante.",
    "status.offline": "Compras en pausa: el overlay de {channel} está desconectado. No se te cobrará.",
    "store.title": "Haz que pase algo en el stream de {channel}",
    "store.titleGeneric": "Haz que pase algo en el stream",
    "store.searchLabel": "Buscar artículos",
    "store.search": "Buscar",
    "store.filters": "Filtrar por tipo",
    "store.emptyTitle": "Aún no hay nada a la venta",
    "store.emptyDesc": "El streamer todavía no ha añadido artículos.",
    "store.noMatchTitle": "Sin resultados",
    "store.noMatchDesc": "Prueba otra palabra u otro tipo.",
    "store.loadFailedTitle": "No se pudo cargar la tienda",
    "store.loadFailedDesc": "Revisa tu conexión e inténtalo de nuevo.",
    "store.retry": "Reintentar",
    "filter.all": "Todo",
    "type.video": "Vídeo",
    "type.gif": "GIF",
    "type.audio": "Sonido",
    "type.tts": "Voz",
    "filter.video": "Vídeos",
    "filter.gif": "GIFs",
    "filter.audio": "Sonidos",
    "filter.tts": "Voz",
    "tile.new": "Nuevo",
    "tile.owned": "{count} guardado(s)",
    "tile.open": "Ver {name}",
    "tile.offline": "En pausa",
    "tile.free": "Gratis",
    "tile.saveFree": "Guardar gratis",
    "tile.credits": "{price} créditos",
    "tile.confirmCredits": "¿Gastar {price}?",
    "tile.yourText": "Escribe tu propio mensaje",
    "price.bits": "{price} Bits",
    "price.free": "Gratis",
    "nav.label": "Secciones de DimaFX",
    "nav.store": "Tienda",
    "nav.saved": "Guardados",
    "nav.settings": "Ajustes",
    "saved.title": "Tus artículos guardados",
    "saved.sub": "Ya pagados. Úsalos en el stream cuando quieras.",
    "saved.play": "Usar",
    "saved.playAria": "Usar {name} en el stream",
    "saved.count": "{count} guardado(s)",
    "saved.emptyTitle": "Aún no tienes nada guardado",
    "saved.emptyDesc": "Elige \"Guardar para después\" al comprar para tenerlo aquí.",
    "saved.browse": "Ver la tienda",
    "share.title": "Comparte tu ID de Twitch para desbloquear más",
    "share.desc": "Guarda artículos, paga con créditos y recupera créditos si algo no se puede reproducir.",
    "share.button": "Compartir ID de Twitch",
    "settings.title": "Ajustes",
    "settings.volume": "Volumen de vista previa",
    "settings.volumeNote": "Solo para las vistas previas de este panel. El stream usa el volumen del streamer.",
    "settings.quickTitle": "Botón de compra de cada artículo",
    "settings.quickPay": "Pagar con",
    "settings.creditsFirst": "Créditos primero",
    "settings.bitsFirst": "Solo Bits",
    "settings.quickDo": "Al comprar",
    "settings.playNow": "Usar ahora",
    "settings.save": "Guardar para después",
    "settings.quickNeedsId": "Comparte tu ID de Twitch para cambiar esto.",
    "settings.creditsTitle": "¿Qué son los créditos?",
    "settings.creditsNote": "Si algo que pagaste no se puede reproducir, te lo devolvemos como créditos de este canal. Gástalos como Bits en cualquier artículo.",
    "sheet.preview": "Vista previa",
    "sheet.close": "Cerrar",
    "sheet.ttsLabel": "Tu mensaje",
    "sheet.ttsPlaceholder": "Escribe lo que dirá la voz en el stream…",
    "sheet.fixedTts": "Dice:",
    "sheet.actionLabel": "Qué pasa",
    "sheet.playNow": "Usar ahora",
    "sheet.save": "Guardar para después",
    "sheet.buyBits": "Usar ahora · {price} Bits",
    "sheet.saveBits": "Guardar · {price} Bits",
    "sheet.buyCredits": "Usar {price} de tus {balance} créditos",
    "sheet.playFree": "Usar ahora · gratis",
    "sheet.saveFree": "Guardar · gratis",
    "sheet.willPlay": "Se reproduce en el stream de {channel} para todos en cuanto pagues.",
    "sheet.willSave": "Va a tu pestaña Guardados. Úsalo en el stream cuando quieras.",
    "sheet.needText": "Primero escribe un mensaje arriba.",
    "sheet.trust": "Si no se puede reproducir, lo recuperas como créditos.",
    "sheet.shareForMore": "para guardar artículos, usar créditos y recuperar créditos si algo falla.",
    "sheet.shareLink": "Comparte tu ID de Twitch",
    "sheet.offline": "En pausa mientras el overlay de {channel} está desconectado. No se te cobrará.",
    "toast.preview": "Modo vista previa",
    "toast.previewDesc": "Ábrelo dentro de Twitch para cargar la tienda.",
    "toast.unavailable": "DimaFX no disponible",
    "toast.loadFailed": "No se pudo cargar la tienda.",
    "toast.triggered": "¡En camino!",
    "toast.triggeredDesc": "{name} está en cola en el stream.",
    "toast.saved": "Guardado",
    "toast.savedDesc": "{name} está en tu pestaña Guardados.",
    "toast.purchaseIssue": "Problema con la compra",
    "toast.bitsUnavailable": "Bits no disponibles",
    "toast.bitsOnlyTwitch": "Las compras con Bits solo funcionan dentro de Twitch.",
    "toast.messageRequired": "Falta el mensaje",
    "toast.messageRequiredDesc": "Escribe primero el mensaje que se dirá en el stream.",
    "toast.creditsFailed": "Falló el pago con créditos",
    "toast.redeemFailed": "No se pudo reproducir",
    "toast.previewUnavailable": "Sin vista previa",
    "toast.previewTts": "Los artículos de voz se dicen en el stream, así que no hay vista previa.",
    "toast.previewNone": "Este artículo no tiene vista previa.",
    "toast.previewBlocked": "Vista previa bloqueada",
    "toast.previewBlockedDesc": "Toca de nuevo o permite el audio en esta página.",
    "toast.credits": "Tus créditos",
    "toast.creditsDesc": "{balance} créditos para gastar en este canal.",
    "toast.prefsSaved": "Guardado",
    "toast.prefsSavedDesc": "Se actualizó tu botón de compra.",
    "toast.saveFailed": "No se pudo guardar",
    "toast.identity": "Se necesita tu ID de Twitch",
    "toast.identityDesc": "Comparte tu ID de Twitch para cambiar esto.",
    "error.offline": "Las compras están en pausa mientras el overlay está desconectado.",
  },
};

const LANG = (() => {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("language") || params.get("locale") || navigator.language || "en").toLowerCase();
  return raw.startsWith("es") ? "es" : "en";
})();
const LOCALE = LANG === "es" ? "es-ES" : "en-US";

function t(key, vars = {}) {
  const template = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

function channelLabel() {
  return channelName || (LANG === "es" ? "el streamer" : "the streamer");
}

function applyStaticStrings() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
}

// ---------- Helpers ----------

function getEl(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(LOCALE);
}

function formatDuration(ms) {
  if (!ms) return "";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const GEM_SVG = '<svg class="fx-gem" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 9l8 13 8-13-8-7Z"></path></svg>';
const PLAY_SVG = '<svg class="fx-gem" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"></path></svg>';
const SHIELD_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"></path><path d="m9 12 2 2 4-4"></path></svg>';
const TYPE_ICONS = {
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"></rect><path d="m16 10 5-3v10l-5-3"></path></svg>',
  gif: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="9" cy="10" r="1.5"></circle><path d="m21 16-5-5-8 8"></path></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path></svg>',
  tts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"></path></svg>',
};

function getInventoryQuantity(itemId) {
  return (inventory?.items || [])
    .filter((item) => String(item.channelExtensionItemID) === String(itemId) && Number(item.quantity || 0) > 0)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function getBalance() {
  return Number(inventory?.balance || 0);
}

function getConfig() {
  return inventory?.config || DEFAULT_CONFIG;
}

function categoryLabel(category) {
  return ["video", "gif", "audio", "tts"].includes(category) ? t(`type.${category}`) : String(category || "Media");
}

function isFreeItem(item) {
  return Number(item?.priceValue || 0) === 0;
}

function isCustomTtsItem(item) {
  return item?.category === "tts" && item?.tts?.mode === "custom";
}

// Only images and GIFs can stand in as their own thumbnail; an audio URL would render as a broken image.
function mapItem(item) {
  const mediaType = String(item.mediaType || item.asset?.mediaType || "").toLowerCase();
  const visualMedia = mediaType === "image" || mediaType === "gif" || mediaType.startsWith("image/");
  return {
    id: item.id || item._id,
    name: item.name,
    category: item.category || "audio",
    categoryLabel: categoryLabel(item.category),
    duration: formatDuration(item.durationMs),
    priceValue: Number(item.bitsPrice || 0),
    sku: item.sku,
    image: item.thumbnailUrl || (visualMedia ? item.mediaUrl || item.asset?.playbackUrl : "") || "",
    description: item.description || "",
    mediaUrl: item.mediaUrl || item.asset?.playbackUrl,
    mediaType: item.mediaType,
    durationMs: item.durationMs,
    createdAt: item.createdAt ? Date.parse(item.createdAt) : 0,
    channelName: item.channelName || "",
    tts: item.tts
      ? {
          mode: item.tts.mode === "fixed" ? "fixed" : "custom",
          text: item.tts.text || "",
          voice: item.tts.voice || "",
          language: item.tts.language || "en",
        }
      : null,
  };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({ error: true, message: "Invalid API response" }));
  if (!response.ok || payload.error) {
    throw new Error(payload.message || "DimaFX request failed");
  }
  return payload.data;
}

// ---------- Overlay status ----------

async function refreshOverlayStatus() {
  if (!authToken || !channelID) return false;
  if (overlayStatusRequest) return overlayStatusRequest;
  overlayStatusRequest = (async () => {
    let connected = false;
    try {
      const status = await apiFetch(`/channels/${encodeURIComponent(channelID)}/overlay-status`, { cache: "no-store" });
      connected = status?.connected === true;
    } catch { /* Fail closed when connection status cannot be verified. */ }
    const changed = overlayConnected !== connected || !overlayChecked;
    overlayConnected = connected;
    overlayChecked = true;
    if (changed) {
      renderStatus();
      renderLibrary();
      renderInventory();
      renderDrawerActions();
    }
    return connected;
  })();
  try { return await overlayStatusRequest; } finally { overlayStatusRequest = null; }
}

async function requireOverlayConnected() {
  if (!await refreshOverlayStatus()) throw new Error(t("error.offline"));
}

function renderStatus() {
  const chip = getEl("fx-live-chip");
  const chipLabel = getEl("fx-live-label");
  const statusEl = getEl("dimafx-connection-status");
  const state = !overlayChecked ? "checking" : overlayConnected ? "ready" : "offline";
  if (chip) {
    chip.dataset.state = state;
    chip.className = `fx-chip ${state === "ready" ? "fx-chip--ok" : state === "offline" ? "fx-chip--warn" : "fx-chip--muted"}`;
  }
  if (chipLabel) chipLabel.textContent = t(state === "ready" ? "status.readyShort" : state === "offline" ? "status.offlineShort" : "status.checkingShort");
  if (statusEl) {
    statusEl.textContent = state === "ready" ? t("status.ready") : state === "offline" ? t("status.offline", { channel: channelLabel() }) : t("status.checking");
    statusEl.classList.toggle("fx-status--warn", state === "offline");
  }
  document.body.classList.toggle("fx--live", state === "ready");
  const title = getEl("fx-store-title");
  if (title) {
    if (channelName) {
      const [before, after] = t("store.title", { channel: "\u0000" }).split("\u0000");
      title.innerHTML = `${escapeHtml(before)}<span>${escapeHtml(channelName)}</span>${escapeHtml(after)}`;
    } else {
      title.textContent = t("store.titleGeneric");
    }
  }
}

// ---------- Boot ----------

async function initializeDimaFx(auth) {
  authToken = auth.token;
  channelID = auth.channelId;
  if (overlayStatusTimer) clearInterval(overlayStatusTimer);
  overlayStatusTimer = setInterval(() => { void refreshOverlayStatus(); }, 5000);
  void refreshOverlayStatus();
  await loadStore();
}

async function loadStore() {
  toggleShimmer(true);
  getEl("empty-state").hidden = true;
  try {
    const [me, items] = await Promise.all([
      apiFetch("/me"),
      apiFetch(`/channels/${encodeURIComponent(channelID)}/items`),
    ]);
    identityShared = Boolean(me.identityShared);
    inventory = me.inventory || null;
    products = (items || []).map(mapItem);
    channelName = products.find((item) => item.channelName)?.channelName || channelName;
    loadFailed = false;
  } catch (error) {
    loadFailed = products.length === 0;
    showToast(t("toast.unavailable"), error.message || t("toast.loadFailed"), "error");
  } finally {
    toggleShimmer(false);
    renderAll();
  }
}

function renderAll() {
  updateBalanceBadge();
  renderStatus();
  renderFilters();
  renderLibrary();
  renderInventory();
  renderUserConfigControls();
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme !== "light");
}

applyStaticStrings();
applyTheme(new URLSearchParams(window.location.search).get("theme") || "dark");

if (window.Twitch) {
  Twitch.ext.actions.requestIdShare();
  Twitch.ext.onAuthorized((auth) => initializeDimaFx(auth));
  Twitch.ext.onContext?.((context, changed) => {
    if (!changed || changed.includes("theme")) applyTheme(context?.theme);
  });
  if (Twitch.ext.bits?.onTransactionComplete) {
    Twitch.ext.bits.onTransactionComplete((transaction) => {
      if (!pendingBitsPurchase) return;
      const pending = pendingBitsPurchase;
      pendingBitsPurchase = null;
      completeBitsPurchase(pending.item, pending.action, transaction, pending.ttsText);
    });
  }
  if (Twitch.ext.bits?.onTransactionCancelled) {
    Twitch.ext.bits.onTransactionCancelled(() => {
      pendingBitsPurchase = null;
      endAction();
    });
  }
} else {
  window.addEventListener("DOMContentLoaded", () => {
    showToast(t("toast.preview"), t("toast.previewDesc"), "info");
    toggleShimmer(false);
    renderAll();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && getEl("preview-drawer")?.classList.contains("open")) closeDrawer();
});

function switchTab(screenId, tabButton) {
  document.querySelectorAll(".app-screen").forEach((scr) => scr.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((tb) => {
    tb.classList.remove("active");
    tb.removeAttribute("aria-current");
  });
  getEl("screen-" + screenId)?.classList.add("active");
  const button = tabButton || document.querySelector(`.nav-tab[onclick*="'${screenId}'"]`);
  button?.classList.add("active");
  button?.setAttribute("aria-current", "page");
  document.querySelector(".fx-view")?.scrollTo(0, 0);
  closeDrawer();
}

// ---------- Store ----------

function renderFilters() {
  const container = getEl("fx-filters");
  if (!container) return;
  const counts = products.reduce((acc, item) => ({ ...acc, [item.category]: (acc[item.category] || 0) + 1 }), {});
  const kinds = ["video", "gif", "audio", "tts"].filter((kind) => counts[kind]);
  if (!kinds.includes(currentFilter)) currentFilter = "all";
  // A single type needs no filter row.
  if (kinds.length < 2) {
    container.innerHTML = "";
  } else {
    const chip = (kind, label, count) =>
      `<button type="button" class="fx-filter" aria-pressed="${currentFilter === kind}" onclick="filterCategory('${kind}', this)">${escapeHtml(label)} <small>${count}</small></button>`;
    container.innerHTML = chip("all", t("filter.all"), products.length) + kinds.map((kind) => chip(kind, t(`filter.${kind}`), counts[kind])).join("");
  }
  const search = getEl("fx-search");
  if (search) search.hidden = products.length <= SEARCH_MIN_ITEMS;
}

function thumbHtml(item, { compact = false } = {}) {
  const kind = getPreviewKind(item);
  if (kind === "tts") {
    const text = item.tts?.mode === "fixed" && item.tts.text ? item.tts.text : t("tile.yourText");
    return `<div class="fx-thumb fx-thumb--tts">${compact ? TYPE_ICONS.tts : `<span class="fx-quote">${escapeHtml(text)}</span>`}</div>`;
  }
  if (kind === "video" && item.mediaUrl) {
    // Poster when the server made one; otherwise the first frame loads once the tile nears the viewport.
    const poster = item.image ? ` poster="${escapeHtml(item.image)}"` : "";
    return `<div class="fx-thumb"><video muted playsinline loop preload="none"${poster} data-src="${escapeHtml(item.mediaUrl)}" aria-hidden="true"></video></div>`;
  }
  if (item.image) {
    return `<div class="fx-thumb"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" /></div>`;
  }
  return `<div class="fx-thumb fx-thumb--audio">${compact ? TYPE_ICONS.audio : '<span class="fx-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>'}</div>`;
}

function quickPlan(item) {
  const config = getConfig();
  const action = config.quickPurchaseAction === "save" && identityShared && !isCustomTtsItem(item) ? "save" : "use_now";
  if (isFreeItem(item)) return { pay: "free", action };
  if (identityShared && config.quickPurchasePriority === "credits_first" && getBalance() >= item.priceValue) return { pay: "credits", action };
  return { pay: "bits", action };
}

function quickActionLabel(item) {
  if (!overlayConnected) return escapeHtml(t("tile.offline"));
  const plan = quickPlan(item);
  const price = formatNumber(item.priceValue);
  if (confirmingCreditsFor === String(item.id)) return escapeHtml(t("tile.confirmCredits", { price }));
  if (plan.pay === "free") return `${PLAY_SVG}${escapeHtml(t(plan.action === "save" ? "tile.saveFree" : "tile.free"))}`;
  if (plan.pay === "credits") return `${PLAY_SVG}${escapeHtml(t("tile.credits", { price }))}`;
  return `${GEM_SVG}${escapeHtml(price)}`;
}

function quickActionClass(item) {
  if (confirmingCreditsFor === String(item.id)) return "confirm";
  return quickPlan(item).pay;
}

function quickActionAria(item) {
  const plan = quickPlan(item);
  const price = plan.pay === "free" ? t("price.free") : plan.pay === "credits" ? t("tile.credits", { price: formatNumber(item.priceValue) }) : t("price.bits", { price: formatNumber(item.priceValue) });
  const verb = plan.action === "save" ? t("sheet.save") : t("sheet.playNow");
  return `${verb}: ${item.name} · ${price}`;
}

function renderLibrary() {
  const grid = getEl("media-grid");
  const emptyState = getEl("empty-state");
  if (!grid) return;
  const query = searchQuery.trim().toLowerCase();
  const filtered = products.filter((item) => {
    const matchesCategory = currentFilter === "all" || item.category === currentFilter;
    const matchesSearch = !query || item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  if (emptyState) {
    emptyState.hidden = filtered.length > 0 || getEl("skeleton-loader")?.classList.contains("active");
    const failed = loadFailed && products.length === 0;
    getEl("fx-empty-title").textContent = t(failed ? "store.loadFailedTitle" : products.length ? "store.noMatchTitle" : "store.emptyTitle");
    getEl("fx-empty-desc").textContent = t(failed ? "store.loadFailedDesc" : products.length ? "store.noMatchDesc" : "store.emptyDesc");
    emptyState.querySelector(".fx-btn")?.remove();
    if (failed && authToken) {
      emptyState.insertAdjacentHTML("beforeend", `<button type="button" class="fx-btn fx-btn--primary fx-btn--sm" onclick="loadStore()">${escapeHtml(t("store.retry"))}</button>`);
    }
  }

  const now = Date.now();
  grid.innerHTML = filtered.map((item) => {
    const owned = identityShared ? getInventoryQuantity(item.id) : 0;
    const isNew = item.createdAt && now - item.createdAt < NEW_ITEM_MS;
    const id = escapeHtml(item.id);
    const tags = [
      `<span class="fx-tag fx-tag--type">${TYPE_ICONS[getPreviewKind(item)] || ""}${escapeHtml(item.categoryLabel)}</span>`,
      isNew ? `<span class="fx-tag fx-tag--new">${escapeHtml(t("tile.new"))}</span>` : "",
      owned ? `<span class="fx-tag fx-tag--owned">${escapeHtml(t("tile.owned", { count: owned }))}</span>` : !isFreeItem(item) && item.duration ? `<span class="fx-tag fx-tag--time">${escapeHtml(item.duration)}</span>` : "",
    ].join("");
    return `
      <article class="fx-tile media-card" data-id="${id}">
        <button type="button" class="fx-tile__open" onclick="openDrawerById('${id}', this)" aria-label="${escapeHtml(t("tile.open", { name: item.name }))}">
          ${thumbHtml(item).replace("</div>", `${tags}</div>`)}
          <span class="fx-tile__name card-title">${escapeHtml(item.name)}</span>
        </button>
        <div class="fx-tile__buy">
          <button type="button" class="fx-price price-btn ${quickActionClass(item)}" ${overlayConnected ? "" : "disabled"} aria-label="${escapeHtml(quickActionAria(item))}" onclick="quickPurchase('${id}')">${quickActionLabel(item)}</button>
        </div>
      </article>`;
  }).join("");
  observeThumbs(grid);
}

function loadVideoFrame(video) {
  if (video.getAttribute("src")) return;
  video.src = video.poster ? video.dataset.src : `${video.dataset.src}#t=0.1`;
  video.preload = "metadata";
}

function observeThumbs(root) {
  const videos = root.querySelectorAll("video[data-src]");
  if (!videos.length) return;
  thumbObserver?.disconnect();
  if (!("IntersectionObserver" in window)) {
    videos.forEach(loadVideoFrame);
  } else {
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadVideoFrame(entry.target);
        thumbObserver.unobserve(entry.target);
      });
    }, { rootMargin: "120px" });
    videos.forEach((video) => thumbObserver.observe(video));
  }
  // Muted motion preview on mouse hover; touch users get the full preview in the sheet.
  videos.forEach((video) => {
    const tile = video.closest(".fx-tile");
    tile?.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      loadVideoFrame(video);
      video.play().catch(() => undefined);
    });
    tile?.addEventListener("pointerleave", () => {
      video.pause();
      try { video.currentTime = video.poster ? 0 : 0.1; } catch { /* not loaded yet */ }
    });
  });
}

function filterCategory(category, buttonElement) {
  currentFilter = category;
  document.querySelectorAll(".fx-filter").forEach((btn) => btn.setAttribute("aria-pressed", String(btn === buttonElement)));
  renderLibrary();
}

function handleSearch(query) {
  searchQuery = query;
  renderLibrary();
}

function toggleShimmer(forceState = null) {
  const loader = getEl("skeleton-loader");
  if (!loader) return;
  const activate = forceState !== null ? forceState : !loader.classList.contains("active");
  loader.classList.toggle("active", activate);
}

// ---------- Saved items ----------

function requestIdShare() {
  window.Twitch?.ext?.actions?.requestIdShare?.();
}

function renderInventory() {
  const list = getEl("inventory-list");
  const badge = getEl("fx-saved-count");
  if (!list) return;

  const savedItems = identityShared ? products.filter((item) => getInventoryQuantity(item.id) > 0) : [];
  const savedTotal = savedItems.reduce((total, item) => total + getInventoryQuantity(item.id), 0);
  if (badge) {
    badge.hidden = savedTotal === 0;
    badge.textContent = savedTotal > 99 ? "99+" : String(savedTotal);
  }

  if (!identityShared) {
    list.innerHTML = `
      <div class="fx-card fx-card--cta">
        <div class="fx-label">${escapeHtml(t("share.title"))}</div>
        <p class="fx-note" style="margin:0">${escapeHtml(t("share.desc"))}</p>
        <button type="button" class="fx-btn fx-btn--primary fx-btn--sm" onclick="requestIdShare()">${escapeHtml(t("share.button"))}</button>
      </div>`;
    return;
  }
  if (savedItems.length === 0) {
    list.innerHTML = `
      <div class="fx-empty">
        <div class="fx-empty__title">${escapeHtml(t("saved.emptyTitle"))}</div>
        <div class="fx-empty__desc">${escapeHtml(t("saved.emptyDesc"))}</div>
        <button type="button" class="fx-btn fx-btn--sm" onclick="switchTab('store')">${escapeHtml(t("saved.browse"))}</button>
      </div>`;
    return;
  }

  list.innerHTML = savedItems.map((item) => `
    <div class="fx-row inventory-card">
      ${thumbHtml(item, { compact: true })}
      <div style="min-width:0">
        <div class="fx-row__name">${escapeHtml(item.name)}</div>
        <div class="fx-row__meta">${escapeHtml(item.categoryLabel)} · ${escapeHtml(t("saved.count", { count: getInventoryQuantity(item.id) }))}</div>
      </div>
      <button type="button" class="fx-btn fx-btn--primary fx-btn--sm btn-use-item" ${overlayConnected ? "" : "disabled"} aria-label="${escapeHtml(t("saved.playAria", { name: item.name }))}" onclick="redeemSaved('${escapeHtml(item.id)}')">${PLAY_SVG}${escapeHtml(t("saved.play"))}</button>
    </div>`).join("");
  list.querySelectorAll("video[data-src]").forEach(loadVideoFrame);
}

// ---------- Detail sheet ----------

function getTtsInputText() {
  return (getEl("tts-text-input")?.value || "").trim();
}

function onTtsTextInput() {
  const input = getEl("tts-text-input");
  const counter = getEl("tts-char-count");
  if (input && counter) {
    counter.textContent = `${input.value.length} / ${input.maxLength || 280}`;
  }
  renderDrawerActions();
}

function syncTtsInput() {
  const wrap = getEl("tts-input-wrap");
  if (!wrap) return;
  const show = isCustomTtsItem(selectedItem);
  wrap.hidden = !show;
  if (show) {
    const input = getEl("tts-text-input");
    if (input) input.value = "";
    onTtsTextInput();
  }
}

function openDrawerById(itemId, trigger) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (item) openDrawer(item, trigger);
}

function openDrawer(item, trigger = document.activeElement) {
  selectedItem = item;
  drawerReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  // Custom-text TTS items cannot be saved: the text only exists at purchase time.
  const wantsSave = getConfig().quickPurchaseAction === "save" && identityShared;
  selectedAction = wantsSave && !isCustomTtsItem(item) ? "save" : "use_now";
  resetPlayer();
  syncDrawerPreview();
  getEl("drawer-title").textContent = item.name;
  const meta = [
    `<span class="fx-chip fx-chip--accent">${TYPE_ICONS[getPreviewKind(item)] || ""}${escapeHtml(item.categoryLabel)}</span>`,
    isFreeItem(item)
      ? `<span class="fx-chip fx-chip--ok">${escapeHtml(t("price.free"))}</span>`
      : `<span class="fx-chip fx-chip--gold">${GEM_SVG}${escapeHtml(t("price.bits", { price: formatNumber(item.priceValue) }))}</span>`,
  ];
  const owned = identityShared ? getInventoryQuantity(item.id) : 0;
  if (owned) meta.push(`<span class="fx-chip fx-chip--muted">${escapeHtml(t("tile.owned", { count: owned }))}</span>`);
  getEl("drawer-subtitle").innerHTML = meta.join("");
  const descEl = getEl("drawer-desc");
  if (descEl) {
    const fixed = item.category === "tts" && item.tts?.mode === "fixed" && item.tts.text;
    descEl.innerHTML = `${escapeHtml(item.description)}${fixed ? `<q>${escapeHtml(t("sheet.fixedTts"))} “${escapeHtml(item.tts.text)}”</q>` : ""}`;
    descEl.hidden = !item.description && !fixed;
  }
  syncTtsInput();
  renderDrawerActions();
  const drawer = getEl("preview-drawer");
  drawer.hidden = false;
  // Force layout so the slide-in transition runs after un-hiding.
  void drawer.offsetHeight;
  drawer.classList.add("open");
  getEl("drawer-backdrop")?.classList.add("open");
  drawer.querySelector(".fx-sheet__close")?.focus({ preventScroll: true });
}

function renderDrawerActions() {
  const actionContainer = document.querySelector(".drawer-actions");
  if (!actionContainer || !selectedItem) return;
  const item = selectedItem;
  const isFree = isFreeItem(item);
  const customTts = isCustomTtsItem(item);
  const ttsMissing = customTts && !getTtsInputText();
  // Custom-text TTS items must be used immediately — the viewer's text only exists in this purchase request.
  const saveDisabled = !identityShared || customTts;
  const price = formatNumber(item.priceValue);
  const balance = getBalance();
  const saving = selectedAction === "save";
  const html = [];

  if (!customTts) {
    html.push(`
      <div class="fx-seg" role="radiogroup" aria-label="${escapeHtml(t("sheet.actionLabel"))}">
        <label><input type="radio" name="fx-action" value="use_now" ${saving ? "" : "checked"} onchange="setDrawerAction('use_now')" /><span>${escapeHtml(t("sheet.playNow"))}</span></label>
        <label><input type="radio" name="fx-action" value="save" ${saving ? "checked" : ""} ${saveDisabled ? "disabled" : ""} onchange="setDrawerAction('save')" /><span>${escapeHtml(t("sheet.save"))}</span></label>
      </div>`);
  }

  if (isFree) {
    const disabled = (saving && saveDisabled) || ttsMissing || !overlayConnected;
    html.push(`<button type="button" class="drawer-buy-btn free sheet-btn-buy" ${disabled ? "disabled" : ""} onclick="triggerFreeItem(selectedItem, selectedAction)">${PLAY_SVG}<span>${escapeHtml(t(saving ? "sheet.saveFree" : "sheet.playFree"))}</span></button>`);
  } else {
    const bitsDisabled = ttsMissing || !overlayConnected;
    html.push(`<button type="button" class="drawer-buy-btn bits sheet-btn-buy" ${bitsDisabled ? "disabled" : ""} onclick="buyWithBits(selectedItem, selectedAction)">${GEM_SVG}<span>${escapeHtml(t(saving ? "sheet.saveBits" : "sheet.buyBits", { price }))}</span></button>`);
    if (identityShared && balance >= item.priceValue) {
      const creditsOk = overlayConnected && !ttsMissing;
      html.push(`<button type="button" class="drawer-buy-btn credits sheet-btn-buy" ${creditsOk ? "" : "disabled"} onclick="buyWithCredits(selectedItem, selectedAction)"><span>${escapeHtml(t("sheet.buyCredits", { price, balance: formatNumber(balance) }))}</span></button>`);
    }
  }

  if (!overlayConnected && overlayChecked) {
    html.push(`<p class="fx-hint fx-hint--warn">${escapeHtml(t("sheet.offline", { channel: channelLabel() }))}</p>`);
  } else if (ttsMissing) {
    html.push(`<p class="fx-hint">${escapeHtml(t("sheet.needText"))}</p>`);
  } else {
    html.push(`<p class="fx-hint">${escapeHtml(saving ? t("sheet.willSave") : t("sheet.willPlay", { channel: channelLabel() }))}</p>`);
  }

  if (identityShared) {
    if (!isFree) html.push(`<p class="fx-trust">${SHIELD_SVG}<span>${escapeHtml(t("sheet.trust"))}</span></p>`);
  } else {
    html.push(`<p class="fx-trust">${SHIELD_SVG}<span><button type="button" class="fx-link" onclick="requestIdShare()">${escapeHtml(t("sheet.shareLink"))}</button> ${escapeHtml(t("sheet.shareForMore"))}</span></p>`);
  }

  actionContainer.innerHTML = html.join("");
}

function setDrawerAction(action) {
  selectedAction = action === "save" && identityShared && !isCustomTtsItem(selectedItem) ? "save" : "use_now";
  renderDrawerActions();
}

function closeDrawer() {
  const drawer = getEl("preview-drawer");
  const wasOpen = drawer?.classList.contains("open");
  drawer?.classList.remove("open");
  getEl("drawer-backdrop")?.classList.remove("open");
  const ttsWrap = getEl("tts-input-wrap");
  if (ttsWrap) ttsWrap.hidden = true;
  resetPlayer();
  if (wasOpen) {
    setTimeout(() => { if (!drawer.classList.contains("open")) drawer.hidden = true; }, 260);
    if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus({ preventScroll: true });
  }
  drawerReturnFocus = null;
}

// ---------- Preview player ----------

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity || !seconds) return "0:00";
  const floored = Math.max(0, Math.floor(seconds));
  return `${Math.floor(floored / 60)}:${String(floored % 60).padStart(2, "0")}`;
}

function updatePlayerTime() {
  const timeEl = getEl("player-time");
  if (!timeEl) return;
  let duration = 0;
  if (previewPlayer && Number.isFinite(previewPlayer.duration) && previewPlayer.duration > 0) {
    duration = previewPlayer.duration;
  } else if (selectedItem?.durationMs) {
    duration = selectedItem.durationMs / 1000;
  }
  timeEl.hidden = !duration;
  timeEl.textContent = isPlaying && previewPlayer
    ? `${formatTime(previewPlayer.currentTime)} / ${formatTime(duration)}`
    : formatTime(duration);
}

function getPreviewVolume() {
  const raw = Number(getEl("preview-volume")?.value);
  if (!Number.isFinite(raw)) return 0.6;
  return Math.min(1, Math.max(0, raw / 100));
}

function onPreviewVolumeInput(slider) {
  const label = getEl("val-volume");
  if (label) label.textContent = `${slider.value}%`;
  slider.style.setProperty("--pct", String(slider.value / 100));
  if (previewPlayer) previewPlayer.volume = getPreviewVolume();
}

function setActionInFlight(next) {
  actionInFlight = next;
  document.body.classList.toggle("dimafx-busy", next);
}

function beginAction() {
  if (actionInFlight) return false;
  setActionInFlight(true);
  return true;
}

function endAction() {
  setActionInFlight(false);
}

function getPreviewKind(item) {
  const category = String(item?.category || "").toLowerCase();
  const mediaType = String(item?.mediaType || "").toLowerCase();
  if (category === "tts") return "tts";
  if (category === "video" || mediaType.startsWith("video")) return "video";
  if (category === "gif" || mediaType === "gif" || mediaType.startsWith("image")) return "gif";
  return "audio";
}

function getPreviewWidget() {
  return getEl("player-widget");
}

function syncDrawerPreview() {
  const widget = getPreviewWidget();
  if (!widget || !selectedItem) return;
  const kind = getPreviewKind(selectedItem);
  widget.dataset.previewKind = kind;
  const visual = widget.querySelector(".preview-visual");
  visual.innerHTML = "";
  visual.hidden = kind === "audio" || kind === "tts";
  if (kind === "video" && selectedItem.mediaUrl) {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.src = selectedItem.image ? selectedItem.mediaUrl : `${selectedItem.mediaUrl}#t=0.1`;
    if (selectedItem.image) video.poster = selectedItem.image;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    visual.appendChild(video);
  } else if (kind === "gif") {
    const src = selectedItem.mediaUrl || selectedItem.image;
    if (src) {
      const img = document.createElement("img");
      img.className = "preview-gif";
      img.src = src;
      img.alt = "";
      visual.appendChild(img);
    }
  }
  const quote = getEl("fx-stage-quote");
  if (quote) quote.textContent = kind === "tts" ? (selectedItem.tts?.mode === "fixed" && selectedItem.tts.text ? selectedItem.tts.text : t("tile.yourText")) : "";
  const play = getEl("player-play");
  if (play) play.hidden = kind === "tts" || kind === "gif" || !selectedItem.mediaUrl;
  updatePlayerTime();
}

function startPreviewTicker() {
  clearInterval(playInterval);
  playInterval = setInterval(() => {
    document.querySelectorAll(".wave-bar").forEach((bar) => {
      bar.style.height = Math.floor(Math.random() * 80 + 20) + "%";
    });
    updatePlayerTime();
  }, 140);
}

function togglePlayPreview() {
  if (!selectedItem) return;
  const kind = getPreviewKind(selectedItem);
  if (kind === "gif") return;
  if (isPlaying) return resetPlayer();
  if (kind === "video") {
    const video = getPreviewWidget()?.querySelector(".preview-video");
    if (!video?.src) return;
    previewPlayer = video;
  } else {
    if (!selectedItem.mediaUrl) {
      showToast(t("toast.previewUnavailable"), kind === "tts" ? t("toast.previewTts") : t("toast.previewNone"), "info");
      return;
    }
    previewPlayer = new Audio(selectedItem.mediaUrl);
  }
  previewPlayer.volume = getPreviewVolume();
  previewPlayer.onloadedmetadata = updatePlayerTime;
  previewPlayer.ontimeupdate = updatePlayerTime;
  previewPlayer.onended = resetPlayer;
  previewPlayer.play().catch(() => showToast(t("toast.previewBlocked"), t("toast.previewBlockedDesc"), "error"));
  isPlaying = true;
  getPreviewWidget()?.classList.add("playing");
  if (kind === "audio") startPreviewTicker();
  else playInterval = setInterval(updatePlayerTime, 250);
}

function resetPlayer() {
  if (previewPlayer) {
    previewPlayer.pause();
    try {
      previewPlayer.currentTime = 0;
    } catch {
      // Replaced media nodes can throw here.
    }
    if (!(previewPlayer instanceof HTMLVideoElement)) {
      previewPlayer = null;
    }
  }
  clearInterval(playInterval);
  isPlaying = false;
  getPreviewWidget()?.classList.remove("playing");
  document.querySelectorAll(".wave-bar").forEach((bar) => (bar.style.height = "20%"));
  updatePlayerTime();
}

// ---------- Purchases ----------

function quickPurchase(itemId) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (!item) return;
  // Custom-text TTS needs the sheet's message input — quick-buy can't collect it.
  if (isCustomTtsItem(item)) {
    openDrawer(item);
    return;
  }
  const plan = quickPlan(item);
  if (plan.pay === "free") {
    // Free items trigger immediately without the Bits/credits flow.
    triggerFreeItem(item, plan.action);
    return;
  }
  if (plan.pay === "credits") {
    // Twitch confirms Bits itself; credits need a second tap so one tap never spends them.
    if (confirmingCreditsFor !== String(item.id)) {
      confirmingCreditsFor = String(item.id);
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmingCreditsFor = null; renderLibrary(); }, 4000);
      renderLibrary();
      document.querySelector(`.fx-tile[data-id="${CSS.escape(String(item.id))}"] .price-btn`)?.focus();
      return;
    }
    confirmingCreditsFor = null;
    clearTimeout(confirmTimer);
    renderLibrary();
    buyWithCredits(item, plan.action);
    return;
  }
  buyWithBits(item, plan.action);
}

function showSuccess(item, action) {
  showToast(
    t(action === "save" ? "toast.saved" : "toast.triggered"),
    t(action === "save" ? "toast.savedDesc" : "toast.triggeredDesc", { name: item.name }),
    "success"
  );
}

async function buyWithBits(item, action) {
  if (!window.Twitch?.ext?.bits?.useBits) {
    showToast(t("toast.bitsUnavailable"), t("toast.bitsOnlyTwitch"), "info");
    return;
  }
  const ttsText = isCustomTtsItem(item) ? getTtsInputText() : undefined;
  if (isCustomTtsItem(item) && !ttsText) {
    showToast(t("toast.messageRequired"), t("toast.messageRequiredDesc"), "info");
    return;
  }
  if (!beginAction()) return;
  try {
    await requireOverlayConnected();
    pendingBitsPurchase = { item, action, ttsText };
    Twitch.ext.bits.useBits(item.sku);
  } catch (error) {
    pendingBitsPurchase = null;
    endAction();
    showToast(t("toast.bitsUnavailable"), error.message, "error");
  }
}

async function triggerFreeItem(item, action = "use_now") {
  // Free items are fulfilled server-side without ever touching the Twitch Bits API,
  // because Twitch rejects 0-cost SKUs in Twitch.ext.bits.useBits.
  const ttsText = isCustomTtsItem(item) ? getTtsInputText() : undefined;
  if (isCustomTtsItem(item) && !ttsText) {
    showToast(t("toast.messageRequired"), t("toast.messageRequiredDesc"), "info");
    return;
  }
  if (!beginAction()) return;
  const safeAction = action === "save" && !isCustomTtsItem(item) ? "save" : "use_now";
  const transactionID = `free_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await requireOverlayConnected();
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/purchase`, {
      method: "POST",
      body: JSON.stringify({ sku: item.sku, transactionID, action: safeAction, ttsText }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showSuccess(item, safeAction);
  } catch (error) {
    showToast(t("toast.purchaseIssue"), error.message, "error");
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

async function completeBitsPurchase(item, action, transaction, pendingTtsText) {
  const ttsText = isCustomTtsItem(item) ? pendingTtsText ?? getTtsInputText() : undefined;
  try {
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/purchase`, {
      method: "POST",
      body: JSON.stringify({ sku: item.sku, transactionID: transaction?.transactionId || transaction?.id || `${Date.now()}`, action, ttsText }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showSuccess(item, action);
  } catch (error) {
    showToast(t("toast.purchaseIssue"), error.message, "error");
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

async function buyWithCredits(item, action) {
  const ttsText = isCustomTtsItem(item) ? getTtsInputText() : undefined;
  if (isCustomTtsItem(item) && !ttsText) {
    showToast(t("toast.messageRequired"), t("toast.messageRequiredDesc"), "info");
    return;
  }
  if (!beginAction()) return;
  const safeAction = action === "save" && !isCustomTtsItem(item) ? "save" : "use_now";
  try {
    await requireOverlayConnected();
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/use-credit`, {
      method: "POST",
      body: JSON.stringify({ action: safeAction, ttsText }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showSuccess(item, safeAction);
  } catch (error) {
    showToast(t("toast.creditsFailed"), error.message, "error");
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

async function redeemSaved(itemId) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (!item) return;
  if (!beginAction()) return;
  try {
    await requireOverlayConnected();
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/redeem`, { method: "POST", body: "{}" });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    showSuccess(item, "use_now");
  } catch (error) {
    showToast(t("toast.redeemFailed"), error.message, "error");
  } finally {
    endAction();
  }
}

async function refreshMe() {
  const me = await apiFetch("/me");
  identityShared = Boolean(me.identityShared);
  inventory = me.inventory || null;
  updateBalanceBadge();
  renderLibrary();
  renderInventory();
  renderUserConfigControls();
}

function updateBalanceBadge() {
  const balance = getEl("header-balance");
  const chip = getEl("fx-balance");
  if (balance) balance.textContent = formatNumber(getBalance());
  if (chip) {
    chip.hidden = !identityShared || getBalance() <= 0;
    chip.setAttribute("aria-label", t("toast.creditsDesc", { balance: formatNumber(getBalance()) }));
  }
}

// ---------- Preferences ----------

function renderUserConfigControls() {
  const card = getEl("fx-quick-settings");
  if (!card) return;
  const config = getConfig();
  const disabled = identityShared ? "" : "disabled";
  const seg = (name, key, value, label) =>
    `<label><input type="radio" name="${name}" value="${value}" ${config[key] === value ? "checked" : ""} ${disabled} onchange="saveUserConfig()" /><span>${escapeHtml(label)}</span></label>`;
  card.innerHTML = `
    <div class="fx-label">${escapeHtml(t("settings.quickTitle"))}</div>
    <div class="fx-seg-group">
      <div class="fx-note">${escapeHtml(t("settings.quickPay"))}</div>
      <div class="fx-seg" role="radiogroup" aria-label="${escapeHtml(t("settings.quickPay"))}">
        ${seg("quick-priority", "quickPurchasePriority", "credits_first", t("settings.creditsFirst"))}
        ${seg("quick-priority", "quickPurchasePriority", "bits_first", t("settings.bitsFirst"))}
      </div>
    </div>
    <div class="fx-seg-group">
      <div class="fx-note">${escapeHtml(t("settings.quickDo"))}</div>
      <div class="fx-seg" role="radiogroup" aria-label="${escapeHtml(t("settings.quickDo"))}">
        ${seg("quick-action", "quickPurchaseAction", "use_now", t("settings.playNow"))}
        ${seg("quick-action", "quickPurchaseAction", "save", t("settings.save"))}
      </div>
    </div>
    ${identityShared ? "" : `<p class="fx-note">${escapeHtml(t("settings.quickNeedsId"))} <button type="button" class="fx-link" onclick="requestIdShare()">${escapeHtml(t("share.button"))}</button></p>`}`;
}

function readSegment(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

async function saveUserConfig() {
  if (!identityShared) return showToast(t("toast.identity"), t("toast.identityDesc"), "info");
  try {
    const updated = await apiFetch(`/channels/${encodeURIComponent(channelID)}/me/config`, {
      method: "PATCH",
      body: JSON.stringify({ quickPurchasePriority: readSegment("quick-priority"), quickPurchaseAction: readSegment("quick-action") }),
    });
    inventory = updated;
    renderLibrary();
    showToast(t("toast.prefsSaved"), t("toast.prefsSavedDesc"), "success");
  } catch (error) {
    showToast(t("toast.saveFailed"), error.message, "error");
    renderUserConfigControls();
  }
}

function showBitsBalance() {
  showToast(t("toast.credits"), t("toast.creditsDesc", { balance: formatNumber(getBalance()) }), "info");
}

// ---------- Toast ----------

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 16v-4M12 8h.01"></path></svg>',
};

function showToast(title, desc, type = "info") {
  const toast = getEl("toast");
  if (!toast) return;
  toast.querySelector(".toast-title").textContent = title;
  getEl("toast-desc").textContent = desc || "";
  toast.querySelector(".toast-icon").innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  toast.classList.remove("info", "success", "error");
  toast.classList.add(type, "show");
  if (window.toastTimeout) clearTimeout(window.toastTimeout);
  window.toastTimeout = setTimeout(() => toast.classList.remove("show"), 4000);
}
