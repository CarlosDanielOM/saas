import type { APIRoute } from 'astro';
import { documents, indexText } from '../lib/docs';
import { textPath } from '../lib/markdown.mjs';

export async function getStaticPaths() {
  const site = new URL(import.meta.env.SITE);
  const docs = await documents(site);
  return [
    ...docs.map((doc) => ({ params: { document: textPath(doc.id).slice(1, -4) }, props: { content: doc.content } })),
    ...['en', 'es'].flatMap((language) => {
      const prefix = language === 'es' ? 'es/' : '';
      return [
        { params: { document: `${prefix}llms` }, props: { content: indexText(docs, site, language) } },
        { params: { document: `${prefix}llms-full` }, props: { content: `# DomDimaBot — ${language}\n\n` + docs.filter((doc) => doc.language === language).map((doc) => doc.content).join('\n\n---\n\n') } },
      ];
    }),
  ];
}

export const GET: APIRoute = ({ props }) => new Response(props.content, {
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});
