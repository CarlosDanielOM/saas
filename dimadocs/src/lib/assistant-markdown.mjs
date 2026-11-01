// Safe Markdown → HTML for docs assistant answers.
//
// Everything is HTML-escaped first; only the syntax below becomes markup, so model
// output can never inject tags or scripts. Tolerates half-written input while an
// answer streams (an unclosed code fence renders as code; unclosed ** stays literal).
//
// Supported: paragraphs, #–###### headings, - * + and 1. lists (nested, with code/
// paragraphs inside items), fenced code, GFM tables, > quotes, --- rules,
// `code`, **bold**, *italic*/_italic_, [links](url).

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?/;

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Default link policy: http(s), mailto, and same-site paths only. */
export function safeHref(url) {
  const value = String(url).trim();
  if (/^(https?:|mailto:)/i.test(value) || /^[/#]/.test(value)) return value;
  return null;
}

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isBlank = (line) => !line.trim();
const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);

function inline(text, options) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = String(text);

  // Code spans first: nothing inside them is formatted.
  out = out.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  // Links: [text](url "title"?)
  out = out.replace(/\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (whole, label, url) => {
    const link = options.link(url);
    const labelHtml = inline(label, options);
    if (!link) return keep(labelHtml);
    const attrs = link.external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '';
    return keep(`<a href="${escapeHtml(link.href)}"${attrs}>${labelHtml}</a>`);
  });
  out = escapeHtml(out);
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function renderList(lines, start, options) {
  const first = LIST.exec(lines[start]);
  const indent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
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
      const lazy = !startsBlock(line) && body.length && !isBlank(body.at(-1)) && !FENCE.test(body[0]);
      if (!deeper && !lazy) break;
      body.push(line.replace(new RegExp(`^\\s{0,${offset}}`), ''));
      i++;
    }
    items.push(body);
    // Blank line between siblings: keep the list going.
    if (i < lines.length && isBlank(lines[i])) {
      let next = i;
      while (next < lines.length && isBlank(lines[next])) next++;
      const sibling = next < lines.length && LIST.exec(lines[next]);
      if (sibling && indentOf(sibling[1]) <= indent + 1 && indentOf(sibling[1]) >= indent && /\d/.test(sibling[2]) === ordered) {
        i = next;
        loose = true;
      }
    }
  }

  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const open = ordered ? `<ol${startNumber !== 1 ? ` start="${startNumber}"` : ''}>` : '<ul>';
  const html = items.map((body) => {
    let inner = renderBlocks(body, options);
    // Tight list: a single paragraph doesn't need a <p> wrapper.
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    return `<li>${inner}</li>`;
  }).join('');
  return { html: `${open}${html}${ordered ? '</ol>' : '</ul>'}`, next: i };
}

function renderBlocks(lines, options) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const code = [];
      const pad = indentOf(line);
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++].replace(new RegExp(`^\\s{0,${pad}}`), ''));
      i++; // closing fence (or end of a still-streaming answer)
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : '';
      out.push(`<pre${lang}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const tag = heading[1].length <= 2 ? 'h3' : heading[1].length === 3 ? 'h4' : 'h5';
      out.push(`<${tag}>${inline(heading[2], options)}</${tag}>`);
      i++;
      continue;
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cells = (row, tag) => head.map((_, index) => `<${tag}>${inline(row[index] ?? '', options)}</${tag}>`).join('');
      out.push(`<div class="da-md-table"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
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
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))) {
      paragraph.push(lines[i++].trim());
    }
    out.push(`<p>${paragraph.map((part) => inline(part, options)).join('<br>')}</p>`);
  }
  return out.join('');
}

/**
 * @param {string} source Markdown
 * @param {{ link?: (url: string) => ({ href: string, external?: boolean } | null) }} [options]
 *   `link` decides each link's final href; return null to show the text without a link.
 */
export function renderMarkdown(source, options = {}) {
  const link = options.link ?? ((url) => {
    const href = safeHref(url);
    return href ? { href, external: /^https?:/i.test(href) } : null;
  });
  return renderBlocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), { link });
}

/**
 * Link policy for the docs site: docs pages become same-site paths (so they work in
 * previews too, and `.txt` exports map to the readable page); other http(s) links open
 * in a new tab; anything else (javascript:, data:, …) loses its link.
 */
export function docsLink(url, docsHost = 'docs.domdimabot.com') {
  const href = safeHref(url);
  if (!href) return null;
  if (/^[/#]/.test(href)) return { href: href.replace(/\/index\.txt(?=$|[#?])/, '/'), external: false };
  if (/^mailto:/i.test(href)) return { href, external: false };
  try {
    const parsed = new URL(href);
    if (parsed.hostname === docsHost) {
      const path = parsed.pathname.replace(/\/index\.txt$/, '/');
      return { href: path + parsed.search + parsed.hash, external: false };
    }
    return { href: parsed.href, external: true };
  } catch {
    return null;
  }
}
