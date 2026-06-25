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

interface VodClipAnalysisFinishedEmailProps {
    streamerName: string;
    approvedCount: number;
    dashboardUrl: string;
    language?: 'en' | 'es';
    theme?: 'light' | 'dark';
}

const translations = {
    en: {
        subject: 'Your VOD clip recommendations are ready 🎬',
        greeting: (name: string) => `Hey ${name}!`,
        title: 'VOD analysis finished',
        body: (count: number) => `We found ${count} probable clip moment${count === 1 ? '' : 's'} from your latest VOD.`,
        cta: 'Review Clip Recommendations',
        footer: 'Preview clips are temporary. Confirm the moments you want to keep from your dashboard.'
    },
    es: {
        subject: 'Tus recomendaciones de clips del VOD estan listas 🎬',
        greeting: (name: string) => `¡Hey ${name}!`,
        title: 'Analisis de VOD terminado',
        body: (count: number) => `Encontramos ${count} posible${count === 1 ? '' : 's'} momento${count === 1 ? '' : 's'} para clip de tu ultimo VOD.`,
        cta: 'Revisar recomendaciones',
        footer: 'Los previews son temporales. Confirma los momentos que quieras guardar desde tu dashboard.'
    }
};

export function VodClipAnalysisFinishedEmail({
    streamerName,
    approvedCount,
    dashboardUrl,
    language = 'en',
    theme = 'dark'
}: VodClipAnalysisFinishedEmailProps) {
    const t = translations[language];
    const isDark = theme === 'dark';

    return (
        <Html>
            <Head>
                <style>{`
                    body { background-color: ${isDark ? '#0c0717' : '#f5f5f5'}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; margin: 0; padding: 0; }
                    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
                    .card { background-color: ${isDark ? '#140c24' : '#ffffff'}; border-radius: 16px; padding: 40px; border: ${isDark ? '1px solid #2f1d4f' : '1px solid #eeeeee'}; }
                    .logo { max-width: 150px; margin-bottom: 28px; }
                    .kicker { color: #facc15; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; }
                    .title { font-size: 28px; font-weight: 700; color: ${isDark ? '#f8fafc' : '#111827'}; margin: 8px 0 16px; }
                    .text { font-size: 16px; line-height: 1.6; color: ${isDark ? '#cbd5e1' : '#374151'}; margin-bottom: 16px; }
                    .count { font-size: 48px; line-height: 1; color: #facc15; font-weight: 800; margin: 18px 0; }
                    .button { display: inline-block; background: linear-gradient(135deg, #7c3aed, #facc15); color: #111827 !important; text-decoration: none; padding: 14px 28px; border-radius: 9999px; font-weight: 700; font-size: 16px; margin: 20px 0; }
                    .footer { margin-top: 32px; font-size: 14px; color: ${isDark ? '#94a3b8' : '#6b7280'}; text-align: center; }
                `}</style>
            </Head>
            <Body>
                <Container className="container">
                    <Section className="card">
                        <Img src="https://cdn.domdimabot.com/emails/logo.png" alt="DomDimaBot" className="logo" />
                        <Text className="kicker">{t.greeting(streamerName)}</Text>
                        <Text className="title">{t.title}</Text>
                        <Text className="count">{approvedCount}</Text>
                        <Text className="text">{t.body(approvedCount)}</Text>
                        <Section style={{ textAlign: 'center' }}>
                            <Button href={dashboardUrl} className="button">{t.cta}</Button>
                        </Section>
                        <Hr style={{ margin: '30px 0', borderColor: isDark ? '#2f1d4f' : '#eeeeee' }} />
                        <Text className="footer">{t.footer}</Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}

export function getVodClipAnalysisFinishedSubject(language: 'en' | 'es' = 'en'): string {
    return translations[language].subject;
}
