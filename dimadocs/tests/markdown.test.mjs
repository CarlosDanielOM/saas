import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkGfm from 'remark-gfm';
import { pagePath, textPath, toMarkdown } from '../src/lib/markdown.mjs';

const sourceParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const outputParser = unified().use(remarkParse).use(remarkGfm);
const root = new URL('../src/content/docs/', import.meta.url);
const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.mdx'));
const id = (file) => file.replace(/\.mdx$/, '');
const paths = new Set(files.map((file) => pagePath(id(file)).replace(/\/$/, '') || '/'));
function nodes(tree, type) {
  return [...(tree.type === type ? [tree] : []), ...(tree.children || []).flatMap((child) => nodes(child, type))];
}

test('root and nested index URLs agree with Starlight normalization', () => {
  for (const entry of ['', 'index']) assert.equal(textPath(entry), '/index.txt');
  for (const entry of ['es', 'es/index']) assert.equal(textPath(entry), '/es/index.txt');
  for (const entry of ['commands', 'commands/index']) assert.equal(textPath(entry), '/commands/index.txt');
});

for (const file of files) {
  test(`preserves every code example, inline literal, and table in ${file}`, async () => {
    const body = (await readFile(new URL(file, root), 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const source = sourceParser.parse(body);
    const markdown = toMarkdown(body, `https://docs.domdimabot.com${pagePath(id(file))}`, paths);
    const output = outputParser.parse(markdown);
    for (const type of ['code', 'inlineCode']) {
      assert.deepEqual(nodes(output, type).map((node) => node.value), nodes(source, type).map((node) => node.value));
    }
    assert.equal(nodes(output, 'table').length, nodes(source, 'table').length);
    assert.doesNotMatch(markdown, /import \{.*@astrojs|<\/?(?:Aside|Tabs|TabItem|LinkCard|CardGrid|Steps|LinkButton)\b/);
    for (const link of nodes(output, 'link')) {
      const url = new URL(link.url);
      assert.ok(['https:', 'http:', 'mailto:'].includes(url.protocol), link.url);
      if (url.origin === 'https://docs.domdimabot.com' && url.pathname.endsWith('/index.txt')) {
        assert.ok(paths.has(url.pathname.replace(/\/index\.txt$/, '') || '/'), link.url);
      }
    }
    for (const node of [...nodes(source, 'mdxJsxFlowElement'), ...nodes(source, 'mdxJsxTextElement')]) {
      for (const name of node.name === 'TabItem' ? ['label'] : node.name === 'LinkCard' ? ['title', 'description'] : []) {
        const value = node.attributes.find((attr) => attr.name === name)?.value;
        if (value) assert.ok(markdown.includes(value), `${name}: ${value}`);
      }
    }
  });
}

test('rewrites relative links and anchors, keeps external URLs, and fails on unsupported dynamic content', () => {
  const result = toMarkdown('[Syntax](../syntax/#arrays) [Website](https://domdimabot.com)', 'https://docs.domdimabot.com/commands/advanced/functions/', paths);
  assert.ok(result.includes('https://docs.domdimabot.com/commands/advanced/syntax/index.txt#arrays'));
  assert.ok(result.includes('(https://domdimabot.com/)'));
  assert.throws(() => toMarkdown('{unknownValue}', 'https://docs.domdimabot.com/', paths), /Unsupported dynamic MDX/);
  assert.throws(() => toMarkdown('<NewComponent />', 'https://docs.domdimabot.com/', paths), /Unsupported MDX component/);
});
