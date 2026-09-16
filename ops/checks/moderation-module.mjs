#!/usr/bin/env node
/**
 * Behavior check for the dimasite "Chat Moderation" module view.
 *
 * Runs against the candidate bundle served by `saas-ops verify site-<run>`.
 * Confirms the built app registers the moderation module route, loads its
 * lazy chunk, and that the chunk contains the real API contract and editor
 * markup for the feature (not just a generic health/HTML check).
 */
const base = process.env.SAAS_PREVIEW_URL;

if (!base) {
  throw new Error('SAAS_PREVIEW_URL is not set');
}

async function getText(path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('javascript') && !contentType.includes('html') && !contentType.includes('text')) {
    throw new Error(`GET ${path} -> unexpected content-type ${contentType}`);
  }
  return response.text();
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected built bundle to contain ${JSON.stringify(needle)}`);
  }
}

const shell = await getText('/index.csr.html');
assertIncludes(shell.toLowerCase(), '<html', 'CSR shell');
assertIncludes(shell, '<app-root', 'CSR shell');

const mainMatch = shell.match(/src="(main-[A-Z0-9]+\.js)"/);
if (!mainMatch) {
  throw new Error('Could not locate the main bundle in index.csr.html');
}
const mainBundle = await getText('/' + mainMatch[1]);

assertIncludes(mainBundle, 'path:"moderation"', 'route registration');
assertIncludes(mainBundle, '["moderation",null]', 'route-shape whitelist');

const chunkMatch = mainBundle.match(/path:"moderation"[^}]*?import\("\.\/(chunk-[A-Z0-9]+\.js)"\)/);
if (!chunkMatch) {
  throw new Error('Could not locate the moderation lazy chunk reference in the main bundle');
}

const moderationChunk = await getText('/' + chunkMatch[1]);
for (const marker of [
  '/moderation/',
  'moderation:manage',
  'moderation.rules.title',
  'moderation.toasts.savedTitle',
  'lf-rule',
  // Comma-separated list entry: split on commas + blur/Enter commit path.
  'addListItems',
  'onListInput',
  'pendingListInput',
  'split(",")'
]) {
  assertIncludes(moderationChunk, marker, 'moderation chunk');
}

const landing = await getText('/');
assertIncludes(landing.toLowerCase(), '<html', 'landing page');

console.log(`Moderation module bundle check passed (chunk ${chunkMatch[1]}).`);
