/** The docs page as a path: query strings and fragments are the visitor's, not the page's, and are never kept. */
export function docsPagePath(url: string | undefined): string | null {
    const text = (url ?? '').trim();
    if (!text) return null;
    let path: string | null = null;
    if (text.startsWith('/')) path = text.split(/[?#]/)[0];
    else {
        try {
            const url = new URL(text);
            if (url.protocol === 'https:' || url.protocol === 'http:') path = url.pathname;
        } catch {
            // Not a URL: no page.
        }
    }
    return path === null ? null : path.slice(0, 300) || '/';
}
