/**
 * Stream Summary Email Template
 *
 * Sent after a stream ends and the AI-generated summary is saved.
 * Includes stream stats, highlights, and a snippet of the recap.
 */

import {
    Html,
    Head,
    Body,
    Container,
    Section,
    Text,
    Button,
    Hr,
    Img
} from '@react-email/components';

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
    language?: 'en' | 'es';
    theme?: 'light' | 'dark';
}

const translations = {
    en: {
        title: "Stream Summary 📺",
        memoryBadge: (count: number) => count === 1 ? `✨ 1 memory was created` : `✨ ${count} memories were created`,
        statsLabel: "Key Stats",
        avgViewers: "Avg Viewers",
        peakViewers: "Peak Viewers",
        followsLabel: "Follows",
        subsLabel: "Subs",
        bitsLabel: "Bits",
        recapLabel: "Recap",
        highlightsLabel: "Key Highlights:",
        buttonText: "Read Full Summary",
        footerLink: "View Dashboard",
        footerText: "Thanks for streaming with DomDimaBot! •",
        subject: (date: string) => `Stream Summary - ${date} 📺`
    },
    es: {
        title: "Resumen del Stream 📺",
        memoryBadge: (count: number) => count === 1 ? `✨ 1 memoria fue creada` : `✨ ${count} memorias fueron creadas`,
        statsLabel: "Estadísticas Clave",
        avgViewers: "Espectadores Avg",
        peakViewers: "Pico de Espectadores",
        followsLabel: "Seguidores",
        subsLabel: "Subs",
        bitsLabel: "Bits",
        recapLabel: "Resumen",
        highlightsLabel: "Momentos Destacados:",
        buttonText: "Leer Resumen Completo",
        footerLink: "Ver Panel",
        footerText: "¡Gracias por transmitir con DomDimaBot! •",
        subject: (date: string) => `Resumen del Stream - ${date} 📺`
    }
};

export function StreamSummaryEmail({
    streamerName,
    streamDate,
    streamDuration,
    headline,
    recapSnippet,
    highlights,
    stats,
    memoryCount,
    fullSummaryLink,
    dashboardLink,
    language = 'en',
    theme = 'dark'
}: StreamSummaryEmailProps) {
    const t = translations[language];
    const isDark = theme === 'dark';

    const formatDuration = (minutes: number): string => {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours > 0) {
            return language === 'es' ? `${hours}h ${mins}m` : `${hours}h ${mins}m`;
        }
        return language === 'es' ? `${mins}m` : `${mins}m`;
    };

    const formatNumber = (num: number): string => {
        if (num >= 1000) {
            return `${(num / 1000).toFixed(1)}k`;
        }
        return num.toString();
    };

    return (
        <Html>
            <Head>
                <style>{`
                    body {
                        background-color: ${isDark ? '#0c0717' : '#f5f5f5'};
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        margin: 0;
                        padding: 0;
                    }
                    .container {
                        max-width: 600px;
                        margin: 0 auto;
                        padding: 40px 20px;
                    }
                    .card {
                        background-color: ${isDark ? '#140c24' : '#ffffff'};
                        border-radius: 12px;
                        padding: 40px;
                        box-shadow: ${isDark ? '0 10px 30px rgba(0, 0, 0, 0.4), 0 0 1px rgba(168, 85, 247, 0.4)' : '0 2px 4px rgba(0, 0, 0, 0.1)'};
                        border: ${isDark ? '1px solid #2f1d4f' : '1px solid #eeeeee'};
                    }
                    .logo {
                        max-width: 150px;
                        margin-bottom: 30px;
                    }
                    .title {
                        font-size: 24px;
                        font-weight: 600;
                        color: ${isDark ? '#f8fafc' : '#1a1a1a'};
                        margin-bottom: 8px;
                    }
                    .subtitle {
                        font-size: 14px;
                        color: ${isDark ? '#6b7280' : '#888888'};
                        margin-bottom: 24px;
                    }
                    .headline {
                        font-size: 20px;
                        font-weight: 600;
                        color: #a855f7;
                        margin-bottom: 16px;
                    }
                    .text {
                        font-size: 16px;
                        line-height: 1.6;
                        color: ${isDark ? '#a9b2c3' : '#4a4a4a'};
                        margin-bottom: 16px;
                    }
                    .recap-box {
                        background-color: ${isDark ? '#1e1435' : '#f9f9f9'};
                        border-radius: 6px;
                        padding: 20px;
                        margin: 20px 0;
                        border: ${isDark ? '1px solid #2f1d4f' : 'none'};
                    }
                    .recap-label {
                        font-size: 12px;
                        font-weight: 600;
                        color: ${isDark ? '#a855f7' : '#888888'};
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        margin-bottom: 8px;
                    }
                    .stats-grid {
                        display: table;
                        width: 100%;
                        margin: 24px 0;
                    }
                    .stat-cell {
                        display: table-cell;
                        text-align: center;
                        padding: 16px 8px;
                        border-right: 1px solid ${isDark ? '#2f1d4f' : '#eeeeee'};
                    }
                    .stat-cell:last-child {
                        border-right: none;
                    }
                    .stat-value {
                        font-size: 24px;
                        font-weight: 700;
                        color: ${isDark ? '#f8fafc' : '#1a1a1a'};
                    }
                    .stat-label {
                        font-size: 12px;
                        color: ${isDark ? '#6b7280' : '#888888'};
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .highlights {
                        margin: 20px 0;
                    }
                    .highlight-item {
                        display: flex;
                        align-items: flex-start;
                        margin-bottom: 12px;
                    }
                    .highlight-bullet {
                        color: #a855f7;
                        margin-right: 10px;
                        font-size: 16px;
                    }
                    .memory-badge {
                        display: inline-block;
                        background-color: ${isDark ? 'rgba(52, 211, 153, 0.15)' : '#e8f5e9'};
                        color: ${isDark ? '#34d399' : '#2e7d32'};
                        padding: 4px 12px;
                        border-radius: 20px;
                        font-size: 14px;
                        font-weight: 500;
                        margin-bottom: 20px;
                        border: ${isDark ? '1px solid rgba(52, 211, 153, 0.25)' : 'none'};
                    }
                    .button {
                        display: inline-block;
                        background: linear-gradient(135deg, #7c3aed, #a855f7);
                        background-color: #9146ff;
                        color: #ffffff !important;
                        text-decoration: none;
                        padding: 14px 28px;
                        border-radius: 9999px;
                        font-weight: 600;
                        font-size: 16px;
                        margin: 20px 0;
                        box-shadow: ${isDark ? '0 4px 15px rgba(124, 58, 237, 0.4)' : 'none'};
                    }
                    .footer {
                        margin-top: 40px;
                        font-size: 14px;
                        color: ${isDark ? '#6b7280' : '#888888'};
                        text-align: center;
                    }
                `}</style>
            </Head>
            <Body>
                <Container className="container">
                    <Section className="card">
                        <Img
                            src="https://cdn.domdimabot.com/emails/logo.png"
                            alt="DomDimaBot"
                            className="logo"
                        />

                        <Text className="title">{t.title}</Text>
                        <Text className="subtitle">
                            {streamDate} • {formatDuration(streamDuration)}
                        </Text>

                        <Text className="headline">{headline}</Text>

                        {memoryCount > 0 && (
                            <span className="memory-badge">
                                {t.memoryBadge(memoryCount)}
                            </span>
                        )}

                        <Section className="stats-grid">
                            <div className="stat-cell">
                                <div className="stat-value">{formatNumber(stats.averageViewers)}</div>
                                <div className="stat-label">{t.avgViewers}</div>
                            </div>
                            <div className="stat-cell">
                                <div className="stat-value">{formatNumber(stats.peakViewers)}</div>
                                <div className="stat-label">{t.peakViewers}</div>
                            </div>
                            <div className="stat-cell">
                                <div className="stat-value">{formatNumber(stats.follows)}</div>
                                <div className="stat-label">{t.followsLabel}</div>
                            </div>
                            <div className="stat-cell">
                                <div className="stat-value">{formatNumber(stats.subs)}</div>
                                <div className="stat-label">{t.subsLabel}</div>
                            </div>
                            <div className="stat-cell">
                                <div className="stat-value">{formatNumber(stats.bits)}</div>
                                <div className="stat-label">{t.bitsLabel}</div>
                            </div>
                        </Section>

                        {recapSnippet && (
                            <Section className="recap-box">
                                <Text className="recap-label">{t.recapLabel}</Text>
                                <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>
                                    {recapSnippet}
                                </Text>
                            </Section>
                        )}

                        {highlights.length > 0 && (
                            <Section className="highlights">
                                <Text className="text" style={{ fontWeight: 600, marginBottom: 12, color: isDark ? '#f8fafc' : '#1a1a1a' }}>
                                    {t.highlightsLabel}
                                </Text>
                                {highlights.slice(0, 5).map((highlight, index) => (
                                    <div key={index} className="highlight-item">
                                        <span className="highlight-bullet">•</span>
                                        <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>
                                            {highlight}
                                        </Text>
                                    </div>
                                ))}
                            </Section>
                        )}

                        <Section style={{ textAlign: 'center' }}>
                            <Button
                                href={fullSummaryLink}
                                className="button"
                            >
                                {t.buttonText}
                            </Button>
                        </Section>

                        <Hr style={{ margin: '30px 0', borderColor: isDark ? '#2f1d4f' : '#eeeeee' }} />

                        <Text className="footer">
                            {t.footerText}
                            <Button
                                href={dashboardLink}
                                style={{
                                    color: '#a855f7',
                                    textDecoration: 'none',
                                    marginLeft: '4px'
                                }}
                            >
                                {t.footerLink}
                            </Button>
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}

export function getStreamSummaryEmailSubject(date: string, language: 'en' | 'es' = 'en'): string {
    return translations[language].subject(date);
}