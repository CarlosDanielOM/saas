// DimaFX viewer storefront runtime, shared by panel.html (Twitch panel) and mobile.html.
let products = [];
let inventory = null;
let identityShared = false;
let authToken = null;
let authorizationVersion = 0;
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
let bitsEnabled = false;
// SKU -> Bits amount from Twitch's catalog, when Twitch returns one (it doesn't in the legacy rig or very old apps).
let bitsCatalog = null;
let viewerLoggedIn = true;
let viewerOpaqueID = "";
let panelVisible = true;
let pendingRetryTimer = null;
// The current authorization's /me + items load; paid completions wait for it instead of failing mid-refresh.
let identityReady = Promise.resolve();
// A custom-voice draft hidden while identity is re-checked comes back when the same sheet can show it again.
let draftStash = null;
let walletTicks = 0;
let lastAudibleVolume = 60;
// The exact text the moderation check refused, so the sheet can say why until the viewer edits it.
let blockedTtsText = null;
const PREVIEW_VOLUME_KEY = "dimafx-preview-volume";

// Twitch serves hosted extension files from <client-id>.ext-twitch.tv, which has no /api, so hosted views call the
// extension backend by its public address. Self-hosted copies (local test, checks) keep the same-origin /api proxy.
const EBS_ORIGIN = "https://fx.domdimabot.com";
const API_BASE = /\.ext-twitch\.tv$/.test(window.location.hostname) ? `${EBS_ORIGIN}/api/v1` : `${window.location.origin}/api/v1`;
const PENDING_BITS_KEY = "dimafx-pending-bits";
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
    "status.offline": "Paused: {channel}'s overlay is offline. No Bits will be used.",
    "status.noBits": "Bits aren't turned on for this channel, so only free items and credits work.",
    "status.loggedOut": "Log in to Twitch to play items on stream.",
    "store.title": "Play something on {channel}'s stream",
    "store.titleGeneric": "Play something on stream",
    "store.searchLabel": "Search items",
    "store.search": "Search",
    "store.filters": "Filter by type",
    "store.emptyTitle": "Nothing here yet",
    "store.emptyDesc": "The streamer hasn't added any items.",
    "store.noMatchTitle": "No matches",
    "store.noMatchDesc": "Try another word or type.",
    "store.loadFailedTitle": "Couldn't load the items",
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
    "tile.confirmCredits": "Use {price}?",
    "tile.yourText": "Type your own message",
    "tile.bitsOff": "Bits off",
    "tile.login": "Log in",
    "custom.needsIdentity": "Share your Twitch ID to send custom text or other content. You can still play items chosen by the streamer.",
    "price.bits": "{price} Bits",
    "price.free": "Free",
    "nav.label": "DimaFX sections",
    "nav.store": "Effects",
    "nav.saved": "Saved",
    "nav.settings": "Settings",
    "saved.title": "Your saved items",
    "saved.sub": "Already yours. Play them on stream whenever you want.",
    "saved.play": "Play",
    "saved.playAria": "Play {name} on stream",
    "saved.count": "{count} saved",
    "saved.emptyTitle": "Nothing saved yet",
    "saved.emptyDesc": "Pick \"Save for later\" on an item to keep it here.",
    "saved.browse": "See all effects",
    "share.title": "Share your Twitch ID to unlock more",
    "share.desc": "Save items for later, use credits, and get credits back if something can't play.",
    "share.button": "Share Twitch ID",
    "settings.title": "Settings",
    "settings.volume": "Preview volume",
    "settings.volumeNote": "Only for previews in this panel, and off until you turn it up. The stream uses the streamer's volume.",
    "settings.quickTitle": "Quick button on each item",
    "settings.quickPay": "It uses",
    "settings.creditsFirst": "Credits first",
    "settings.bitsFirst": "Bits only",
    "settings.quickDo": "When you tap it",
    "settings.playNow": "Play now",
    "settings.save": "Save for later",
    "settings.quickNeedsId": "Share your Twitch ID to change these.",
    "settings.creditsTitle": "What are credits?",
    "settings.creditsNote": "If something you used Bits on can't play, you get credits for this channel to play another item here.",
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
    "sheet.willPlay": "Plays on {channel}'s stream for everyone as soon as Twitch confirms.",
    "sheet.willSave": "Goes to your Saved tab. Play it on stream any time.",
    "sheet.needText": "Type a message above first.",
    "sheet.trust": "If it can't play, you get it back as credits.",
    "sheet.shareForMore": "to save items, use credits and get credits back if something fails.",
    "sheet.shareLink": "Share your Twitch ID",
    "sheet.offline": "Paused while {channel}'s overlay is offline. No Bits will be used.",
    "sheet.bitsOff": "Bits aren't available for this item on this channel right now.",
    "sheet.loginNeeded": "Log in to Twitch to use this.",
    "toast.preview": "Preview mode",
    "toast.previewDesc": "Open inside Twitch to load the items.",
    "toast.unavailable": "DimaFX unavailable",
    "toast.loadFailed": "Unable to load the items.",
    "toast.triggered": "On its way!",
    "toast.triggeredDesc": "{name} is queued on stream.",
    "toast.saved": "Saved",
    "toast.savedDesc": "{name} is in your Saved tab.",
    "toast.purchaseIssue": "Something went wrong",
    "toast.pendingTitle": "Still confirming",
    "toast.pendingDesc": "{name}: your Bits went through. DimaFX keeps retrying while this panel is open, and again the next time you open it here.",
    "toast.bitsUnavailable": "Bits unavailable",
    "toast.bitsOnlyTwitch": "Bits only work inside Twitch.",
    "toast.messageRequired": "Message required",
    "toast.messageRequiredDesc": "Type the message to speak on stream first.",
    "toast.creditsFailed": "Couldn't use credits",
    "toast.redeemFailed": "Couldn't play it",
    "toast.previewUnavailable": "No preview",
    "toast.previewTts": "Voice items are spoken on stream, so there's no preview.",
    "toast.previewNone": "This item has no preview.",
    "toast.previewBlocked": "Preview blocked",
    "toast.previewBlockedDesc": "Tap again or allow audio for this page.",
    "toast.credits": "Your credits",
    "toast.creditsDesc": "{balance} credits to use on this channel.",
    "toast.prefsSaved": "Saved",
    "toast.prefsSavedDesc": "Your quick button was updated.",
    "toast.saveFailed": "Couldn't save",
    "toast.identity": "Twitch ID needed",
    "toast.identityDesc": "Share your Twitch ID to change this.",
    "error.offline": "Paused while the overlay is offline.",
    "error.identity": "Share your Twitch ID to do this.",
    "error.retry": "Couldn't reach DimaFX. Try again in a moment.",
    "error.unavailable": "This item isn't available right now.",
    "tile.ownedOne": "1 saved",
    "saved.countOne": "1 saved",
    "settings.volumeOff": "Off",
    "sheet.soundOn": "Turn preview sound on",
    "sheet.soundOff": "Turn preview sound off",
    "toast.muted": "Sound is off",
    "toast.mutedDesc": "Tap the speaker to hear previews.",
    "toast.madeGood": "Couldn't play it",
    "toast.madeGoodCredits": "{name} couldn't play, so you got {credits} credits back for this channel.",
    "toast.madeGoodSaved": "{name} couldn't play, so it's in your Saved tab to play later.",
    "tts.blocked": "This message can't be played on stream. Try saying it another way.",
    "tts.unavailable": "Voice messages are paused for a moment. Try again soon.",
    "tts.note": "Messages are checked automatically before they play, and your Twitch name is shown on stream with it.",
    "error.slowDown": "Too many tries. Wait a moment and try again.",
    "toast.blockedTitle": "Message not played",
    "toast.blockedCredits": "{name}: your message couldn't be played on stream, so you got {credits} credits back.",
  },
  es: {
    "status.checkingShort": "Revisando…",
    "status.checking": "Revisando el overlay del stream…",
    "status.readyShort": "En el stream",
    "status.offlineShort": "En pausa",
    "status.ready": "Se reproduce en el stream para todos, al instante.",
    "status.offline": "En pausa: el overlay de {channel} está desconectado. No se usarán tus Bits.",
    "status.noBits": "Este canal no tiene los Bits activados, así que solo funcionan los artículos gratis y los créditos.",
    "status.loggedOut": "Inicia sesión en Twitch para reproducir artículos en el stream.",
    "store.title": "Haz que pase algo en el stream de {channel}",
    "store.titleGeneric": "Haz que pase algo en el stream",
    "store.searchLabel": "Buscar artículos",
    "store.search": "Buscar",
    "store.filters": "Filtrar por tipo",
    "store.emptyTitle": "Todavía no hay nada aquí",
    "store.emptyDesc": "El streamer todavía no ha agregado artículos.",
    "store.noMatchTitle": "Sin resultados",
    "store.noMatchDesc": "Prueba otra palabra u otro tipo.",
    "store.loadFailedTitle": "No se pudieron cargar los artículos",
    "store.loadFailedDesc": "Revisa tu conexión e inténtalo de nuevo.",
    "store.retry": "Intentar de nuevo",
    "filter.all": "Todo",
    "type.video": "Video",
    "type.gif": "GIF",
    "type.audio": "Sonido",
    "type.tts": "Voz",
    "filter.video": "Videos",
    "filter.gif": "GIFs",
    "filter.audio": "Sonidos",
    "filter.tts": "Voz",
    "tile.new": "Nuevo",
    "tile.owned": "{count} guardados",
    "tile.open": "Ver {name}",
    "tile.offline": "En pausa",
    "tile.free": "Gratis",
    "tile.saveFree": "Guardar gratis",
    "tile.credits": "{price} créditos",
    "tile.confirmCredits": "¿Usar {price}?",
    "tile.yourText": "Escribe tu propio mensaje",
    "tile.bitsOff": "Sin Bits",
    "tile.login": "Inicia sesión",
    "custom.needsIdentity": "Comparte tu ID de Twitch para enviar texto u otro contenido propio. Puedes seguir usando los artículos elegidos por el streamer.",
    "price.bits": "{price} Bits",
    "price.free": "Gratis",
    "nav.label": "Secciones de DimaFX",
    "nav.store": "Efectos",
    "nav.saved": "Guardados",
    "nav.settings": "Configuración",
    "saved.title": "Tus artículos guardados",
    "saved.sub": "Ya son tuyos. Úsalos en el stream cuando quieras.",
    "saved.play": "Usar",
    "saved.playAria": "Usar {name} en el stream",
    "saved.count": "{count} guardados",
    "saved.emptyTitle": "Todavía no tienes nada guardado",
    "saved.emptyDesc": "Elige \"Guardar para después\" en un artículo para tenerlo aquí.",
    "saved.browse": "Ver todos los efectos",
    "share.title": "Comparte tu ID de Twitch para desbloquear más",
    "share.desc": "Guarda artículos, usa créditos y recupera créditos si algo no se puede reproducir.",
    "share.button": "Compartir ID de Twitch",
    "settings.title": "Configuración",
    "settings.volume": "Volumen de vista previa",
    "settings.volumeNote": "Solo para las vistas previas de este panel, y apagado hasta que lo subas. El stream usa el volumen del streamer.",
    "settings.quickTitle": "Botón rápido de cada artículo",
    "settings.quickPay": "Usa",
    "settings.creditsFirst": "Créditos primero",
    "settings.bitsFirst": "Solo Bits",
    "settings.quickDo": "Al tocarlo",
    "settings.playNow": "Usar ahora",
    "settings.save": "Guardar para después",
    "settings.quickNeedsId": "Comparte tu ID de Twitch para cambiar esto.",
    "settings.creditsTitle": "¿Qué son los créditos?",
    "settings.creditsNote": "Si algo en lo que usaste Bits no se puede reproducir, recibes créditos de este canal para usar otro artículo aquí.",
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
    "sheet.willPlay": "Se reproduce en el stream de {channel} para todos en cuanto Twitch lo confirme.",
    "sheet.willSave": "Va a tu pestaña Guardados. Úsalo en el stream cuando quieras.",
    "sheet.needText": "Primero escribe un mensaje arriba.",
    "sheet.trust": "Si no se puede reproducir, lo recuperas como créditos.",
    "sheet.shareForMore": "para guardar artículos, usar créditos y recuperar créditos si algo falla.",
    "sheet.shareLink": "Comparte tu ID de Twitch",
    "sheet.offline": "En pausa mientras el overlay de {channel} está desconectado. No se usarán tus Bits.",
    "sheet.bitsOff": "Los Bits no están disponibles para este artículo en este canal por ahora.",
    "sheet.loginNeeded": "Inicia sesión en Twitch para usar esto.",
    "toast.preview": "Modo vista previa",
    "toast.previewDesc": "Ábrelo dentro de Twitch para cargar los artículos.",
    "toast.unavailable": "DimaFX no disponible",
    "toast.loadFailed": "No se pudieron cargar los artículos.",
    "toast.triggered": "¡En camino!",
    "toast.triggeredDesc": "{name} está en cola en el stream.",
    "toast.saved": "Guardado",
    "toast.savedDesc": "{name} está en tu pestaña Guardados.",
    "toast.purchaseIssue": "Algo salió mal",
    "toast.pendingTitle": "Confirmando…",
    "toast.pendingDesc": "{name}: tus Bits sí se usaron. DimaFX lo sigue intentando mientras este panel esté abierto, y otra vez la próxima vez que lo abras aquí.",
    "toast.bitsUnavailable": "Bits no disponibles",
    "toast.bitsOnlyTwitch": "Los Bits solo funcionan dentro de Twitch.",
    "toast.messageRequired": "Falta el mensaje",
    "toast.messageRequiredDesc": "Escribe primero el mensaje que se dirá en el stream.",
    "toast.creditsFailed": "No se pudieron usar los créditos",
    "toast.redeemFailed": "No se pudo reproducir",
    "toast.previewUnavailable": "Sin vista previa",
    "toast.previewTts": "Los artículos de voz se dicen en el stream, así que no hay vista previa.",
    "toast.previewNone": "Este artículo no tiene vista previa.",
    "toast.previewBlocked": "Vista previa bloqueada",
    "toast.previewBlockedDesc": "Toca de nuevo o permite el audio en esta página.",
    "toast.credits": "Tus créditos",
    "toast.creditsDesc": "{balance} créditos para usar en este canal.",
    "toast.prefsSaved": "Guardado",
    "toast.prefsSavedDesc": "Se actualizó tu botón rápido.",
    "toast.saveFailed": "No se pudo guardar",
    "toast.identity": "Se necesita tu ID de Twitch",
    "toast.identityDesc": "Comparte tu ID de Twitch para cambiar esto.",
    "error.offline": "En pausa mientras el overlay está desconectado.",
    "error.identity": "Comparte tu ID de Twitch para hacer esto.",
    "error.retry": "No se pudo conectar con DimaFX. Inténtalo de nuevo en un momento.",
    "error.unavailable": "Este artículo no está disponible por ahora.",
    "tile.ownedOne": "1 guardado",
    "saved.countOne": "1 guardado",
    "settings.volumeOff": "Apagado",
    "sheet.soundOn": "Activar el sonido de la vista previa",
    "sheet.soundOff": "Desactivar el sonido de la vista previa",
    "toast.muted": "Sonido desactivado",
    "toast.mutedDesc": "Toca la bocina para escuchar las vistas previas.",
    "toast.madeGood": "No se pudo reproducir",
    "toast.madeGoodCredits": "{name} no se pudo reproducir, así que recuperaste {credits} créditos para este canal.",
    "toast.madeGoodSaved": "{name} no se pudo reproducir, así que está en tu pestaña Guardados para usarlo después.",
    "tts.blocked": "Este mensaje no se puede reproducir en el stream. Intenta decirlo de otra forma.",
    "tts.unavailable": "Los mensajes de voz están en pausa un momento. Intenta de nuevo pronto.",
    "tts.note": "Los mensajes se revisan automáticamente antes de reproducirse, y tu nombre de Twitch aparece en el stream junto con el mensaje.",
    "error.slowDown": "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
    "toast.blockedTitle": "Mensaje no reproducido",
    "toast.blockedCredits": "{name}: tu mensaje no se pudo reproducir en el stream, así que recuperaste {credits} créditos.",
  },
};

const LANG = (() => {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("language") || params.get("locale") || navigator.language || "en").toLowerCase();
  return raw.startsWith("es") ? "es" : "en";
})();
const LOCALE = LANG === "es" ? "es-MX" : "en-US";

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

function ownedLabel(count) {
  return t(count === 1 ? "tile.ownedOne" : "tile.owned", { count });
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
  return item?.category === "tts" && item?.tts?.mode !== "fixed";
}

function canUseViewerInput(item) {
  return identityShared || !isCustomTtsItem(item);
}

function requireViewerInputIdentity(item) {
  if (!canUseViewerInput(item)) throw new Error(t("custom.needsIdentity"));
}

function checkViewerInputIdentity(item) {
  if (canUseViewerInput(item)) return true;
  showToast(t("toast.identity"), t("custom.needsIdentity"), "info");
  return false;
}

// Only https media (or same-origin paths on a self-hosted copy) reaches the DOM.
function safeMediaUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.origin === window.location.origin ? url.href : "";
  } catch {
    return "";
  }
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
    image: safeMediaUrl(item.thumbnailUrl) || (visualMedia ? safeMediaUrl(item.mediaUrl || item.asset?.playbackUrl) : ""),
    description: item.description || "",
    mediaUrl: safeMediaUrl(item.mediaUrl || item.asset?.playbackUrl),
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
    const error = new Error(payload.message || "DimaFX request failed");
    error.status = response.status;
    error.fromApi = true;
    throw error;
  }
  return payload.data;
}

// Server messages are English and technical, so viewers get a localized reason instead.
function friendlyError(error) {
  const network = error instanceof TypeError;
  if (!error?.fromApi && !network) return error?.message || t("error.retry");
  if (network || !error.status || error.status >= 500 || error.status === 401) return t("error.retry");
  if (error.status === 429) return t("error.slowDown");
  if (error.status === 403) return t("error.identity");
  if (error.status === 409 && /disconnected|offline/i.test(error.message)) return t("error.offline");
  return t("error.unavailable");
}

// A 4xx answer is the server's final decision; anything else may succeed on a retry.
function isFinalApiError(error) {
  return Boolean(error?.fromApi && error.status && error.status < 500 && error.status !== 401);
}

// ---------- Bits availability ----------

function syncBitsFeature() {
  // Twitch requires monetized extensions to check this flag: false when the channel can't take Bits here.
  bitsEnabled = window.Twitch?.ext?.features?.isBitsEnabled === true;
}

function loadBitsCatalog() {
  const bits = window.Twitch?.ext?.bits;
  if (typeof bits?.getProducts !== "function") return;
  Promise.resolve()
    .then(() => bits.getProducts())
    .then((list) => {
      if (!Array.isArray(list)) return;
      bitsCatalog = new Map(list.filter((product) => product?.sku).map((product) => [String(product.sku), Number(product.cost?.amount || 0)]));
      renderAll();
    })
    .catch(() => { bitsCatalog = null; });
}

// Bits work for an item only when the channel takes Bits and Twitch's catalog charges exactly the price shown.
function bitsReady(item) {
  if (!bitsEnabled || isFreeItem(item)) return false;
  return !bitsCatalog || bitsCatalog.get(String(item.sku)) === item.priceValue;
}

function isOwnTransaction(transaction, item) {
  // Products set to broadcast also reach other viewers' panels; only this viewer's checkout completes here.
  const initiator = String(transaction?.initiator || "current_user").toLowerCase();
  if (initiator !== "current_user") return false;
  return !transaction?.product?.sku || String(transaction.product.sku) === String(item.sku);
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
    const readyNote = !viewerLoggedIn
      ? t("status.loggedOut")
      : !bitsEnabled && products.some((item) => !isFreeItem(item)) ? t("status.noBits") : t("status.ready");
    statusEl.textContent = state === "ready" ? readyNote : state === "offline" ? t("status.offline", { channel: channelLabel() }) : t("status.checking");
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
  authorizationVersion++;
  authToken = auth.token;
  channelID = auth.channelId;
  // Twitch's opaque ID starts with "A" for logged-out viewers and "U" for logged-in ones.
  viewerOpaqueID = String(auth.userId || "");
  viewerLoggedIn = !viewerOpaqueID.startsWith("A");
  // Authorization can change while a sheet or Twitch checkout is open.
  // Fail closed until this token's server-verified identity response arrives.
  identityShared = false;
  inventory = null;
  renderAll();
  if (overlayStatusTimer) clearInterval(overlayStatusTimer);
  overlayStatusTimer = setInterval(() => {
    if (!panelVisible || document.hidden) return;
    void refreshOverlayStatus();
    // Make-goods and refunds land asynchronously, so the wallet is re-read about once a minute.
    if (identityShared && ++walletTicks % 12 === 0) void refreshMe().catch(() => undefined);
  }, 5000);
  void refreshOverlayStatus();
  identityReady = loadStore();
  await identityReady;
  void resumePendingBitsPurchases();
}

async function loadStore() {
  const requestedVersion = authorizationVersion;
  toggleShimmer(true);
  getEl("empty-state").hidden = true;
  try {
    const [me, items] = await Promise.all([
      apiFetch("/me"),
      apiFetch(`/channels/${encodeURIComponent(channelID)}/items`),
    ]);
    if (requestedVersion !== authorizationVersion) return;
    identityShared = Boolean(me.identityShared);
    inventory = me.inventory || null;
    products = (items || []).map(mapItem);
    channelName = products.find((item) => item.channelName)?.channelName || channelName;
    loadFailed = false;
  } catch (error) {
    if (requestedVersion !== authorizationVersion) return;
    loadFailed = products.length === 0;
    showToast(t("toast.unavailable"), friendlyError(error), "error");
  } finally {
    if (requestedVersion === authorizationVersion) {
      toggleShimmer(false);
      renderAll();
    }
  }
}

function renderAll() {
  updateBalanceBadge();
  renderStatus();
  renderFilters();
  renderLibrary();
  renderInventory();
  renderUserConfigControls();
  syncTtsInput(false);
  renderDrawerActions();
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme !== "light");
}

applyStaticStrings();
applyTheme(new URLSearchParams(window.location.search).get("theme") || "dark");
restorePreviewVolume();

function syncKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
  document.documentElement.style.setProperty("--kb", `${inset}px`);
  document.body.classList.toggle("fx--kb", inset > 120);
}
window.visualViewport?.addEventListener("resize", syncKeyboardInset);
window.visualViewport?.addEventListener("scroll", syncKeyboardInset);

if (window.Twitch) {
  // Identity sharing is only requested from a viewer's tap, when a feature needs it.
  Twitch.ext.onAuthorized((auth) => initializeDimaFx(auth));
  Twitch.ext.onContext?.((context, changed) => {
    if (!changed || changed.includes("theme")) applyTheme(context?.theme);
  });
  Twitch.ext.onVisibilityChanged?.((isVisible) => {
    panelVisible = isVisible !== false;
    if (panelVisible) void refreshOverlayStatus();
  });
  syncBitsFeature();
  Twitch.ext.features?.onChanged?.((changed) => {
    if (!Array.isArray(changed) || changed.includes("isBitsEnabled")) {
      syncBitsFeature();
      renderAll();
    }
  });
  loadBitsCatalog();
  if (Twitch.ext.bits?.onTransactionComplete) {
    Twitch.ext.bits.onTransactionComplete((transaction) => {
      if (!pendingBitsPurchase || !isOwnTransaction(transaction, pendingBitsPurchase.item)) return;
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
  const button = tabButton || document.querySelector(`.nav-tab[data-tab="${screenId}"]`);
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
      `<button type="button" class="fx-filter" aria-pressed="${currentFilter === kind}" data-action="filter" data-kind="${kind}">${escapeHtml(label)} <small>${count}</small></button>`;
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
  // Logged-out viewers can still start Bits checkout (Twitch asks them to log in); everything else needs an account.
  if (!viewerLoggedIn && (isFreeItem(item) || isCustomTtsItem(item))) return { pay: "login", action };
  if (isFreeItem(item)) return { pay: "free", action };
  const creditsCover = identityShared && getBalance() >= item.priceValue;
  if (creditsCover && (config.quickPurchasePriority === "credits_first" || !bitsReady(item))) return { pay: "credits", action };
  if (!bitsReady(item)) return { pay: "off", action };
  return { pay: "bits", action };
}

function quickActionEnabled(item) {
  return overlayConnected && !["login", "off"].includes(quickPlan(item).pay);
}

function quickActionLabel(item) {
  const plan = quickPlan(item);
  if (plan.pay === "login") return escapeHtml(t("tile.login"));
  if (!canUseViewerInput(item)) return escapeHtml(t("share.button"));
  if (!overlayConnected) return escapeHtml(t("tile.offline"));
  if (plan.pay === "off") return escapeHtml(t("tile.bitsOff"));
  const price = formatNumber(item.priceValue);
  if (confirmingCreditsFor === String(item.id)) return escapeHtml(t("tile.confirmCredits", { price }));
  if (plan.pay === "free") return `${PLAY_SVG}${escapeHtml(t(plan.action === "save" ? "tile.saveFree" : "tile.free"))}`;
  if (plan.pay === "credits") return `${PLAY_SVG}${escapeHtml(t("tile.credits", { price }))}`;
  return `${GEM_SVG}${escapeHtml(t("price.bits", { price }))}`;
}

function quickActionClass(item) {
  if (confirmingCreditsFor === String(item.id)) return "confirm";
  return quickPlan(item).pay;
}

function quickActionAria(item) {
  const plan = quickPlan(item);
  if (plan.pay === "login") return `${item.name}: ${t("status.loggedOut")}`;
  if (!canUseViewerInput(item)) return `${t("share.button")}: ${item.name}`;
  if (plan.pay === "off") return `${item.name}: ${t("sheet.bitsOff")}`;
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
      emptyState.insertAdjacentHTML("beforeend", `<button type="button" class="fx-btn fx-btn--primary fx-btn--sm" data-action="retry">${escapeHtml(t("store.retry"))}</button>`);
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
      owned ? `<span class="fx-tag fx-tag--owned">${escapeHtml(ownedLabel(owned))}</span>` : !isFreeItem(item) && item.duration ? `<span class="fx-tag fx-tag--time">${escapeHtml(item.duration)}</span>` : "",
    ].join("");
    return `
      <article class="fx-tile media-card" data-id="${id}">
        <button type="button" class="fx-tile__open" data-action="open" data-id="${id}" aria-label="${escapeHtml(t("tile.open", { name: item.name }))}">
          ${thumbHtml(item).replace("</div>", `${tags}</div>`)}
          <span class="fx-tile__name card-title">${escapeHtml(item.name)}</span>
        </button>
        <div class="fx-tile__buy">
          <button type="button" class="fx-price price-btn ${quickActionClass(item)}" ${quickActionEnabled(item) ? "" : "disabled"} aria-label="${escapeHtml(quickActionAria(item))}" data-action="quick" data-id="${id}">${quickActionLabel(item)}</button>
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
    list.innerHTML = viewerLoggedIn ? `
      <div class="fx-card fx-card--cta">
        <div class="fx-label">${escapeHtml(t("share.title"))}</div>
        <p class="fx-note" style="margin:0">${escapeHtml(t("share.desc"))}</p>
        <button type="button" class="fx-btn fx-btn--primary fx-btn--sm" data-action="share">${escapeHtml(t("share.button"))}</button>
      </div>` : `
      <div class="fx-card fx-card--cta">
        <div class="fx-label">${escapeHtml(t("status.loggedOut"))}</div>
        <p class="fx-note" style="margin:0">${escapeHtml(t("share.desc"))}</p>
      </div>`;
    return;
  }
  if (savedItems.length === 0) {
    list.innerHTML = `
      <div class="fx-empty">
        <div class="fx-empty__title">${escapeHtml(t("saved.emptyTitle"))}</div>
        <div class="fx-empty__desc">${escapeHtml(t("saved.emptyDesc"))}</div>
        <button type="button" class="fx-btn fx-btn--sm" data-action="tab" data-target="store">${escapeHtml(t("saved.browse"))}</button>
      </div>`;
    return;
  }

  list.innerHTML = savedItems.map((item) => `
    <div class="fx-row inventory-card">
      ${thumbHtml(item, { compact: true })}
      <div style="min-width:0">
        <div class="fx-row__name">${escapeHtml(item.name)}</div>
        <div class="fx-row__meta">${escapeHtml(item.categoryLabel)} · ${escapeHtml(t(getInventoryQuantity(item.id) === 1 ? "saved.countOne" : "saved.count", { count: getInventoryQuantity(item.id) }))}</div>
      </div>
      <button type="button" class="fx-btn fx-btn--primary fx-btn--sm btn-use-item" ${overlayConnected ? "" : "disabled"} aria-label="${escapeHtml(t("saved.playAria", { name: item.name }))}" data-action="redeem" data-id="${escapeHtml(item.id)}">${PLAY_SVG}${escapeHtml(t("saved.play"))}</button>
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

function syncTtsInput(reset = true) {
  const wrap = getEl("tts-input-wrap");
  if (!wrap) return;
  const show = identityShared && isCustomTtsItem(selectedItem);
  wrap.hidden = !show;
  const input = getEl("tts-text-input");
  if (input) {
    const itemID = String(selectedItem?.id || "");
    if (!show && !reset && input.value) draftStash = { itemID, text: input.value };
    if (reset) draftStash = null;
    input.disabled = !show;
    if (!show || reset) input.value = "";
    if (show && !input.value && draftStash?.itemID === itemID) {
      input.value = draftStash.text;
      draftStash = null;
    }
  }
  if (show) onTtsTextInput();
}

function openDrawerById(itemId, trigger) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (item) openDrawer(item, trigger);
}

function openDrawer(item, trigger = document.activeElement) {
  selectedItem = item;
  blockedTtsText = null;
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
  if (owned) meta.push(`<span class="fx-chip fx-chip--muted">${escapeHtml(ownedLabel(owned))}</span>`);
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
  if (!viewerLoggedIn && (isFree || isCustomTtsItem(item))) {
    actionContainer.innerHTML = `<p class="fx-hint">${escapeHtml(t("sheet.loginNeeded"))}</p>`;
    return;
  }
  if (!canUseViewerInput(item)) {
    actionContainer.innerHTML = `<p class="fx-hint">${escapeHtml(t("custom.needsIdentity"))}</p><button type="button" class="fx-btn fx-btn--primary" data-action="share">${escapeHtml(t("share.button"))}</button>`;
    return;
  }
  const ttsMissing = customTts && !getTtsInputText();
  const ttsRefused = customTts && blockedTtsText !== null && blockedTtsText === getTtsInputText();
  // Custom-text TTS items must be used immediately — the viewer's text only exists in this purchase request.
  const saveDisabled = !identityShared || customTts;
  const price = formatNumber(item.priceValue);
  const balance = getBalance();
  const saving = selectedAction === "save";
  const html = [];

  if (!customTts) {
    html.push(`
      <div class="fx-seg" role="radiogroup" aria-label="${escapeHtml(t("sheet.actionLabel"))}">
        <label><input type="radio" name="fx-action" value="use_now" ${saving ? "" : "checked"} /><span>${escapeHtml(t("sheet.playNow"))}</span></label>
        <label><input type="radio" name="fx-action" value="save" ${saving ? "checked" : ""} ${saveDisabled ? "disabled" : ""} /><span>${escapeHtml(t("sheet.save"))}</span></label>
      </div>`);
  }

  if (isFree) {
    const disabled = (saving && saveDisabled) || ttsMissing || !overlayConnected;
    html.push(`<button type="button" class="drawer-buy-btn free sheet-btn-buy" ${disabled ? "disabled" : ""} data-action="buy-free">${PLAY_SVG}<span>${escapeHtml(t(saving ? "sheet.saveFree" : "sheet.playFree"))}</span></button>`);
  } else {
    const bitsDisabled = ttsMissing || !overlayConnected;
    if (bitsReady(item)) {
      html.push(`<button type="button" class="drawer-buy-btn bits sheet-btn-buy" ${bitsDisabled ? "disabled" : ""} data-action="buy-bits">${GEM_SVG}<span>${escapeHtml(t(saving ? "sheet.saveBits" : "sheet.buyBits", { price }))}</span></button>`);
    }
    if (identityShared && balance >= item.priceValue) {
      const creditsOk = overlayConnected && !ttsMissing;
      html.push(`<button type="button" class="drawer-buy-btn credits sheet-btn-buy" ${creditsOk ? "" : "disabled"} data-action="buy-credits"><span>${escapeHtml(t("sheet.buyCredits", { price, balance: formatNumber(balance) }))}</span></button>`);
    }
  }

  if (!overlayConnected && overlayChecked) {
    html.push(`<p class="fx-hint fx-hint--warn">${escapeHtml(t("sheet.offline", { channel: channelLabel() }))}</p>`);
  } else if (!isFree && !bitsReady(item) && !(identityShared && balance >= item.priceValue)) {
    html.push(`<p class="fx-hint fx-hint--warn">${escapeHtml(t("sheet.bitsOff"))}</p>`);
  } else if (ttsRefused) {
    html.push(`<p class="fx-hint fx-hint--warn" role="alert">${escapeHtml(t("tts.blocked"))}</p>`);
  } else if (ttsMissing) {
    html.push(`<p class="fx-hint">${escapeHtml(t("sheet.needText"))}</p>`);
  } else {
    html.push(`<p class="fx-hint">${escapeHtml(saving ? t("sheet.willSave") : t("sheet.willPlay", { channel: channelLabel() }))}</p>`);
  }

  if (customTts && identityShared) html.push(`<p class="fx-hint">${escapeHtml(t("tts.note"))}</p>`);
  if (identityShared) {
    if (!isFree) html.push(`<p class="fx-trust">${SHIELD_SVG}<span>${escapeHtml(t("sheet.trust"))}</span></p>`);
  } else if (!viewerLoggedIn) {
    html.push(`<p class="fx-hint">${escapeHtml(t("status.loggedOut"))}</p>`);
  } else {
    html.push(`<p class="fx-trust">${SHIELD_SVG}<span><button type="button" class="fx-link" data-action="share">${escapeHtml(t("sheet.shareLink"))}</button> ${escapeHtml(t("sheet.shareForMore"))}</span></p>`);
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
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw / 100));
}

function setPreviewVolume(value, { remember = true } = {}) {
  const slider = getEl("preview-volume");
  if (!slider) return;
  const next = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  slider.value = String(next);
  onPreviewVolumeInput(slider, { remember });
}

function onPreviewVolumeInput(slider, { remember = true } = {}) {
  const value = Number(slider.value);
  const label = getEl("val-volume");
  if (label) label.textContent = value > 0 ? `${value}%` : t("settings.volumeOff");
  slider.style.setProperty("--pct", String(value / 100));
  if (previewPlayer) {
    previewPlayer.volume = getPreviewVolume();
    previewPlayer.muted = value === 0;
  }
  if (remember) {
    try { localStorage.setItem(PREVIEW_VOLUME_KEY, String(value)); } catch { /* not remembered in this browser */ }
  }
  syncSoundButton();
}

function syncSoundButton() {
  const button = getEl("player-sound");
  if (!button) return;
  const on = getPreviewVolume() > 0;
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", t(on ? "sheet.soundOff" : "sheet.soundOn"));
  button.classList.toggle("is-on", on);
}

function togglePreviewSound() {
  const current = Number(getEl("preview-volume")?.value || 0);
  if (current > 0) {
    lastAudibleVolume = current;
    setPreviewVolume(0);
  } else {
    setPreviewVolume(lastAudibleVolume || 60);
  }
}

function restorePreviewVolume() {
  let saved = 0;
  try { saved = Number(localStorage.getItem(PREVIEW_VOLUME_KEY) || 0); } catch { saved = 0; }
  if (saved > 0) lastAudibleVolume = saved;
  setPreviewVolume(saved, { remember: false });
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
  const sound = getEl("player-sound");
  if (sound) sound.hidden = !play || play.hidden;
  syncSoundButton();
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
  previewPlayer.muted = getPreviewVolume() === 0;
  if (previewPlayer.muted) showToast(t("toast.muted"), t("toast.mutedDesc"), "info");
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

// The server makes good on a paid play it couldn't deliver (credits or a saved copy) instead of failing it.
function showOutcome(item, action, data) {
  const madeGood = data?.madeGood;
  if (data?.blocked && Number(madeGood?.credits) > 0) {
    return showToast(t("toast.blockedTitle"), t("toast.blockedCredits", { name: item.name, credits: formatNumber(madeGood.credits) }), "info");
  }
  if (!madeGood) return showSuccess(item, action);
  const desc = Number(madeGood.credits) > 0
    ? t("toast.madeGoodCredits", { name: item.name, credits: formatNumber(madeGood.credits) })
    : t("toast.madeGoodSaved", { name: item.name });
  showToast(t("toast.madeGood"), desc, "info");
}

function showSuccess(item, action) {
  showToast(
    t(action === "save" ? "toast.saved" : "toast.triggered"),
    t(action === "save" ? "toast.savedDesc" : "toast.triggeredDesc", { name: item.name }),
    "success"
  );
}

// Viewer-typed voice messages are checked before any Bits or credits are used, so a refused message costs nothing.
async function checkViewerText(item, text) {
  if (!isCustomTtsItem(item)) return;
  const result = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/tts-check`, {
    method: "POST",
    body: JSON.stringify({ ttsText: text }),
  });
  if (result?.allowed === true) return;
  const blocked = result?.reason === "blocked" || result?.reason === "invalid";
  if (blocked) {
    blockedTtsText = text;
    renderDrawerActions();
  }
  throw new Error(t(blocked ? "tts.blocked" : "tts.unavailable"));
}

async function buyWithBits(item, action) {
  if (!checkViewerInputIdentity(item)) return;
  if (!window.Twitch?.ext?.bits?.useBits) {
    showToast(t("toast.bitsUnavailable"), t("toast.bitsOnlyTwitch"), "info");
    return;
  }
  if (!bitsReady(item)) {
    showToast(t("toast.bitsUnavailable"), t("sheet.bitsOff"), "info");
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
    requireViewerInputIdentity(item);
    await checkViewerText(item, ttsText);
    pendingBitsPurchase = { item, action, ttsText };
    Twitch.ext.bits.useBits(item.sku);
  } catch (error) {
    pendingBitsPurchase = null;
    endAction();
    showToast(t("toast.bitsUnavailable"), friendlyError(error), "error");
  }
}

async function triggerFreeItem(item, action = "use_now") {
  if (!viewerLoggedIn) {
    showToast(t("toast.identity"), t("status.loggedOut"), "info");
    return;
  }
  if (!checkViewerInputIdentity(item)) return;
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
    requireViewerInputIdentity(item);
    await checkViewerText(item, ttsText);
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/purchase`, {
      method: "POST",
      body: JSON.stringify({ sku: item.sku, transactionID, action: safeAction, ttsText }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    if (data?.blocked) {
      blockedTtsText = ttsText || null;
      renderDrawerActions();
      showToast(t("toast.blockedTitle"), t("tts.blocked"), "error");
      return;
    }
    closeDrawer();
    showSuccess(item, safeAction);
  } catch (error) {
    showToast(t("toast.purchaseIssue"), friendlyError(error), "error");
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

// Paid completions survive a closed panel or a dropped connection: they are kept on this device until the server
// answers, retried while the panel is open, and resumed the next time it opens (the server dedupes by transaction).
function readPendingBits() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_BITS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((entry) => entry?.body?.transactionID && Date.now() - Number(entry.at || 0) < 7 * 86400000) : [];
  } catch {
    return [];
  }
}

function writePendingBits(list) {
  try {
    localStorage.setItem(PENDING_BITS_KEY, JSON.stringify(list.slice(-10)));
  } catch {
    // Storage blocked: retries still run while the panel stays open.
  }
}

function forgetPendingBits(transactionID) {
  writePendingBits(readPendingBits().filter((entry) => entry.body.transactionID !== transactionID));
}

async function postBitsCompletion(entry) {
  let lastError;
  for (const delay of [0, 1500, 4000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await apiFetch(`/channels/${encodeURIComponent(entry.channelID)}/items/${encodeURIComponent(entry.itemID)}/purchase`, {
        method: "POST",
        body: JSON.stringify(entry.body),
      });
    } catch (error) {
      lastError = error;
      if (isFinalApiError(error)) break;
    }
  }
  throw lastError;
}

function schedulePendingRetry() {
  clearTimeout(pendingRetryTimer);
  pendingRetryTimer = setTimeout(() => { void resumePendingBitsPurchases(); }, 20000);
}

async function resumePendingBitsPurchases() {
  if (!authToken || !channelID) return;
  const due = readPendingBits().filter((entry) => entry.channelID === channelID && entry.viewer === viewerOpaqueID);
  for (const entry of due) {
    try {
      const data = await postBitsCompletion(entry);
      forgetPendingBits(entry.body.transactionID);
      if (data?.inventory) inventory = data.inventory;
      showOutcome({ name: entry.name }, entry.action, data);
    } catch (error) {
      if (isFinalApiError(error)) {
        forgetPendingBits(entry.body.transactionID);
        continue;
      }
      schedulePendingRetry();
      break;
    }
  }
  if (due.length) await refreshMe().catch(() => undefined);
}

async function completeBitsPurchase(item, action, transaction, pendingTtsText) {
  // Twitch can refresh the token mid-checkout; wait for that check rather than dropping a paid message.
  await identityReady.catch(() => undefined);
  const ttsText = isCustomTtsItem(item) ? pendingTtsText ?? getTtsInputText() : undefined;
  // Twitch names the field transactionID; the signed receipt is what proves the Bits were used.
  const transactionID = String(transaction?.transactionID || transaction?.transactionId || "");
  let entry = null;
  try {
    requireViewerInputIdentity(item);
    entry = {
      channelID, viewer: viewerOpaqueID, itemID: String(item.id), name: item.name, action, at: Date.now(),
      body: { sku: item.sku, transactionID, transactionReceipt: transaction?.transactionReceipt || "", action, ttsText },
    };
    writePendingBits([...readPendingBits().filter((other) => other.body.transactionID !== transactionID), entry]);
    const data = await postBitsCompletion(entry);
    forgetPendingBits(transactionID);
    if (data?.inventory) inventory = data.inventory;
    await refreshMe().catch(() => undefined);
    closeDrawer();
    showOutcome(item, action, data);
  } catch (error) {
    if (entry && !isFinalApiError(error)) {
      showToast(t("toast.pendingTitle"), t("toast.pendingDesc", { name: item.name }), "info");
      schedulePendingRetry();
    } else {
      if (entry) forgetPendingBits(transactionID);
      showToast(t("toast.purchaseIssue"), friendlyError(error), "error");
    }
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

async function buyWithCredits(item, action) {
  if (!checkViewerInputIdentity(item)) return;
  const ttsText = isCustomTtsItem(item) ? getTtsInputText() : undefined;
  if (isCustomTtsItem(item) && !ttsText) {
    showToast(t("toast.messageRequired"), t("toast.messageRequiredDesc"), "info");
    return;
  }
  if (!beginAction()) return;
  const safeAction = action === "save" && !isCustomTtsItem(item) ? "save" : "use_now";
  try {
    await requireOverlayConnected();
    requireViewerInputIdentity(item);
    await checkViewerText(item, ttsText);
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/use-credit`, {
      method: "POST",
      body: JSON.stringify({ action: safeAction, ttsText }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    if (data?.blocked) {
      blockedTtsText = ttsText || null;
      renderDrawerActions();
      showToast(t("toast.blockedTitle"), t("tts.blocked"), "error");
      return;
    }
    closeDrawer();
    showSuccess(item, safeAction);
  } catch (error) {
    showToast(t("toast.creditsFailed"), friendlyError(error), "error");
    await refreshMe().catch(() => undefined);
  } finally {
    endAction();
  }
}

async function redeemSaved(itemId) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (!item || !checkViewerInputIdentity(item)) return;
  if (!beginAction()) return;
  try {
    await requireOverlayConnected();
    requireViewerInputIdentity(item);
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/redeem`, { method: "POST", body: "{}" });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    showSuccess(item, "use_now");
  } catch (error) {
    showToast(t("toast.redeemFailed"), friendlyError(error), "error");
  } finally {
    endAction();
  }
}

async function refreshMe() {
  const requestedVersion = authorizationVersion;
  const me = await apiFetch("/me");
  if (requestedVersion !== authorizationVersion) return;
  const nextShared = Boolean(me.identityShared);
  const nextInventory = me.inventory || null;
  if (nextShared === identityShared && JSON.stringify(nextInventory) === JSON.stringify(inventory)) return;
  identityShared = nextShared;
  inventory = nextInventory;
  updateBalanceBadge();
  renderLibrary();
  renderInventory();
  renderUserConfigControls();
  syncTtsInput(false);
  renderDrawerActions();
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
    `<label><input type="radio" name="${name}" value="${value}" ${config[key] === value ? "checked" : ""} ${disabled} /><span>${escapeHtml(label)}</span></label>`;
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
    ${identityShared ? "" : viewerLoggedIn
      ? `<p class="fx-note">${escapeHtml(t("settings.quickNeedsId"))} <button type="button" class="fx-link" data-action="share">${escapeHtml(t("share.button"))}</button></p>`
      : `<p class="fx-note">${escapeHtml(t("status.loggedOut"))}</p>`}`;
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
    showToast(t("toast.saveFailed"), friendlyError(error), "error");
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

// ---------- Events ----------
// Twitch's Content Security Policy blocks inline event-handler attributes, so every control is wired here.

document.addEventListener("click", (event) => {
  const tab = event.target.closest?.(".nav-tab[data-tab]");
  if (tab) return switchTab(tab.dataset.tab, tab);
  const el = event.target.closest?.("[data-action]");
  if (!el || el.disabled) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case "open": return openDrawerById(id, el);
    case "quick": return quickPurchase(id);
    case "filter": return filterCategory(el.dataset.kind, el);
    case "retry": return void loadStore();
    case "share": return requestIdShare();
    case "tab": return switchTab(el.dataset.target);
    case "redeem": return void redeemSaved(id);
    case "buy-free": return void triggerFreeItem(selectedItem, selectedAction);
    case "buy-bits": return void buyWithBits(selectedItem, selectedAction);
    case "buy-credits": return void buyWithCredits(selectedItem, selectedAction);
    case "preview": return togglePlayPreview();
    case "sound": return togglePreviewSound();
    case "close": return closeDrawer();
    case "credits": return showBitsBalance();
    default: return undefined;
  }
});

document.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "radio") return;
  if (input.name === "fx-action") setDrawerAction(input.value);
  else if (input.name === "quick-priority" || input.name === "quick-action") void saveUserConfig();
});

getEl("search-bar")?.addEventListener("input", (event) => handleSearch(event.target.value));
getEl("preview-volume")?.addEventListener("input", (event) => onPreviewVolumeInput(event.target));
getEl("tts-text-input")?.addEventListener("input", onTtsTextInput);
getEl("tts-text-input")?.addEventListener("focus", (event) => {
  // Give the keyboard time to open, then keep the message box in view.
  setTimeout(() => event.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
});
