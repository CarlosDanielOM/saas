/**
 * Activation Reminder Email Template
 *
 * Sent 3 days after user signs up but hasn't activated their account.
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

interface ActivationReminderEmailProps {
    streamerName: string;
    activationLink: string;
    language?: 'en' | 'es';
    theme?: 'light' | 'dark';
}

const translations = {
    en: {
        greeting: (name: string) => `Hey ${name}! 👋`,
        line1: "We noticed you recently signed up for DomDimaBot but haven't activated your account yet. No worries - we're here to help you get started!",
        line2: "Activating your account only takes a few seconds and will unlock all the features that make DomDimaBot awesome for your stream.",
        buttonText: "Activate My Account",
        line3: "If you have any questions, just reply to this email - we're always happy to help!",
        footer: "This is a one-time reminder. If you've already activated your account, you can safely ignore this email.",
        subject: "Complete your DomDimaBot activation 🚀"
    },
    es: {
        greeting: (name: string) => `¡Hey ${name}! 👋`,
        line1: "Notamos que recientemente te registraste en DomDimaBot pero aún no has activado tu cuenta. ¡No te preocupes - estamos aquí para ayudarte a comenzar!",
        line2: "Activar tu cuenta solo toma unos segundos y desbloqueará todas las funciones que hacen a DomDimaBot increíble para tu stream.",
        buttonText: "Activar Mi Cuenta",
        line3: "Si tienes alguna pregunta, simplemente responde a este correo - ¡siempre estamos felices de ayudar!",
        footer: "Este es un recordatorio de un solo uso. Si ya activaste tu cuenta, puedes ignorar este correo con seguridad.",
        subject: "Completa la activación de tu DomDimaBot 🚀"
    }
};

export function ActivationReminderEmail({
    streamerName,
    activationLink,
    language = 'en',
    theme = 'dark'
}: ActivationReminderEmailProps) {
    const t = translations[language];
    const isDark = theme === 'dark';

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
                        margin-bottom: 20px;
                    }
                    .text {
                        font-size: 16px;
                        line-height: 1.6;
                        color: ${isDark ? '#a9b2c3' : '#4a4a4a'};
                        margin-bottom: 16px;
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

                        <Text className="title">{t.greeting(streamerName)}</Text>

                        <Text className="text">
                            {t.line1}
                        </Text>

                        <Text className="text">
                            {t.line2}
                        </Text>

                        <Section style={{ textAlign: 'center' }}>
                            <Button
                                href={activationLink}
                                className="button"
                            >
                                {t.buttonText}
                            </Button>
                        </Section>

                        <Text className="text">
                            {t.line3}
                        </Text>

                        <Hr style={{ margin: '30px 0', borderColor: isDark ? '#2f1d4f' : '#eeeeee' }} />

                        <Text className="footer">
                            {t.footer}
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}

export function getActivationReminderSubject(language: 'en' | 'es' = 'en'): string {
    return translations[language].subject;
}