/**
 * Welcome Email Template
 *
 * Sent right after user successfully activates their account.
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

interface WelcomeEmailProps {
    streamerName: string;
    discountCode?: string;
    dashboardLink: string;
    language?: 'en' | 'es';
    theme?: 'light' | 'dark';
}

const translations = {
    en: {
        title: (name: string) => `Welcome to DomDimaBot, ${name}! 🎉`,
        line1: "Your account is now activated and ready to go. You've taken the first step toward enhancing your stream with AI-powered features.",
        discountLabel: "As a special welcome gift, here's your discount code:",
        discountEmpty: "Your discount code will be coming soon!",
        nextSteps: "Here's what you can do next:",
        feature1: "Customize your AI personality",
        feature2: "Set up custom commands and triggers",
        feature3: "View your stream analytics",
        buttonText: "Go to Dashboard",
        line2: "If you have any questions, just reply to this email - we're always here to help!",
        footer: "DomDimaBot - Making streams smarter, one chat at a time.",
        subject: "Welcome to DomDimaBot! 🎮"
    },
    es: {
        title: (name: string) => `¡Bienvenido a DomDimaBot, ${name}! 🎉`,
        line1: "Tu cuenta ahora está activada y lista para usar. Has dado el primer paso para mejorar tu stream con funciones potenciadas por IA.",
        discountLabel: "Como regalo de bienvenida especial, aquí está tu código de descuento:",
        discountEmpty: "¡Tu código de descuento llegará pronto!",
        nextSteps: "Esto es lo que puedes hacer ahora:",
        feature1: "Personaliza tu personalidad de IA",
        feature2: "Configura comandos personalizados y disparadores",
        feature3: "Ve tus análisis de stream",
        buttonText: "Ir al Panel",
        line2: "Si tienes alguna pregunta, simplemente responde a este correo - ¡siempre estamos aquí para ayudar!",
        footer: "DomDimaBot - Haciendo streams más inteligentes, un chat a la vez.",
        subject: "¡Bienvenido a DomDimaBot! 🎮"
    }
};

export function WelcomeEmail({
    streamerName,
    discountCode,
    dashboardLink,
    language = 'en',
    theme = 'dark'
}: WelcomeEmailProps) {
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
                    .highlight {
                        background-color: ${isDark ? '#1e1435' : '#fef9e6'};
                        border-left: 4px solid ${isDark ? '#a855f7' : '#ffc107'};
                        padding: 16px 20px;
                        margin: 20px 0;
                        border-radius: 6px;
                    }
                    .discount-code {
                        font-family: 'Courier New', monospace;
                        font-size: 20px;
                        font-weight: 700;
                        color: #a855f7;
                        letter-spacing: 2px;
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
                    .features {
                        margin: 20px 0;
                    }
                    .feature {
                        display: flex;
                        align-items: center;
                        margin-bottom: 12px;
                    }
                    .feature-icon {
                        margin-right: 12px;
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
 
                        <Text className="title">{t.title(streamerName)}</Text>
 
                        <Text className="text">
                            {t.line1}
                        </Text>
 
                        {discountCode ? (
                            <Section className="highlight">
                                <Text className="text" style={{ marginBottom: 8, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>
                                    {t.discountLabel}
                                </Text>
                                <Text className="discount-code">{discountCode}</Text>
                            </Section>
                        ) : (
                            <Section className="highlight">
                                <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>
                                    {t.discountEmpty}
                                </Text>
                            </Section>
                        )}
 
                        <Text className="text">
                            {t.nextSteps}
                        </Text>
 
                        <Section className="features">
                            <div className="feature">
                                <span className="feature-icon">🎨</span>
                                <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>{t.feature1}</Text>
                            </div>
                            <div className="feature">
                                <span className="feature-icon">⚡</span>
                                <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>{t.feature2}</Text>
                            </div>
                            <div className="feature">
                                <span className="feature-icon">📊</span>
                                <Text className="text" style={{ marginBottom: 0, color: isDark ? '#a9b2c3' : '#4a4a4a' }}>{t.feature3}</Text>
                            </div>
                        </Section>
 
                        <Section style={{ textAlign: 'center' }}>
                            <Button
                                href={dashboardLink}
                                className="button"
                            >
                                {t.buttonText}
                            </Button>
                        </Section>
 
                        <Text className="text">
                            {t.line2}
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

export function getWelcomeEmailSubject(language: 'en' | 'es' = 'en'): string {
    return translations[language].subject;
}