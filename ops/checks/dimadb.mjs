// Runs only inside a disposable candidate with an empty, temporary DATA_DIR.
import assert from 'node:assert/strict';
const health = await fetch('http://127.0.0.1/api/health');
assert.equal(health.status, 200);
assert.match(health.headers.get('content-type'), /json/);
const page = await fetch('http://127.0.0.1/');
assert.equal(page.status, 200);
assert.match(await page.text(), /<html/i);
console.log('dimadb: API health and built frontend passed; add checks for the changed feature.');
