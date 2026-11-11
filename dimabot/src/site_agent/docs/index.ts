/**
 * Docs knowledge for the site agent: section index, prompt index (≤ 10k tokens), hybrid search
 * and read. See SITE_AGENT.md → Layout.
 */
export { getDocsPromptIndex, buildDocsPromptIndex, INDEX_TOKEN_BUDGET } from './prompt_index.js';
export type { DocsPromptIndex } from './prompt_index.js';
export { searchDocs, MAX_SEARCH_LIMIT } from './search.js';
export type { DocsSearchResponse, DocsSearchResult, SearchDocsInput } from './search.js';
export { readDocs, READ_PAGE_TOKENS } from './read.js';
export type { DocsReadResult, DocsReadSuccess, DocsReadError, ReadDocsInput, DocsReadScope } from './read.js';
export { ensureDocsVectors, docsVectorsReady } from './vectors.js';
export { getParsedDocs, peekParsedDocs } from './source.js';
export { estimateTokens, normalizeDocsId } from './sections.js';
export type { DocsSection, DocsPageInfo, ParsedDocs } from './sections.js';
