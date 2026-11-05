import type { CodeFiles } from './custom-widget-code-drafts';

/** Starters offered by "New widget". Texts the streamer sees (setting labels, alert lines) come in their language. */
export type StarterKind = 'dima' | 'streamelements';
export interface StarterTexts {
  groupLook: string; groupChat: string; groupAlerts: string;
  accent: string; text: string; size: string; max: string; alerts: string;
  /** `{name}` and `{amount}` are filled in by the widget. */
  follow: string; sub: string; gift: string; bits: string; raid: string;
}

const html = `<div class="chat" id="chat"></div>
<div class="banner" id="banner" hidden></div>
`;

function fields(t: StarterTexts): string {
  return JSON.stringify({
    accentColor: { type: 'colorpicker', label: t.accent, value: '#8b5cf6', group: t.groupLook },
    textColor: { type: 'colorpicker', label: t.text, value: '#ffffff', group: t.groupLook },
    fontSize: { type: 'slider', label: t.size, value: 22, min: 14, max: 48, step: 1, group: t.groupLook },
    maxMessages: { type: 'number', label: t.max, value: 8, min: 1, max: 30, group: t.groupChat },
    showAlerts: { type: 'checkbox', label: t.alerts, value: true, group: t.groupAlerts }
  }, null, 2) + '\n';
}

const baseCss = `* { box-sizing: border-box; }
body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; color: var(--text); }
.chat { position: absolute; inset: auto 0 0 0; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.row { padding: 8px 12px; border-radius: 14px; background: rgba(15, 17, 21, 0.72); font-size: var(--size); line-height: 1.35;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); overflow-wrap: anywhere; animation: pop 0.25s ease-out; }
.name { margin-right: 6px; font-weight: 800; }
.row img { height: 1.4em; vertical-align: middle; }
.banner { position: absolute; top: 12px; left: 12px; right: 12px; padding: 14px 16px; border-radius: 16px; background: var(--accent);
  color: #fff; font-size: calc(var(--size) * 1.1); font-weight: 800; text-align: center; animation: pop 0.3s ease-out; }
@keyframes pop { from { transform: translateY(8px); opacity: 0; } }
`;

function dimaFiles(name: string, t: StarterTexts): CodeFiles {
  const texts = JSON.stringify({ follow: t.follow, sub: t.sub, resub: t.sub, gift: t.gift, bits: t.bits, raid: t.raid }, null, 2);
  return {
    manifest: JSON.stringify({ engine: 'dima', api: 1, name, version: '1.0.0', description: 'Chat messages with emotes and a banner for follows, subs, Bits and raids.', uses: ['chat', 'alerts'] }, null, 2) + '\n',
    html,
    // Colours and sizes are CSS variables set from the settings in the script, so changes apply without a reload.
    css: `:root { --accent: #8b5cf6; --text: #ffffff; --size: 22px; }\n` + baseCss,
    js: `// Dima SDK starter: chat messages and a banner for follows, subs, Bits and raids.
// Guide: https://docs.domdimabot.com/building-custom-widgets-dima-sdk/
const chat = document.getElementById('chat');
const banner = document.getElementById('banner');
const TEXT = ${texts};
let settings = Dima.fields;

function applySettings(next) {
  settings = next;
  const root = document.documentElement.style;
  root.setProperty('--accent', settings.accentColor);
  root.setProperty('--text', settings.textColor);
  root.setProperty('--size', settings.fontSize + 'px');
}
applySettings(Dima.fields);
Dima.on('fields', applySettings); // changed in Studio: no reload needed

Dima.on('chat', message => {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = message.id;
  row.dataset.user = message.user.id;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = message.user.name;
  if (message.user.color) name.style.color = message.user.color;
  row.append(name);
  row.insertAdjacentHTML('beforeend', Dima.html(message)); // escaped text + emotes
  chat.append(row);
  while (chat.children.length > settings.maxMessages) chat.firstElementChild.remove();
});
Dima.on('chat.delete', event => chat.querySelector('[data-id="' + CSS.escape(event.messageId) + '"]')?.remove());
Dima.on('chat.clear', event => {
  for (const row of [...chat.children]) if (!event.userId || row.getAttribute('data-user') === event.userId) row.remove();
});

let hideTimer;
Dima.on('alert', alert => {
  const line = TEXT[alert.type];
  if (!settings.showAlerts || !line) return;
  banner.textContent = line.replace('{name}', alert.user ? alert.user.name : '?').replace('{amount}', String(alert.amount));
  banner.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { banner.hidden = true; }, 5000);
});

Dima.ready().then(context => Dima.log('Ready on ' + context.channel.name));
`,
    fields: fields(t),
    data: '{}\n'
  };
}

function seFiles(t: StarterTexts): CodeFiles {
  const texts = JSON.stringify({ 'follower-latest': t.follow, 'subscriber-latest': t.sub, 'cheer-latest': t.bits, 'raid-latest': t.raid }, null, 2);
  return {
    manifest: '',
    html,
    // StreamElements style: {key} placeholders are replaced with the settings (the widget reloads when they change).
    css: `:root { --accent: {accentColor}; --text: {textColor}; --size: {fontSize}px; }\n` + baseCss,
    js: `// StreamElements-compatible starter: runs here and on StreamElements.
// Guide: https://docs.domdimabot.com/building-custom-widgets-dima-sdk/
const chat = document.getElementById('chat');
const banner = document.getElementById('banner');
const TEXT = ${texts};
let fieldData = {};

window.addEventListener('onWidgetLoad', obj => { fieldData = obj.detail.fieldData; });

window.addEventListener('onEventReceived', obj => {
  const listener = obj.detail.listener, event = obj.detail.event;
  if (listener === 'message') return addMessage(event.data, event.renderedText);
  if (listener === 'delete-message') return chat.querySelector('[data-id="' + CSS.escape(event.msgId) + '"]')?.remove();
  if (listener === 'delete-messages') {
    for (const row of [...chat.children]) if (row.getAttribute('data-user') === event.userId) row.remove();
    return;
  }
  if (fieldData.showAlerts && TEXT[listener]) showBanner(TEXT[listener].replace('{name}', event.name).replace('{amount}', String(event.amount)));
});

function addMessage(data, renderedText) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = data.msgId;
  row.dataset.user = data.userId;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = data.displayName;
  if (data.displayColor) name.style.color = data.displayColor;
  row.append(name);
  row.insertAdjacentHTML('beforeend', renderedText); // escaped text + emotes
  chat.append(row);
  while (chat.children.length > fieldData.maxMessages) chat.firstElementChild.remove();
}

let hideTimer;
function showBanner(text) {
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { banner.hidden = true; }, 5000);
}
`,
    fields: fields(t),
    data: '{}\n'
  };
}

export function starterFiles(kind: StarterKind, name: string, texts: StarterTexts): CodeFiles {
  return kind === 'dima' ? dimaFiles(name, texts) : seFiles(texts);
}
