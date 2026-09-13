import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const writer = unified().use(remarkGfm).use(remarkStringify, { fences: true });
const text = (value) => ({ type: 'text', value });
const paragraph = (children) => ({ type: 'paragraph', children });
const attribute = (node, name) => node.attributes?.find((a) => a.name === name)?.value;

export const pagePath = (id) => {
  const slug = id.replace(/(^|\/)index$/, '').replace(/\/$/, '');
  return slug ? `/${slug}/` : '/';
};
export const textPath = (id) => `${pagePath(id)}index.txt`;

// Convert the parsed MDX tree, never regex-strip source: command punctuation,
// fenced examples, tables, all tabs, and admonitions must survive verbatim.
export function toMarkdown(body, canonical, publishedPaths) {
  function url(value) {
    const target = new URL(value, canonical);
    if (target.origin === new URL(canonical).origin) {
      const path = target.pathname.replace(/\/$/, '') || '/';
      if (publishedPaths.has(path)) target.pathname = `${path === '/' ? '/' : `${path}/`}index.txt`;
    }
    return target.href;
  }
  function inline(nodes) {
    return nodes.flatMap((node) => node.children && !['link', 'strong', 'emphasis', 'delete'].includes(node.type)
      ? [...inline(node.children), text(' ')] : [node]);
  }
  function blocks(nodes) {
    const output = [];
    let pending = [];
    const flush = () => { if (pending.length) output.push(paragraph(pending)); pending = []; };
    for (const node of nodes) {
      if (['text', 'inlineCode', 'link', 'strong', 'emphasis', 'delete', 'break', 'image'].includes(node.type)) pending.push(node);
      else { flush(); output.push(node); }
    }
    flush();
    return output;
  }
  function convert(node) {
    if (node.type === 'mdxjsEsm') return [];
    if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') {
      // Static string expressions are safe; dynamic content needs an explicit
      // adapter so a future docs component cannot silently lose information.
      const expression = node.data?.estree?.body?.[0]?.expression;
      if (expression?.type === 'Literal') return [text(String(expression.value))];
      throw new Error(`Unsupported dynamic MDX in ${canonical}: ${node.value}`);
    }
    const children = node.children?.flatMap(convert);
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      const name = node.name;
      if (attribute(node, 'aria-hidden') === 'true') return [];
      if (name === 'a' || name === 'LinkButton' || name === 'LinkCard') {
        const href = attribute(node, 'href');
        if (typeof href !== 'string') throw new Error(`Non-static link in ${canonical}`);
        const link = [{ type: 'link', url: url(href), children: name === 'LinkCard' ? [text(String(attribute(node, 'title')))] : inline(children) },
          ...(name === 'LinkCard' && attribute(node, 'description') ? [text(`: ${attribute(node, 'description')}`)] : [])];
        return node.type === 'mdxJsxFlowElement' ? [paragraph(link)] : link;
      }
      if (/^h[1-6]$/.test(name)) return [{ type: 'heading', depth: Number(name[1]), children: inline(children) }];
      if (name === 'p') return [paragraph(inline(children))];
      if (name === 'ul' || name === 'ol') return [{ type: 'list', ordered: name === 'ol', spread: false, children }];
      if (name === 'li') return [{ type: 'listItem', spread: false, children: blocks(children) }];
      if (name === 'Aside') {
        const label = attribute(node, 'title') || attribute(node, 'type') || 'Note';
        return [{ type: 'blockquote', children: [paragraph([text(`${label}:`)]), ...blocks(children)] }];
      }
      if (name === 'TabItem') return [paragraph([{ type: 'strong', children: [text(String(attribute(node, 'label') || 'Tab'))] }]), ...blocks(children)];
      if (['div', 'section', 'span', 'Tabs', 'Steps', 'CardGrid', null].includes(name)) return children;
      throw new Error(`Unsupported MDX component ${name} in ${canonical}`);
    }
    const result = { ...node, ...(children ? { children } : {}) };
    if (['link', 'image', 'definition'].includes(node.type)) result.url = url(node.url);
    if (node.type === 'root') result.children = blocks(children);
    return [result];
  }
  return writer.stringify(convert(parser.parse(body))[0]);
}
