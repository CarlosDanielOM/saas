/**
 * Shared Live First email layout.
 *
 * Mail clients drop or rewrite <style> blocks and ignore flexbox, so every
 * visual rule here is an inline style on a table-based React Email component.
 * The <style> block only adds optional extras (web font, phone padding).
 */

import type { CSSProperties, ReactNode } from 'react';
import {
    Html,
    Head,
    Body,
    Container,
    Section,
    Row,
    Column,
    Text,
    Button,
    Img,
    Link,
    Preview
} from '@react-email/components';

export type EmailLanguage = 'en' | 'es';
export type EmailTheme = 'light' | 'dark';

/** Callers pass whatever the user document holds; anything unknown falls back to English. */
export function resolveLanguage(language: string | null | undefined): EmailLanguage {
    return language === 'es' ? 'es' : 'en';
}

const SITE_URL = 'https://domdimabot.com';
const BRAND_URL = `${SITE_URL}/assets/brand`;
export const DOCS_URL = 'https://docs.domdimabot.com';
export const DISCORD_URL = 'https://discord.gg/HdubYrkPXt';

export function docsUrl(language: EmailLanguage, path = ''): string {
    return `${DOCS_URL}/${language === 'es' ? 'es/' : ''}${path}`;
}

export interface EmailPalette {
    theme: EmailTheme;
    bg: string;
    tile: string;
    hero: string;
    heroGlow: string;
    raised: string;
    line: string;
    fg: string;
    muted: string;
    faint: string;
    kicker: string;
    accent: string;
    accentText: string;
    accentSoft: string;
    gold: string;
    goldSoft: string;
    goldLine: string;
    ok: string;
    okSoft: string;
    live: string;
}

const PALETTES: Record<EmailTheme, EmailPalette> = {
    dark: {
        theme: 'dark',
        bg: '#0f1115',
        tile: '#171a21',
        hero: '#1b1628',
        heroGlow: 'radial-gradient(120% 140% at 0% 0%, rgba(139,92,246,0.28) 0%, rgba(139,92,246,0) 55%), radial-gradient(90% 120% at 100% 0%, rgba(239,68,68,0.14) 0%, rgba(239,68,68,0) 50%)',
        raised: '#1d2230',
        line: '#262b37',
        fg: '#f5f7fb',
        muted: '#a7b0c2',
        faint: '#7d8698',
        kicker: '#c4b5fd',
        accent: '#7c3aed',
        accentText: '#a78bfa',
        accentSoft: '#241c3a',
        gold: '#fbbf24',
        goldSoft: '#2a2414',
        goldLine: '#5c4a17',
        ok: '#86efac',
        okSoft: '#16281e',
        live: '#ef4444'
    },
    light: {
        theme: 'light',
        bg: '#f4f5f8',
        tile: '#ffffff',
        hero: '#f6f1ff',
        heroGlow: 'radial-gradient(120% 140% at 0% 0%, rgba(124,58,237,0.14) 0%, rgba(124,58,237,0) 55%), radial-gradient(90% 120% at 100% 0%, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0) 50%)',
        raised: '#f4f5f8',
        line: '#e5e7ee',
        fg: '#14151a',
        muted: '#596273',
        faint: '#6b7383',
        kicker: '#6d28d9',
        accent: '#7c3aed',
        accentText: '#6d28d9',
        accentSoft: '#f1eafe',
        gold: '#92400e',
        goldSoft: '#fdf6e7',
        goldLine: '#ecd5a3',
        ok: '#166534',
        okSoft: '#ecf8f0',
        live: '#ef4444'
    }
};

export function getPalette(theme: EmailTheme = 'dark'): EmailPalette {
    return PALETTES[theme] ?? PALETTES.dark;
}

const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const FOOTER_COPY = {
    en: {
        tagline: 'Chat bot, alerts and stream tools for Twitch.',
        dashboard: 'Dashboard',
        help: 'Help docs',
        discord: 'Discord',
        why: 'You received this email because you have a DomDimaBot account.'
    },
    es: {
        tagline: 'Bot de chat, alertas y herramientas para tu stream en Twitch.',
        dashboard: 'Panel',
        help: 'Ayuda',
        discord: 'Discord',
        why: 'Recibes este correo porque tienes una cuenta de DomDimaBot.'
    }
};

interface EmailLayoutProps {
    preview: string;
    language: EmailLanguage;
    palette: EmailPalette;
    /** Small uppercase line above the title. */
    kicker: string;
    /** Adds a pulsing-dot look to the kicker (live/ready states). */
    kickerTone?: 'accent' | 'live' | 'ok' | 'gold';
    title: string;
    lead?: ReactNode;
    /** Optional big element at the end of the hero (e.g. a count). */
    heroExtra?: ReactNode;
    children: ReactNode;
    /** Short context line shown under the card, above the brand footer. */
    note?: ReactNode;
    dashboardLink?: string;
}

export function EmailLayout({
    preview,
    language,
    palette: p,
    kicker,
    kickerTone = 'accent',
    title,
    lead,
    heroExtra,
    children,
    note,
    dashboardLink = SITE_URL
}: EmailLayoutProps) {
    const f = FOOTER_COPY[language];
    const isDark = p.theme === 'dark';
    const dotColor = { accent: p.accentText, live: p.live, ok: p.ok, gold: p.gold }[kickerTone];
    const footerLink: CSSProperties = { color: p.muted, textDecoration: 'underline' };

    return (
        <Html lang={language} dir="ltr">
            <Head>
                <meta name="color-scheme" content={isDark ? 'dark' : 'light'} />
                <meta name="supported-color-schemes" content={isDark ? 'dark' : 'light'} />
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
                    @media only screen and (max-width: 520px) {
                        .lf-shell { padding: 20px 12px 32px !important; }
                        .lf-pad { padding-left: 22px !important; padding-right: 22px !important; }
                        .lf-title { font-size: 25px !important; line-height: 32px !important; }
                        .lf-btn { display: block !important; text-align: center !important; }
                        .lf-stat { font-size: 20px !important; }
                        .lf-tile { padding: 12px 10px !important; }
                    }
                `}</style>
            </Head>
            <Preview>{preview}</Preview>
            <Body style={{ margin: 0, padding: 0, backgroundColor: p.bg, fontFamily: FONT, WebkitTextSizeAdjust: '100%' }}>
                <Container style={{ width: '100%', maxWidth: '600px', margin: '0 auto' }}>
                    <Section className="lf-shell" style={{ padding: '32px 16px 40px' }}>
                        {/* Brand */}
                        <Section style={{ padding: '0 4px 18px' }}>
                            <Link href={SITE_URL} style={{ textDecoration: 'none' }}>
                                <Img
                                    src={`${BRAND_URL}/mark-on-${isDark ? 'dark' : 'light'}.png`}
                                    width="30"
                                    height="32"
                                    alt=""
                                    style={{ display: 'inline-block', verticalAlign: 'middle', border: 0 }}
                                />
                                <Img
                                    src={`${BRAND_URL}/wordmark-on-${isDark ? 'dark' : 'light'}.png`}
                                    width="94"
                                    height="28"
                                    alt="DomDimaBot"
                                    style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: '8px', border: 0, color: p.fg, fontWeight: 700 }}
                                />
                            </Link>
                        </Section>

                        {/* Card */}
                        <Section
                            style={{
                                backgroundColor: p.tile,
                                border: `1px solid ${p.line}`,
                                borderRadius: '20px',
                                boxShadow: isDark ? '0 18px 40px rgba(0,0,0,0.35)' : '0 10px 30px rgba(15,17,21,0.06)'
                            }}
                        >
                            {/* Hero */}
                            <Section
                                className="lf-pad"
                                style={{
                                    backgroundColor: p.hero,
                                    backgroundImage: p.heroGlow,
                                    borderRadius: '19px 19px 0 0',
                                    borderBottom: `1px solid ${p.line}`,
                                    padding: '30px 36px 28px'
                                }}
                            >
                                <Text style={{ margin: '0 0 10px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: p.kicker }}>
                                    <span style={{ color: dotColor, fontSize: '14px' }}>●</span>&nbsp; {kicker}
                                </Text>
                                <Text className="lf-title" style={{ margin: 0, fontSize: '28px', lineHeight: '36px', fontWeight: 800, letterSpacing: '-0.01em', color: p.fg }}>
                                    {title}
                                </Text>
                                {lead ? (
                                    <Text style={{ margin: '12px 0 0', fontSize: '16px', lineHeight: '25px', color: p.muted }}>
                                        {lead}
                                    </Text>
                                ) : null}
                                {heroExtra}
                            </Section>

                            {/* Body */}
                            <Section className="lf-pad" style={{ padding: '28px 36px 32px' }}>
                                {children}
                            </Section>
                        </Section>

                        {note ? (
                            <Text style={{ margin: '20px 8px 0', fontSize: '13px', lineHeight: '20px', color: p.faint, textAlign: 'center' }}>
                                {note}
                            </Text>
                        ) : null}

                        {/* Footer */}
                        <Section style={{ padding: '22px 8px 0', textAlign: 'center' }}>
                            <Text style={{ margin: '0 0 6px', fontSize: '13px', lineHeight: '20px', color: p.muted }}>
                                <strong style={{ color: p.fg }}>DomDimaBot</strong> · {f.tagline}
                            </Text>
                            <Text style={{ margin: '0 0 10px', fontSize: '13px', lineHeight: '20px', color: p.muted }}>
                                <Link href={dashboardLink} style={footerLink}>{f.dashboard}</Link>
                                &nbsp;&nbsp;·&nbsp;&nbsp;
                                <Link href={docsUrl(language)} style={footerLink}>{f.help}</Link>
                                &nbsp;&nbsp;·&nbsp;&nbsp;
                                <Link href={DISCORD_URL} style={footerLink}>{f.discord}</Link>
                            </Text>
                            <Text style={{ margin: 0, fontSize: '12px', lineHeight: '18px', color: p.faint }}>
                                {f.why}
                            </Text>
                        </Section>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}

/* ---------- Building blocks ---------- */

export function Paragraph({ palette: p, children, style }: { palette: EmailPalette; children: ReactNode; style?: CSSProperties }) {
    return (
        <Text style={{ margin: '0 0 16px', fontSize: '16px', lineHeight: '25px', color: p.muted, ...style }}>
            {children}
        </Text>
    );
}

export function SectionLabel({ palette: p, children }: { palette: EmailPalette; children: ReactNode }) {
    return (
        <Text style={{ margin: '0 0 10px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: p.faint }}>
            {children}
        </Text>
    );
}

/** Primary action. Solid #7c3aed + white passes AA in both themes. */
export function PrimaryButton({ href, children }: { href: string; children: ReactNode }) {
    return (
        <Section style={{ padding: '8px 0 4px' }}>
            <Button
                href={href}
                className="lf-btn"
                style={{
                    backgroundColor: '#7c3aed',
                    color: '#ffffff',
                    borderRadius: '12px',
                    padding: '15px 26px',
                    fontSize: '16px',
                    lineHeight: '20px',
                    fontWeight: 700,
                    textDecoration: 'none',
                    fontFamily: FONT
                }}
            >
                {children}&nbsp;&nbsp;→
            </Button>
        </Section>
    );
}

/** "Button not working?" fallback with the raw URL, for links people must open. */
export function LinkFallback({ palette: p, href, label }: { palette: EmailPalette; href: string; label: string }) {
    return (
        <Text style={{ margin: '14px 0 0', fontSize: '12px', lineHeight: '18px', color: p.faint, wordBreak: 'break-all' }}>
            {label}{' '}
            <Link href={href} style={{ color: p.accentText, textDecoration: 'underline' }}>{href}</Link>
        </Text>
    );
}

/** Numbered step rows (Live First `.lf-step`). */
export function Steps({ palette: p, items }: { palette: EmailPalette; items: { title: string; body: string }[] }) {
    return (
        <Section style={{ margin: '0 0 20px' }}>
            {items.map((item, index) => (
                <Row key={index} style={{ marginBottom: index === items.length - 1 ? 0 : '14px' }}>
                    <Column style={{ width: '40px', verticalAlign: 'top' }}>
                        <Text style={{ margin: 0, width: '28px', height: '28px', lineHeight: '28px', borderRadius: '14px', backgroundColor: '#7c3aed', color: '#ffffff', fontSize: '13px', fontWeight: 800, textAlign: 'center' }}>
                            {index + 1}
                        </Text>
                    </Column>
                    <Column style={{ verticalAlign: 'top' }}>
                        <Text style={{ margin: '3px 0 2px', fontSize: '15px', lineHeight: '22px', fontWeight: 700, color: p.fg }}>{item.title}</Text>
                        <Text style={{ margin: 0, fontSize: '14px', lineHeight: '21px', color: p.muted }}>{item.body}</Text>
                    </Column>
                </Row>
            ))}
        </Section>
    );
}

/** Soft tinted box for a single highlighted fact. */
export function Callout({ palette: p, tone = 'accent', children }: { palette: EmailPalette; tone?: 'accent' | 'gold' | 'ok'; children: ReactNode }) {
    const tones = {
        accent: { bg: p.accentSoft, border: p.line },
        gold: { bg: p.goldSoft, border: p.goldLine },
        ok: { bg: p.okSoft, border: p.line }
    };
    const t = tones[tone];
    return (
        <Section style={{ backgroundColor: t.bg, border: `1px solid ${t.border}`, borderRadius: '14px', padding: '16px 18px', margin: '0 0 22px' }}>
            {children}
        </Section>
    );
}

export function Divider({ palette: p }: { palette: EmailPalette }) {
    return <Section style={{ borderTop: `1px solid ${p.line}`, margin: '24px 0 20px' }} />;
}
