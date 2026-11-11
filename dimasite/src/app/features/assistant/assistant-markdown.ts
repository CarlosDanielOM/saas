/**
 * Safe Markdown → HTML for assistant answers (port of `dimadocs/src/lib/assistant-markdown.mjs`).
 *
 * Everything is HTML-escaped first; only the syntax below becomes markup, so model output can
 * never inject tags or scripts. Tolerates half-written input while an answer streams (an
 * unclosed code fence renders as code; unclosed ** stays literal). Import-free and pure.
 *
 * Supported: paragraphs, headings (rendered small), - * + and 1. lists (nested), fenced code
 * (with a bar the component fills with a Copy button), GFM tables, > quotes, --- rules,
 * `code`, **bold**, *italic* / _italic_, [links](url). Links: only `https:` and docs paths.
 */

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?/;

export const ASSISTANT_DOCS_ORIGIN = 'https://docs.domdimabot.com';

export interface MarkdownLink {
  href: string;
}

export type LinkPolicy = (url: string) => MarkdownLink | null;

interface Options {
  link: LinkPolicy;
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Link policy for the site assistant: `https:` links, and docs paths (`/guides/...`) which
 * point at the docs site. Everything else (http:, javascript:, data:, mailto:, //host) loses
 * its link and shows as text. All links open in a new tab with rel="noopener noreferrer".
 */
export function assistantLink(url: string, docsOrigin = ASSISTANT_DOCS_ORIGIN): MarkdownLink | null {
  const value = String(url).trim();
  if (/^https:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
      if (parsed.hostname === new URL(docsOrigin).hostname) parsed.pathname = parsed.pathname.replace(/\/index\.txt$/, '/');
      return { href: parsed.href };
    } catch {
      return null;
    }
  }
  if (/^\/(?![/\\])/.test(value)) {
    return { href: docsOrigin + value.replace(/\/index\.txt(?=$|[#?])/, '/') };
  }
  return null;
}

const indentOf = (line: string): number => (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
const isBlank = (line: string): boolean => !line.trim();
const startsBlock = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);

function inline(text: string, options: Options): string {
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  // Stray NULs from the model would collide with the stash markers.
  let out = String(text).replace(/\u0000/g, '');

  // Code spans first: nothing inside them is formatted.
  out = out.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_whole, _ticks, code: string) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  // Links: [text](url "title"?)
  out = out.replace(/\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (_whole, label: string, url: string) => {
    const link = options.link(url);
    const labelHtml = inline(label, options);
    if (!link) return keep(labelHtml);
    return keep(`<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`);
  });
  out = escapeHtml(out);
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => stash[Number(index)] ?? '');
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function renderList(lines: string[], start: number, options: Options): { html: string; next: number } {
  const first = LIST.exec(lines[start])!;
  const indent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  let loose = false;

  while (i < lines.length) {
    const marker = LIST.exec(lines[i]);
    if (!marker || indentOf(marker[1]) > indent + 1 || /\d/.test(marker[2]) !== ordered) break;
    if (indentOf(marker[1]) < indent) break;
    const offset = marker[0].length;
    const body = [lines[i].slice(offset)];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        // A blank line continues the item only if more indented content follows.
        let next = i + 1;
        while (next < lines.length && isBlank(lines[next])) next++;
        if (next < lines.length && indentOf(lines[next]) > indent && !(LIST.test(lines[next]) && indentOf(lines[next]) <= indent + 1)) {
          for (; i < next; i++) body.push('');
          loose = true;
          continue;
        }
        break;
      }
      const deeper = indentOf(line) > indent + 1;
      const lazy = !startsBlock(line) && body.length > 0 && !isBlank(body[body.length - 1]) && !FENCE.test(body[0]);
      if (!deeper && !lazy) break;
      body.push(line.replace(new RegExp(`^\\s{0,${offset}}`), ''));
      i++;
    }
    items.push(body);
    // Blank line between siblings: keep the list going.
    if (i < lines.length && isBlank(lines[i])) {
      let next = i;
      while (next < lines.length && isBlank(lines[next])) next++;
      const sibling = next < lines.length ? LIST.exec(lines[next]) : null;
      if (sibling && indentOf(sibling[1]) <= indent + 1 && indentOf(sibling[1]) >= indent && /\d/.test(sibling[2]) === ordered) {
        i = next;
        loose = true;
      }
    }
  }

  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const open = ordered ? `<ol${startNumber !== 1 ? ` start="${startNumber}"` : ''}>` : '<ul>';
  const html = items
    .map((body) => {
      let inner = renderBlocks(body, options);
      // Tight list: a single paragraph doesn't need a <p> wrapper.
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return `<li>${inner}</li>`;
    })
    .join('');
  return { html: `${open}${html}${ordered ? '</ol>' : '</ul>'}`, next: i };
}

function renderBlocks(lines: string[], options: Options): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const code: string[] = [];
      const pad = indentOf(line);
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++].replace(new RegExp(`^\\s{0,${pad}}`), ''));
      i++; // closing fence (or end of a still-streaming answer)
      const label = fence[2] && !/^(text|txt|plain|plaintext)$/i.test(fence[2]) ? escapeHtml(fence[2]) : '';
      // The bar above the scrolling <pre> holds the language and the Copy button, so the button
      // never covers code or slides when the code scrolls sideways.
      out.push(`<div class="am-code"><div class="am-code__bar"><span class="am-code__lang">${label}</span></div><pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const tag = heading[1].length <= 2 ? 'h4' : heading[1].length === 3 ? 'h5' : 'h6';
      out.push(`<${tag}>${inline(heading[2], options)}</${tag}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cells = (row: string[], tag: 'th' | 'td') => head.map((_cell, index) => `<${tag}>${inline(row[index] ?? '', options)}</${tag}>`).join('');
      out.push(`<div class="am-table"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''));
      out.push(`<blockquote>${renderBlocks(quoted, options)}</blockquote>`);
      continue;
    }

    if (LIST.test(line)) {
      const list = renderList(lines, i, options);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !startsBlock(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))
    ) {
      paragraph.push(lines[i++].trim());
    }
    out.push(`<p>${paragraph.map((part) => inline(part, options)).join('<br>')}</p>`);
  }
  return out.join('');
}

/** Render assistant Markdown to safe HTML. `link` decides each link's final href (null = text only). */
export function renderAssistantMarkdown(source: string, link: LinkPolicy = (url) => assistantLink(url)): string {
  return renderBlocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), { link });
}
