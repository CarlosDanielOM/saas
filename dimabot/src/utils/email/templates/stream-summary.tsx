/**
 * Stream Summary Email Template
 *
 * Sent after a stream ends and the AI-generated summary is saved.
 * Answers "how did my stream go?" first: headline, then the numbers, then the recap.
 */

import { Text, Row, Column, Section } from '@react-email/components';
import {
    EmailLayout,
    PrimaryButton,
    SectionLabel,
    getPalette,
    resolveLanguage,
    type EmailPalette,
    type EmailTheme
} from './components/email-layout.js';

interface StreamSummaryEmailProps {
    streamerName: string;
    streamDate: string;
    streamDuration: number; // in minutes
    headline: string;
    recapSnippet: string; // truncated to ~300 chars
    highlights: string[];
    stats: {
        averageViewers: number;
        peakViewers: number;
        follows: number;
        subs: number;
        bits: number;
        donations: number;
    };
    memoryCount: number;
    fullSummaryLink: string;
    dashboardLink: string;
    language?: string;
    theme?: EmailTheme;
}

const translations = {
    en: {
        kicker: 'Stream recap',
        preview: (headline: string, peak: string) => `${headline} — peak of ${peak} viewers.`,
        avgViewers: 'Avg viewers',
        peakViewers: 'Peak viewers',
        follows: 'New follows',
        subs: 'Subs',
        bits: 'Bits',
        duration: 'Stream time',
        memories: (count: number) => count === 1
            ? 'The bot saved 1 new memory from this stream'
            : `The bot saved ${count} new memories from this stream`,
        recapLabel: 'Recap',
        highlightsLabel: 'Highlights',
        button: 'Read the full recap',
        note: 'Recaps are written by AI from your chat and stream events, so double-check anything important.',
        subject: (date: string) => `Your stream recap — ${date}`
    },
    es: {
        kicker: 'Resumen del stream',
        preview: (headline: string, peak: string) => `${headline} — pico de ${peak} espectadores.`,
        avgViewers: 'Promedio',
        peakViewers: 'Pico',
        follows: 'Seguidores',
        subs: 'Subs',
        bits: 'Bits',
        duration: 'Duración',
        memories: (count: number) => count === 1
            ? 'El bot guardó 1 recuerdo nuevo de este stream'
            : `El bot guardó ${count} recuerdos nuevos de este stream`,
        recapLabel: 'Resumen',
        highlightsLabel: 'Momentos destacados',
        button: 'Leer el resumen completo',
        note: 'Los resúmenes los escribe una IA a partir de tu chat y los eventos del stream; revisa lo importante.',
        subject: (date: string) => `Tu resumen del stream — ${date}`
    }
};

function formatDuration(minutes: number): string {
    const safe = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    return hours > 0 ? `${hours}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
}

function formatNumber(value: number): string {
    const num = Number(value) || 0;
    if (num >= 1_000_000) return `${trimZero((num / 1_000_000).toFixed(1))}M`;
    if (num >= 10_000) return `${Math.round(num / 1000)}k`;
    if (num >= 1000) return `${trimZero((num / 1000).toFixed(1))}k`;
    return String(Math.round(num));
}

function trimZero(text: string): string {
    return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function StatTile({ palette: p, value, label, tone }: { palette: EmailPalette; value: string; label: string; tone?: 'gold' | 'muted' }) {
    const color = tone === 'gold' ? p.gold : tone === 'muted' ? p.faint : p.fg;
    return (
        <Section className="lf-tile" style={{ backgroundColor: p.raised, border: `1px solid ${p.line}`, borderRadius: '14px', padding: '14px 12px' }}>
            <Text className="lf-stat" style={{ margin: 0, fontSize: '26px', lineHeight: '30px', fontWeight: 800, color, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                {value}
            </Text>
            <Text style={{ margin: '4px 0 0', fontSize: '11px', lineHeight: '15px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: p.muted }}>
                {label}
            </Text>
        </Section>
    );
}

export function StreamSummaryEmail({
    streamDate,
    streamDuration,
    headline,
    recapSnippet,
    highlights,
    stats,
    memoryCount,
    fullSummaryLink,
    dashboardLink,
    language,
    theme = 'dark'
}: StreamSummaryEmailProps) {
    const lang = resolveLanguage(language);
    const t = translations[lang];
    const p = getPalette(theme);

    const tiles: { value: string; label: string; tone?: 'gold' | 'muted' }[] = [
        { value: formatNumber(stats.averageViewers), label: t.avgViewers },
        { value: formatNumber(stats.peakViewers), label: t.peakViewers },
        { value: formatDuration(streamDuration), label: t.duration },
        { value: formatNumber(stats.follows), label: t.follows, tone: stats.follows ? undefined : 'muted' },
        { value: formatNumber(stats.subs), label: t.subs, tone: stats.subs ? undefined : 'muted' },
        { value: formatNumber(stats.bits), label: t.bits, tone: stats.bits ? 'gold' : 'muted' }
    ];
    const rows = [tiles.slice(0, 3), tiles.slice(3, 6)];
    const shownHighlights = (highlights || []).filter(Boolean).slice(0, 5);

    return (
        <EmailLayout
            preview={t.preview(headline, formatNumber(stats.peakViewers))}
            language={lang}
            palette={p}
            kicker={`${t.kicker} · ${streamDate}`}
            kickerTone="live"
            title={headline}
            note={t.note}
            dashboardLink={dashboardLink}
            heroExtra={memoryCount > 0 ? (
                <Text style={{ margin: '16px 0 0', display: 'inline-block', padding: '6px 12px', borderRadius: '999px', backgroundColor: p.okSoft, border: `1px solid ${p.line}`, fontSize: '13px', lineHeight: '18px', fontWeight: 600, color: p.ok }}>
                    ✦&nbsp; {t.memories(memoryCount)}
                </Text>
            ) : null}
        >
            {rows.map((row, rowIndex) => (
                <Row key={rowIndex} style={{ tableLayout: 'fixed', width: '100%', marginBottom: rowIndex === 0 ? '8px' : '24px' }}>
                    {row.map((tile, index) => (
                        <Column key={index} style={{ width: '33.33%', verticalAlign: 'top', paddingLeft: index === 0 ? 0 : '4px', paddingRight: index === row.length - 1 ? 0 : '4px' }}>
                            <StatTile palette={p} value={tile.value} label={tile.label} tone={tile.tone} />
                        </Column>
                    ))}
                </Row>
            ))}

            {recapSnippet ? (
                <Section style={{ margin: '0 0 22px' }}>
                    <SectionLabel palette={p}>{t.recapLabel}</SectionLabel>
                    <Text style={{ margin: 0, padding: '2px 0 2px 14px', borderLeft: `3px solid ${p.accent}`, fontSize: '15px', lineHeight: '24px', color: p.fg }}>
                        {recapSnippet}
                    </Text>
                </Section>
            ) : null}

            {shownHighlights.length > 0 ? (
                <Section style={{ margin: '0 0 22px' }}>
                    <SectionLabel palette={p}>{t.highlightsLabel}</SectionLabel>
                    {shownHighlights.map((highlight, index) => (
                        <Row key={index} style={{ marginBottom: '8px' }}>
                            <Column style={{ width: '24px', verticalAlign: 'top' }}>
                                <Text style={{ margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 800, color: p.accentText }}>{index + 1}</Text>
                            </Column>
                            <Column style={{ verticalAlign: 'top' }}>
                                <Text style={{ margin: 0, fontSize: '15px', lineHeight: '22px', color: p.muted }}>{highlight}</Text>
                            </Column>
                        </Row>
                    ))}
                </Section>
            ) : null}

            <PrimaryButton href={fullSummaryLink}>{t.button}</PrimaryButton>
        </EmailLayout>
    );
}

export function getStreamSummaryEmailSubject(date: string, language: string = 'en'): string {
    return translations[resolveLanguage(language)].subject(date);
}
