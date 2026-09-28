import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const response = process.env.TRIGGER_OVERLAY_HTML
  ? null
  : await fetch('http://127.0.0.1:3000/overlays/triggers/fixture?preview=1');
if (response) assert.equal(response.status, 200, 'candidate API serves the trigger overlay');
const html = response
  ? await response.text()
  : readFileSync(process.env.TRIGGER_OVERLAY_HTML, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'trigger overlay inline script exists');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.parent = null;
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  dispatch(name) { this.listeners.get(name)?.(); }
}

const body = new Element('body');
const container = new Element('div');
const listeners = new Map();
const timers = new Map();
let timerId = 0;
const window = {
  location: { pathname: '/overlays/triggers/fixture', search: '?preview=1' },
  addEventListener(name, listener) { listeners.set(name, listener); },
  setTimeout(listener, delay) { timers.set(++timerId, { listener, delay }); return timerId; },
  clearTimeout(id) { timers.delete(id); }
};
const document = {
  body,
  getElementById(id) { return id === 'triggerContainer' ? container : null; },
  createElement(tagName) { return new Element(tagName); }
};

vm.runInNewContext(script, { window, document, URLSearchParams, console }, { filename: 'trigger.html' });
const preview = listeners.get('message');
assert.ok(preview, 'preview listener exists');
function send(mediaType, url) {
  preview({ data: { type: 'trigger-preview', payload: { mediaType, url, volume: 50 } } });
}

for (const mediaType of ['image/png', 'image/gif']) {
  send(mediaType, `https://fixture.invalid/${mediaType.split('/')[1]}`);
  const image = container.children.at(-1);
  assert.equal(image?.tagName, 'img', `${mediaType} creates an image`);
  assert.equal(image.src, `https://fixture.invalid/${mediaType.split('/')[1]}`);
  image.dispatch('load');
  const timer = [...timers.values()].at(-1);
  assert.ok(timer && timer.delay > 0, `${mediaType} has a display limit`);
  timer.listener();
  assert.ok(!container.children.includes(image), `${mediaType} is removed after display`);
  timers.clear();
}

send('image/webp', 'https://fixture.invalid/broken.webp');
const brokenImage = container.children.at(-1);
brokenImage.dispatch('error');
assert.ok(!container.children.includes(brokenImage), 'failed image is removed');

send('video/mp4', 'https://fixture.invalid/video.mp4');
assert.equal(container.children.at(-1)?.tagName, 'video', 'video playback remains available');
send('audio/mpeg', 'https://fixture.invalid/audio.mp3');
assert.equal(body.children.at(-1)?.tagName, 'audio', 'audio playback remains available');

console.log('PASS trigger overlay renders PNG and GIF, removes loaded/failed images, and retains video/audio playback');
