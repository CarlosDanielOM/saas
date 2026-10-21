/**
 * Welcome Email Template
 *
 * Sent right after the user activates the bot (approves its Twitch permissions).
 * Steps mirror the docs "Getting Started" guide from step 3 onward.
 */

import { Text } from '@react-email/components';
import {
    EmailLayout,
    Paragraph,
    PrimaryButton,
    Steps,
    Callout,
    SectionLabel,
    getPalette,
    resolveLanguage,
    docsUrl,
    DISCORD_URL,
    type EmailTheme
} from './components/email-layout.js';

interface WelcomeEmailProps {
    streamerName: string;
    discountCode?: string;
    dashboardLink: string;
    language?: string;
    theme?: EmailTheme;
}

const translations = {
    en: {
        preview: 'The bot is connected. Three quick steps and it’s live in your chat.',
        kicker: 'Account active',
        title: (name: string) => `You’re in, ${name}!`,
        lead: 'DomDimaBot is connected to your Twitch channel. Three quick steps and it’s answering in your chat — about 5 minutes.',
        stepsLabel: 'Get it running',
        steps: [
            { title: 'Turn the bot on', body: 'On your dashboard, open Quick Actions and click “Turn the bot on”.' },
            { title: 'Add your first command', body: 'Go to Commands → Add Command, name it hello, save, and type !hello in your chat.' },
            { title: 'Pick your modules', body: 'Text to speech, alerts, chat moderation, clips and analytics. Each card shows its plan.' }
        ],
        giftLabel: 'Welcome gift',
        giftBody: 'Use this code at checkout if you upgrade to Premium or Pro.',
        button: 'Open my dashboard',
        helpPrefix: 'Stuck on a step? The ',
        helpGuide: 'getting started guide',
        helpMiddle: ' walks through each one, or ask us on ',
        helpSuffix: '.',
        subject: 'Welcome to DomDimaBot — let’s get your bot live'
    },
    es: {
        preview: 'El bot ya está conectado. Tres pasos rápidos y estará en tu chat.',
        kicker: 'Cuenta activa',
        title: (name: string) => `¡Ya estás dentro, ${name}!`,
        lead: 'DomDimaBot ya está conectado a tu canal de Twitch. Tres pasos rápidos y estará respondiendo en tu chat — unos 5 minutos.',
        stepsLabel: 'Ponlo en marcha',
        steps: [
            { title: 'Enciende el bot', body: 'En tu panel, abre Acciones Rápidas y haz clic en “Encender el bot”.' },
            { title: 'Agrega tu primer comando', body: 'Ve a Comandos → Agregar Comando, llámalo hello, guarda y escribe !hello en tu chat.' },
            { title: 'Elige tus módulos', body: 'Texto a voz, alertas, moderación del chat, clips y analíticas. Cada tarjeta muestra su plan.' }
        ],
        giftLabel: 'Regalo de bienvenida',
        giftBody: 'Usa este código al pagar si mejoras a Premium o Pro.',
        button: 'Abrir mi panel',
        helpPrefix: '¿Te atoraste en un paso? La ',
        helpGuide: 'guía de inicio',
        helpMiddle: ' explica cada uno, o pregúntanos en ',
        helpSuffix: '.',
        subject: 'Bienvenido a DomDimaBot — pongamos tu bot en marcha'
    }
};

export function WelcomeEmail({
    streamerName,
    discountCode,
    dashboardLink,
    language,
    theme = 'dark'
}: WelcomeEmailProps) {
    const lang = resolveLanguage(language);
    const t = translations[lang];
    const p = getPalette(theme);
    const link = { color: p.accentText, textDecoration: 'underline' };

    return (
        <EmailLayout
            preview={t.preview}
            language={lang}
            palette={p}
            kicker={t.kicker}
            kickerTone="ok"
            title={t.title(streamerName)}
            lead={t.lead}
            dashboardLink={dashboardLink}
        >
            <SectionLabel palette={p}>{t.stepsLabel}</SectionLabel>
            <Steps palette={p} items={t.steps} />

            {discountCode ? (
                <Callout palette={p} tone="gold">
                    <Text style={{ margin: '0 0 6px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: p.gold }}>
                        {t.giftLabel}
                    </Text>
                    <Text style={{ margin: '0 0 6px', fontSize: '22px', lineHeight: '28px', fontWeight: 800, letterSpacing: '0.12em', color: p.fg, fontFamily: "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace" }}>
                        {discountCode}
                    </Text>
                    <Text style={{ margin: 0, fontSize: '14px', lineHeight: '20px', color: p.muted }}>{t.giftBody}</Text>
                </Callout>
            ) : null}

            <PrimaryButton href={dashboardLink}>{t.button}</PrimaryButton>

            <Paragraph palette={p} style={{ margin: '22px 0 0', fontSize: '14px', lineHeight: '21px' }}>
                {t.helpPrefix}
                <a href={docsUrl(lang, 'getting-started/')} style={link}>{t.helpGuide}</a>
                {t.helpMiddle}
                <a href={DISCORD_URL} style={link}>Discord</a>
                {t.helpSuffix}
            </Paragraph>
        </EmailLayout>
    );
}

export function getWelcomeEmailSubject(language: string = 'en'): string {
    return translations[resolveLanguage(language)].subject;
}
