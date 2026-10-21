/**
 * Activation Reminder Email Template
 *
 * Sent a few days after sign-up when the user still hasn't approved the bot's
 * Twitch permissions. The button goes through /email/auth to the same Twitch
 * flow as the dashboard "Activate Bot" button.
 */

import { Text, Row, Column, Section } from '@react-email/components';
import {
    EmailLayout,
    Paragraph,
    PrimaryButton,
    LinkFallback,
    SectionLabel,
    getPalette,
    resolveLanguage,
    type EmailTheme
} from './components/email-layout.js';

interface ActivationReminderEmailProps {
    streamerName: string;
    activationLink: string;
    language?: string;
    theme?: EmailTheme;
}

const translations = {
    en: {
        preview: 'Approve the bot on Twitch and it’s ready for your next stream.',
        kicker: 'One step left',
        title: (name: string) => `${name}, your bot isn’t in your chat yet`,
        lead: 'You signed up for DomDimaBot but haven’t approved its Twitch permissions. It takes under a minute, and the Free plan is enough to start.',
        unlockLabel: 'What you get once it’s on',
        unlocks: [
            'Custom commands and timers in your chat',
            'Alerts, text to speech and channel rewards',
            'Chat moderation and follow-bot protection'
        ],
        button: 'Activate my bot',
        fallback: 'Button not working? Open this link:',
        expired: 'Link expired? Log in at domdimabot.com and click “Activate Bot” in the top bar.',
        note: 'This is a one-time reminder. Already activated, or didn’t sign up? You can ignore this email.',
        subject: 'One step left: activate your DomDimaBot'
    },
    es: {
        preview: 'Aprueba el bot en Twitch y estará listo para tu próximo stream.',
        kicker: 'Te falta un paso',
        title: (name: string) => `${name}, tu bot aún no está en tu chat`,
        lead: 'Te registraste en DomDimaBot pero no has aprobado sus permisos de Twitch. Toma menos de un minuto y el plan Gratis basta para empezar.',
        unlockLabel: 'Lo que tendrás al encenderlo',
        unlocks: [
            'Comandos y temporizadores en tu chat',
            'Alertas, texto a voz y recompensas del canal',
            'Moderación del chat y protección contra bots de follows'
        ],
        button: 'Activar mi bot',
        fallback: '¿El botón no funciona? Abre este enlace:',
        expired: '¿El enlace expiró? Inicia sesión en domdimabot.com y haz clic en “Activar Bot” en la barra superior.',
        note: 'Este es un recordatorio único. ¿Ya activaste tu cuenta o no te registraste? Puedes ignorar este correo.',
        subject: 'Te falta un paso: activa tu DomDimaBot'
    }
};

export function ActivationReminderEmail({
    streamerName,
    activationLink,
    language,
    theme = 'dark'
}: ActivationReminderEmailProps) {
    const lang = resolveLanguage(language);
    const t = translations[lang];
    const p = getPalette(theme);

    return (
        <EmailLayout
            preview={t.preview}
            language={lang}
            palette={p}
            kicker={t.kicker}
            kickerTone="live"
            title={t.title(streamerName)}
            lead={t.lead}
            note={t.note}
        >
            <PrimaryButton href={activationLink}>{t.button}</PrimaryButton>

            <Section style={{ margin: '26px 0 0' }}>
                <SectionLabel palette={p}>{t.unlockLabel}</SectionLabel>
                {t.unlocks.map((item, index) => (
                    <Row key={index} style={{ marginBottom: '8px' }}>
                        <Column style={{ width: '26px', verticalAlign: 'top' }}>
                            <Text style={{ margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 800, color: p.ok }}>✓</Text>
                        </Column>
                        <Column style={{ verticalAlign: 'top' }}>
                            <Text style={{ margin: 0, fontSize: '15px', lineHeight: '22px', color: p.fg }}>{item}</Text>
                        </Column>
                    </Row>
                ))}
            </Section>

            <Section style={{ borderTop: `1px solid ${p.line}`, margin: '22px 0 0', paddingTop: '6px' }}>
                <Paragraph palette={p} style={{ margin: '14px 0 0', fontSize: '13px', lineHeight: '20px' }}>{t.expired}</Paragraph>
                <LinkFallback palette={p} href={activationLink} label={t.fallback} />
            </Section>
        </EmailLayout>
    );
}

export function getActivationReminderSubject(language: string = 'en'): string {
    return translations[resolveLanguage(language)].subject;
}
