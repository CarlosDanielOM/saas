let products = window.fallbackProducts || [];
let inventory = null;
let identityShared = false;
let authToken = null;
let channelID = null;
let currentFilter = "all";
let searchQuery = "";
let selectedItem = null;
let selectedAction = "use_now";
let pendingBitsPurchase = null;
let isPlaying = false;
let previewPlayer = null;
let playInterval = null;

const API_BASE = `${window.location.origin}/api/v1`;

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

function formatDuration(ms) {
  if (!ms) return "Preview";
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getInventoryQuantity(itemId) {
  return (inventory?.items || [])
    .filter((item) => String(item.channelExtensionItemID) === String(itemId) && Number(item.quantity || 0) > 0)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function getBalance() {
  return Number(inventory?.balance || 0);
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

async function initializeDimaFx(auth) {
  authToken = auth.token;
  channelID = auth.channelId;
  toggleShimmer(true);
  try {
    const [me, items] = await Promise.all([
      apiFetch("/me"),
      apiFetch(`/channels/${encodeURIComponent(channelID)}/items`),
    ]);
    identityShared = Boolean(me.identityShared);
    inventory = me.inventory || null;
    products = (items || []).map((item) => ({
      id: item.id || item._id,
      name: item.name,
      category: item.category || "media",
      categoryLabel: categoryLabel(item.category),
      duration: formatDuration(item.durationMs),
      price: `${item.bitsPrice} Bits`,
      priceType: "bits",
      priceValue: Number(item.bitsPrice || 0),
      sku: item.sku,
      image: item.thumbnailUrl || item.asset?.playbackUrl || "assets/soundfx.png",
      description: item.description || "DimaFX media item",
      mediaUrl: item.mediaUrl || item.asset?.playbackUrl,
      mediaType: item.mediaType,
      durationMs: item.durationMs,
    }));
    updateBalanceBadge();
    renderLibrary();
    renderInventory();
    renderUserConfigControls();
  } catch (error) {
    showToast("DimaFX unavailable", error.message || "Unable to load extension items.", "error");
  } finally {
    toggleShimmer(false);
  }
}

function categoryLabel(category) {
  if (category === "video") return "Video";
  if (category === "gif") return "Gifs";
  if (category === "audio") return "Audio";
  if (category === "tts") return "TTS";
  return String(category || "Media").toUpperCase();
}

if (window.Twitch) {
  Twitch.ext.actions.requestIdShare();
  Twitch.ext.onAuthorized((auth) => initializeDimaFx(auth));
  if (Twitch.ext.bits?.onTransactionComplete) {
    Twitch.ext.bits.onTransactionComplete((transaction) => {
      if (!pendingBitsPurchase) return;
      completeBitsPurchase(pendingBitsPurchase.item, pendingBitsPurchase.action, transaction);
      pendingBitsPurchase = null;
    });
  }
} else {
  window.addEventListener("DOMContentLoaded", () => {
    showToast("DimaFX Preview", "Open inside Twitch to load live extension items.", "info");
    toggleShimmer(false);
    if (products.length > 0) {
      renderLibrary();
      renderInventory();
    }
  });
}

function switchTab(screenId, tabButton) {
  document.querySelectorAll(".app-screen").forEach((scr) => scr.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((tb) => tb.classList.remove("active"));
  getEl("screen-" + screenId)?.classList.add("active");
  tabButton?.classList.add("active");
  closeDrawer();
}

function renderLibrary() {
  const grid = getEl("media-grid", "store-grid");
  const emptyState = getEl("empty-state");
  if (!grid) return;
  grid.innerHTML = "";

  const filtered = products.filter((item) => {
    const matchesCategory = currentFilter === "all" || item.category === currentFilter;
    const query = searchQuery.toLowerCase();
    const matchesSearch = item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  if (emptyState) emptyState.style.display = filtered.length === 0 ? "flex" : "none";
  if (filtered.length === 0 && !emptyState) {
    grid.innerHTML = `<div class="inv-empty"><div><div style="font-weight:600;color:white;font-size:12px;">No assets found</div><div style="font-size:9px;color:var(--text-muted);margin-top:2px;">This channel has not configured DimaFX items yet.</div></div></div>`;
    return;
  }

  filtered.forEach((item) => {
    const card = document.createElement("div");
    card.className = grid.id === "store-grid" ? "mobile-card" : "media-card";
    card.onclick = () => openDrawer(item);

    let thumbHtml = '';
    if (item.category === 'video' && item.mediaUrl) {
      thumbHtml = `<video class="card-thumb-video" src="${escapeHtml(item.mediaUrl)}" poster="${escapeHtml(item.image)}" muted playsinline preload="metadata"></video>`;
    } else if (item.category === 'audio' || item.category === 'tts') {
      thumbHtml = `
        <div class="card-thumb-audio">
          <div class="mini-wave-decor">
            <span class="m-wave-bar"></span>
            <span class="m-wave-bar"></span>
            <span class="m-wave-bar"></span>
            <span class="m-wave-bar"></span>
            <span class="m-wave-bar"></span>
          </div>
          <svg class="audio-icon-decor" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
        </div>
      `;
    } else {
      thumbHtml = `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">`;
    }

    card.innerHTML = `
      <div class="card-thumb">
        ${thumbHtml}
        <div class="thumb-overlay"><div class="play-btn-circle"><svg viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5"></polygon></svg></div></div>
        <span class="tag-badge ${escapeHtml(item.category)}">${escapeHtml(item.categoryLabel)}</span>
        <span class="duration-badge">${escapeHtml(item.duration)}</span>
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(item.name)}</div>
        <div class="card-desc">${escapeHtml(item.description)}</div>
      </div>
      <div class="card-footer">
        <button class="price-btn bits" onclick="event.stopPropagation(); quickPurchase('${escapeHtml(item.id)}')">
          <svg viewBox="0 0 24 24"><polygon points="12 2 22 12 12 22 2 12"></polygon></svg>
          <span>${quickActionLabel(item)}</span>
        </button>
      </div>`;
    grid.appendChild(card);
  });
}

function quickActionLabel(item) {
  const config = inventory?.config || { quickPurchasePriority: "credits_first", quickPurchaseAction: "use_now" };
  const action = config.quickPurchaseAction === "save" && identityShared ? "Save" : "Use";
  if (identityShared && config.quickPurchasePriority === "credits_first" && getBalance() >= item.priceValue) {
    return `${action} • ${item.priceValue} Credits`;
  }
  return `${action} • ${item.price}`;
}

function renderInventory() {
  const list = getEl("inventory-list");
  if (!list) return;
  list.innerHTML = "";

  if (!identityShared) {
    list.innerHTML = `<div class="inv-empty"><div><div style="font-weight:600;color:white;font-size:12px;">Inventory disabled</div><div style="font-size:9px;color:var(--text-muted);margin-top:2px;">Share your Twitch identity to save items and use credits.</div></div></div>`;
    return;
  }

  const savedItems = products.filter((item) => getInventoryQuantity(item.id) > 0);
  if (savedItems.length === 0) {
    list.innerHTML = `<div class="inv-empty"><div><div style="font-weight:600;color:white;font-size:12px;">Your inventory is empty</div><div style="font-size:9px;color:var(--text-muted);margin-top:2px;">Save items from the Store to redeem later.</div></div></div>`;
    return;
  }

  savedItems.forEach((item) => {
    const invCard = document.createElement("div");
    invCard.className = "inventory-card";

    let thumbHtml = '';
    if (item.category === 'video' && item.mediaUrl) {
      thumbHtml = `<video class="inv-thumb inv-thumb--video" src="${escapeHtml(item.mediaUrl)}" poster="${escapeHtml(item.image)}" muted playsinline preload="metadata"></video>`;
    } else if (item.category === 'audio' || item.category === 'tts') {
      thumbHtml = `
        <div class="inv-thumb inv-thumb--audio">
          <svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
        </div>
      `;
    } else {
      thumbHtml = `<img class="inv-thumb" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">`;
    }

    invCard.innerHTML = `
      ${thumbHtml}
      <div class="inv-info">
        <div class="inv-title">${escapeHtml(item.name)}</div>
        <div class="inv-meta">${escapeHtml(item.categoryLabel)} • ${getInventoryQuantity(item.id)} saved</div>
      </div>
      <button class="btn-use-item" onclick="redeemSaved('${escapeHtml(item.id)}')">Trigger</button>`;
    list.appendChild(invCard);
  });
}

function filterCategory(category, buttonElement) {
  currentFilter = category;
  document.querySelectorAll(".category-btn,.category-pill").forEach((btn) => btn.classList.remove("active"));
  buttonElement?.classList.add("active");
  renderLibrary();
}

function handleSearch(query) {
  searchQuery = query;
  renderLibrary();
}

function toggleShimmer(forceState = null) {
  const loader = getEl("skeleton-loader");
  const toggleBtn = getEl("toggle-shimmer");
  if (!loader) return;
  const activate = forceState !== null ? forceState : !loader.classList.contains("active");
  loader.classList.toggle("active", activate);
  toggleBtn?.classList.toggle("active", activate);
}

function openDrawer(item) {
  selectedItem = item;
  selectedAction = inventory?.config?.quickPurchaseAction === "save" && identityShared ? "save" : "use_now";
  resetPlayer();
  (getEl("drawer-title", "sheet-title") || {}).textContent = item.name;
  (getEl("drawer-subtitle", "sheet-category") || {}).textContent = item.categoryLabel;
  (getEl("drawer-desc", "sheet-desc") || {}).textContent = item.description;
  renderDrawerActions();
  getEl("preview-drawer", "bottom-sheet")?.classList.add("open");
  getEl("drawer-backdrop", "sheet-backdrop")?.classList.add("open");
}

function renderDrawerActions() {
  const actionContainer = document.querySelector(".drawer-actions") || getEl("sheet-buy-btn")?.parentElement;
  if (!actionContainer || !selectedItem) return;
  actionContainer.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted);">
      <button class="category-btn ${selectedAction === "use_now" ? "active" : ""}" onclick="setDrawerAction('use_now')">Use now</button>
      <button class="category-btn ${selectedAction === "save" ? "active" : ""}" ${identityShared ? "" : "disabled"} onclick="setDrawerAction('save')">Save</button>
    </div>
    <button class="drawer-buy-btn bits sheet-btn-buy" onclick="buyWithBits(selectedItem, selectedAction)"><span>Buy with Bits • ${selectedItem.price}</span></button>
    <button class="drawer-buy-btn credits sheet-btn-buy" ${identityShared && getBalance() >= selectedItem.priceValue ? "" : "disabled"} onclick="buyWithCredits(selectedItem, selectedAction)"><span>Buy with Credits • ${selectedItem.priceValue}</span></button>
    ${!identityShared ? '<div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:8px;">Share identity to save items and use credits.</div>' : ''}`;
}

function setDrawerAction(action) {
  selectedAction = action === "save" && identityShared ? "save" : "use_now";
  renderDrawerActions();
}

function closeDrawer() {
  getEl("preview-drawer", "bottom-sheet")?.classList.remove("open");
  getEl("drawer-backdrop", "sheet-backdrop")?.classList.remove("open");
  resetPlayer();
}
const closeSheet = closeDrawer;

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity || !seconds) return "0:00";
  const floored = Math.max(0, Math.floor(seconds));
  return `${Math.floor(floored / 60)}:${String(floored % 60).padStart(2, "0")}`;
}

function updatePlayerTime() {
  try {
    const timeEl = getEl("player-time");
    if (!timeEl) return;
    const current = previewPlayer ? previewPlayer.currentTime : 0;
    
    let duration = 0;
    if (previewPlayer && !isNaN(previewPlayer.duration) && previewPlayer.duration !== Infinity && previewPlayer.duration > 0) {
      duration = previewPlayer.duration;
    } else if (selectedItem) {
      if (selectedItem.durationMs) {
        duration = selectedItem.durationMs / 1000;
      } else if (selectedItem.duration && typeof selectedItem.duration === 'string' && selectedItem.duration.includes(':')) {
        const parts = selectedItem.duration.split(':');
        duration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
      }
    }
    
    timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  } catch (err) {
    console.error("Error updating player time:", err);
  }
}

function togglePlayPreview() {
  if (!selectedItem?.mediaUrl) return;
  if (isPlaying) return resetPlayer();
  previewPlayer = new Audio(selectedItem.mediaUrl);
  previewPlayer.volume = 0.6;
  
  previewPlayer.addEventListener("loadedmetadata", updatePlayerTime);
  previewPlayer.addEventListener("timeupdate", updatePlayerTime);
  
  previewPlayer.play().catch(() => showToast("Preview blocked", "Tap again or check browser audio permissions.", "error"));
  isPlaying = true;
  getEl("player-widget", "mobile-player")?.classList.add("playing");
  playInterval = setInterval(() => {
    document.querySelectorAll(".wave-bar,.w-bar").forEach((bar) => {
      bar.style.height = Math.floor(Math.random() * 80 + 20) + "%";
    });
    updatePlayerTime();
  }, 140);
  previewPlayer.onended = resetPlayer;
}

function resetPlayer() {
  if (previewPlayer) {
    previewPlayer.pause();
    previewPlayer = null;
  }
  clearInterval(playInterval);
  isPlaying = false;
  getEl("player-widget", "mobile-player")?.classList.remove("playing");
  document.querySelectorAll(".wave-bar,.w-bar").forEach((bar) => (bar.style.height = "20%"));
  updatePlayerTime();
}

function quickPurchase(itemId) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (!item) return;
  // Free items (0 bits) trigger immediately without bits/credits flow
  if (item.priceValue === 0) {
    triggerFreeItem(item);
    return;
  }
  const config = inventory?.config || { quickPurchasePriority: "credits_first", quickPurchaseAction: "use_now" };
  const action = config.quickPurchaseAction === "save" && identityShared ? "save" : "use_now";
  if (identityShared && config.quickPurchasePriority === "credits_first" && getBalance() >= item.priceValue) {
    buyWithCredits(item, action);
    return;
  }
  buyWithBits(item, action);
}

function buyWithBits(item, action) {
  if (!window.Twitch?.ext?.bits?.useBits) {
    showToast("Bits unavailable", "Bits purchases are only available inside Twitch.", "info");
    return;
  }
  pendingBitsPurchase = { item, action };
  Twitch.ext.bits.useBits(item.sku);
}

async function triggerFreeItem(item) {
  try {
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/purchase`, {
      method: "POST",
      body: JSON.stringify({ sku: item.sku, transactionID: `free_${Date.now()}`, action: "use_now" }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showToast("Free", `${item.name} is queued on stream.`, "success");
  } catch (error) {
    showToast("Free item issue", error.message || "Unable to trigger free item.", "error");
    await refreshMe().catch(() => undefined);
  }
}

async function completeBitsPurchase(item, action, transaction) {
  try {
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/purchase`, {
      method: "POST",
      body: JSON.stringify({ sku: item.sku, transactionID: transaction?.transactionId || transaction?.id || `${Date.now()}`, action }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showToast(action === "save" ? "Saved" : "Triggered", `${item.name} is ${action === "save" ? "in your inventory" : "queued on stream"}.`, "success");
  } catch (error) {
    showToast("Purchase issue", error.message || "Unable to complete DimaFX purchase.", "error");
    await refreshMe().catch(() => undefined);
  }
}

async function buyWithCredits(item, action) {
  try {
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/use-credit`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    closeDrawer();
    showToast(action === "save" ? "Saved with credits" : "Triggered with credits", item.name, "success");
  } catch (error) {
    showToast("Credit purchase failed", error.message || "Unable to use credits.", "error");
    await refreshMe().catch(() => undefined);
  }
}

async function redeemSaved(itemId) {
  const item = products.find((candidate) => String(candidate.id) === String(itemId));
  if (!item) return;
  try {
    const data = await apiFetch(`/channels/${encodeURIComponent(channelID)}/items/${encodeURIComponent(item.id)}/redeem`, { method: "POST", body: "{}" });
    if (data?.inventory) inventory = data.inventory;
    await refreshMe();
    showToast("Triggered", `${item.name} was queued on stream.`, "success");
  } catch (error) {
    showToast("Redeem failed", error.message || "Unable to redeem saved item.", "error");
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
  if (balance) balance.textContent = getBalance().toLocaleString();
}

function renderUserConfigControls() {
  const settingsScreen = getEl("screen-config", "screen-settings");
  if (!settingsScreen || getEl("dimafx-user-config")) return;
  const config = inventory?.config || { quickPurchasePriority: "credits_first", quickPurchaseAction: "use_now" };
  const wrapper = document.createElement("div");
  wrapper.id = "dimafx-user-config";
  wrapper.className = "settings-group";
  wrapper.innerHTML = `
    <div class="settings-row"><div><div class="settings-label">Quick card payment</div><div class="settings-desc">Choose what the card button tries first.</div></div>
      <select id="quick-priority"><option value="credits_first">Credits first</option><option value="bits_first">Bits first</option></select></div>
    <div class="settings-row"><div><div class="settings-label">Quick card action</div><div class="settings-desc">Use immediately or save for later.</div></div>
      <select id="quick-action"><option value="use_now">Use now</option><option value="save">Save</option></select></div>`;
  settingsScreen.appendChild(wrapper);
  getEl("quick-priority").value = config.quickPurchasePriority;
  getEl("quick-action").value = config.quickPurchaseAction;
  getEl("quick-priority").onchange = saveUserConfig;
  getEl("quick-action").onchange = saveUserConfig;
}

async function saveUserConfig() {
  if (!identityShared) return showToast("Identity required", "Share your Twitch identity to save preferences.", "info");
  try {
    const updated = await apiFetch(`/channels/${encodeURIComponent(channelID)}/me/config`, {
      method: "PATCH",
      body: JSON.stringify({ quickPurchasePriority: getEl("quick-priority").value, quickPurchaseAction: getEl("quick-action").value }),
    });
    inventory = updated;
    renderLibrary();
    showToast("Preferences saved", "Your DimaFX quick action was updated.", "success");
  } catch (error) {
    showToast("Save failed", error.message || "Unable to save preferences.", "error");
  }
}

function triggerPurchase() {
  if (selectedItem) buyWithBits(selectedItem, selectedAction);
}

function showBitsBalance() {
  showToast("DimaFX Credits", `${getBalance()} credits available.`, "info");
}

function showToast(title, desc, type = "info") {
  const toast = getEl("toast");
  const titleEl = document.querySelector(".toast-title") || getEl("toast-title") || document.querySelector(".toast-alert-title");
  const descEl = getEl("toast-desc") || document.querySelector(".toast-alert-desc");
  const iconContainer = document.querySelector(".toast-icon") || document.querySelector(".toast-alert-icon");
  
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = desc;
  
  if (iconContainer) {
    if (type === "success") {
      iconContainer.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === "error") {
      iconContainer.innerHTML = `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    } else {
      // info
      iconContainer.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }
  }
  
  if (!toast) return;
  
  toast.classList.remove("info", "success", "error");
  toast.classList.add(type);
  toast.style.transform = ""; // clear any inline style overrides
  
  toast.classList.add("show");
  
  if (window.toastTimeout) clearTimeout(window.toastTimeout);
  window.toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 4000); // disappear after 4s (between 3 and 5 seconds)
}
