import { getCollection } from 'astro:content';
import { pagePath, textPath, toMarkdown } from './markdown.mjs';

export async function documents(site: URL) {
  const entries = (await getCollection('docs', ({ data }) => !data.draft))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const paths = new Set(entries.map(({ id }) => pagePath(id).replace(/\/$/, '') || '/'));
  return entries.map((entry) => {
    const canonical = new URL(pagePath(entry.id), site).href;
    const markdown = new URL(textPath(entry.id), site).href;
    return {
      id: entry.id,
      title: entry.data.title,
      description: entry.data.description || '',
      language: entry.id === 'es' || entry.id.startsWith('es/') ? 'es' : 'en',
      canonical,
      markdown,
      content: `# ${entry.data.title}\n\n${entry.data.description || ''}\n\nSource: ${canonical}\nLanguage: ${entry.id.startsWith('es/') || entry.id === 'es' ? 'es' : 'en'}\nDocumentation index: ${new URL('/llms.txt', site).href}\n\n${toMarkdown(entry.body || '', canonical, paths)}`,
    };
  });
}

export function indexText(docs: Awaited<ReturnType<typeof documents>>, site: URL, language = 'en') {
  const selected = docs.filter((doc) => doc.language === language);
  const prefix = language === 'es' ? 'es/' : '';
  const priority = ['ai-assistants', 'commands/overview', 'commands/advanced/syntax', 'commands/advanced/functions', 'commands/advanced/execution', 'commands/advanced/recipes'];
  const start = priority.map((id) => selected.find((doc) => doc.id === `${prefix}${id}`)).filter(Boolean);
  const link = (doc: (typeof docs)[number]) => `- [${doc.title}](${doc.markdown}): ${doc.description}`;
  return `# DomDimaBot documentation${language === 'es' ? ' — Español' : ''}

> Official guides for DomDimaBot, a Twitch bot with custom commands, AST scripting, TTS, rewards, triggers, AI personality, and follow defense.

These public Markdown documents are generated from the same source as the website on every build. Fetch the relevant pages before composing a command. Use the Source URL in each document for citations. The .txt files contain UTF-8 Markdown, served as text/plain for web extraction tools; no JavaScript or login is required.

DomDimaBot has its own command language. Do not substitute JavaScript or another bot's placeholders. Variables are user-created; functions, arguments, permissions, storage, and plan limits are documented separately. When requirements or a function's behavior are unclear, ask the user instead of inventing syntax. Distinguish a response body from a complete !cc chat instruction, and describe expected results without claiming an untested command was run.

## Command creation: read in this order

${start.map((doc) => link(doc!)).join('\n')}

## ${language === 'es' ? 'Documentación' : 'Documentation'}

${selected.filter((doc) => !start.includes(doc)).map(link).join('\n')}

## Optional

- [${language === 'es' ? 'English index' : 'Índice en español'}](${new URL(language === 'es' ? '/llms.txt' : '/es/llms.txt', site).href}): Documentation in ${language === 'es' ? 'English' : 'Spanish'}.
- [Full ${language === 'es' ? 'Spanish' : 'English'} documentation](${new URL(`/${prefix}llms-full.txt`, site).href}): All pages in this language in one larger file; prefer individual pages for focused questions.
`;
}
