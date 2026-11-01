import test from 'node:test';
import assert from 'node:assert/strict';
import { docsLink, renderMarkdown } from '../src/lib/assistant-markdown.mjs';

const md = (source) => renderMarkdown(source, { link: (url) => docsLink(url) });

test('escapes HTML and drops unsafe links', () => {
  const html = md('<img src=x onerror=alert(1)> **<b>hi</b>** [x](javascript:alert(1)) [y](data:text/html,hi) `<script>`');
  assert.doesNotMatch(html, /<img|<b>|<script>|javascript:|data:text/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>&lt;b&gt;hi&lt;\/b&gt;<\/strong>/);
  assert.match(html, /<code>&lt;script&gt;<\/code>/);
  assert.match(html, /> x y </, 'unsafe links keep their text only');
  assert.doesNotMatch(md('[a](https://x.test/" onmouseover="alert(1))'), /" onmouseover/);
});

test('docs links become same-site paths; .txt exports map to pages; others open in a new tab', () => {
  const html = md('[TTS](https://docs.domdimabot.com/tts/index.txt#voices) [Plans](https://docs.domdimabot.com/plans/) [Twitch](https://twitch.tv/x) [rel](/es/tts/)');
  assert.match(html, /<a href="\/tts\/#voices">TTS<\/a>/);
  assert.match(html, /<a href="\/plans\/">Plans<\/a>/);
  assert.match(html, /<a href="https:\/\/twitch\.tv\/x" target="_blank" rel="noopener noreferrer nofollow">Twitch<\/a>/);
  assert.match(html, /<a href="\/es\/tts\/">rel<\/a>/);
});

test('numbered steps with bold, nested bullets, and an indented code block inside an item', () => {
  const html = md(`To make DomDimaBot read chat aloud:

1. **Enable TTS:** Open **Modules → Text to Speech**.
2. **Connect OBS:** Copy the **Speech URL**.
   - Keep it active while streaming.
3. **Test it:** In Twitch chat, type:

   \`\`\`text
   !s Hello chat!
   \`\`\`

4. Done.`);
  assert.match(html, /^<p>To make DomDimaBot read chat aloud:<\/p><ol>/);
  assert.equal((html.match(/<li>/g) || []).length, 5, '4 steps + 1 nested bullet');
  assert.match(html, /<strong>Enable TTS:<\/strong> Open <strong>Modules → Text to Speech<\/strong>\./);
  assert.match(html, /Speech URL<\/strong>\.<\/p><ul><li>Keep it active while streaming\.<\/li><\/ul><\/li>/);
  assert.match(html, /<pre data-lang="text"><code>!s Hello chat!<\/code><\/pre>/);
  assert.match(html, /<li><p>Done\.<\/p><\/li><\/ol>$/);
});

test('GFM tables, wrapped for horizontal scrolling on phones', () => {
  const html = md(`| Feature | Premium | Pro |
|---|---:|---:|
| Price | $6/month | $15/month |
| Cooldown | \`3\` seconds | 1 second |`);
  assert.match(html, /^<div class="da-md-table"><table><thead><tr><th>Feature<\/th><th>Premium<\/th><th>Pro<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><code>3<\/code> seconds<\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});

test('headings, quotes, rules, italics, and line breaks inside paragraphs', () => {
  const html = md('### Dashboard setup\nLine one\nline two\n\n> Note: *careful* with snake_case_names\n\n---\n\n## Big');
  assert.match(html, /^<h4>Dashboard setup<\/h4><p>Line one<br>line two<\/p>/);
  assert.match(html, /<blockquote><p>Note: <em>careful<\/em> with snake_case_names<\/p><\/blockquote><hr><h3>Big<\/h3>$/);
});

test('code spans and fences keep their content literally', () => {
  assert.match(md('Use `$(ban &p1 600)` or `*not bold*`'), /<code>\$\(ban &amp;p1 600\)<\/code> or <code>\*not bold\*<\/code>/);
  const fence = md('```\n!cc -cd=10 hello **Hi** $(user)\n<b>\n```');
  assert.equal(fence, '<div class="da-code"><div class="da-code__bar"><span class="da-code__lang"></span></div><pre><code>!cc -cd=10 hello **Hi** $(user)\n&lt;b&gt;</code></pre></div>');
  assert.match(md('```js\nx\n```'), /<span class="da-code__lang">js<\/span>/, 'real languages are labelled; text is not');
});

test('half-streamed input renders without throwing', () => {
  const partial = '1. **Open** the dash\n2. Type:\n   ```text\n   !s hel';
  const html = md(partial);
  assert.match(html, /<pre data-lang="text"><code>!s hel<\/code><\/pre>/);
  for (let cut = 0; cut <= partial.length; cut++) md(partial.slice(0, cut));
  assert.equal(md('**unclosed'), '<p>**unclosed</p>');
  assert.equal(md(''), '');
});
