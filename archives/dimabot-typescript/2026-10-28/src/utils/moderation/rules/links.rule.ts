import type { IModerationRule } from '../../../schemas/channel_moderation_settings.schema.js';

export interface LinksEvaluationResult {
    triggered: boolean;
    urls: string[];
    blockedUrl: string | null;
}

// Simple "abc.abc" detection: optional protocol/www, host with at least one
// dot and a 2+ char TLD, optional path/query. Deliberately permissive — this
// is a moderation filter, not a URL validator.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?/gi;

function extractHostname(rawUrl: string): string | null {
    let value = rawUrl.trim().toLowerCase();
    value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
    const host = value.split(/[/?#]/)[0].split(':')[0];
    if (!host || !host.includes('.')) return null;
    return host;
}

function isAllowlisted(hostname: string, allowlistDomains: string[]): boolean {
    return allowlistDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * Triggers when the message contains at least one URL whose hostname is not
 * on the rule's domain allowlist. Subdomains of allowlisted domains are
 * allowed (allowlisting "twitch.tv" covers "clips.twitch.tv").
 */
export function evaluateLinksRule(
    rule: Pick<IModerationRule, 'allowlistDomains'>,
    input: { text: string }
): LinksEvaluationResult {
    const text = input.text ?? '';
    const allowlist = (rule.allowlistDomains || []).map(domain => domain.toLowerCase());

    const matches = text.match(URL_PATTERN) || [];
    const urls: string[] = [];
    let blockedUrl: string | null = null;

    for (const match of matches) {
        const hostname = extractHostname(match);
        if (!hostname) continue;
        urls.push(hostname);
        if (!blockedUrl && !isAllowlisted(hostname, allowlist)) {
            blockedUrl = hostname;
        }
    }

    return { triggered: blockedUrl !== null, urls, blockedUrl };
}
