/**
 * VOD Clip Analysis Finished Email Template
 *
 * Sent when the VOD clip recommender finishes and found moments to review.
 */

import { Text, Row, Column, Section } from '@react-email/components';
import {
    EmailLayout,
    Paragraph,
    PrimaryButton,
    Callout,
    getPalette,
    resolveLanguage,
    type EmailTheme
} from './components/email-layout.js';

interface VodClipAnalysisFinishedEmailProps {
    streamerName: string;
    approvedCount: number;
    dashboardUrl: string;
    language?: string;
    theme?: EmailTheme;
}

const translations = {
    en: {
        subject: 'Your VOD clip moments are ready to review',
        preview: (count: number) => `We found ${count} likely clip moment${count === 1 ? '' : 's'} in your latest VOD.`,
        kicker: 'VOD analysis finished',
        title: (name: string) => `${name}, your clip picks are ready`,
        countLabel: (count: number) => `likely clip moment${count === 1 ? '' : 's'} in your latest VOD`,
        body: 'Watch each preview, keep the ones you like and skip the rest.',
        temporary: 'Previews are temporary. Confirm the moments you want to keep from your dashboard.',
        cta: 'Review clip moments'
    },
    es: {
        subject: 'Tus momentos para clip del VOD están listos',
        preview: (count: number) => `Encontramos ${count} posible${count === 1 ? '' : 's'} momento${count === 1 ? '' : 's'} para clip en tu último VOD.`,
        kicker: 'Análisis del VOD terminado',
        title: (name: string) => `${name}, tus clips sugeridos están listos`,
        countLabel: (count: number) => `posible${count === 1 ? '' : 's'} momento${count === 1 ? '' : 's'} para clip en tu último VOD`,
        body: 'Mira cada preview, guarda los que te gusten y descarta el resto.',
        temporary: 'Los previews son temporales. Confirma los momentos que quieras guardar desde tu panel.',
        cta: 'Revisar momentos'
    }
};

export function VodClipAnalysisFinishedEmail({
    streamerName,
    approvedCount,
    dashboardUrl,
    language,
    theme = 'dark'
}: VodClipAnalysisFinishedEmailProps) {
    const lang = resolveLanguage(language);
    const t = translations[lang];
    const p = getPalette(theme);
    const count = Math.max(0, Number(approvedCount) || 0);

    return (
        <EmailLayout
            preview={t.preview(count)}
            language={lang}
            palette={p}
            kicker={t.kicker}
            kickerTone="gold"
            title={t.title(streamerName)}
        >
            <Section style={{ backgroundColor: p.raised, border: `1px solid ${p.line}`, borderRadius: '16px', padding: '18px 20px', margin: '0 0 18px' }}>
                <Row>
                    <Column style={{ width: '1%', whiteSpace: 'nowrap', paddingRight: '18px', verticalAlign: 'middle' }}>
                        <Text style={{ margin: 0, fontSize: '52px', lineHeight: '56px', fontWeight: 800, color: p.gold, letterSpacing: '-0.02em' }}>{count}</Text>
                    </Column>
                    <Column style={{ verticalAlign: 'middle' }}>
                        <Text style={{ margin: 0, fontSize: '16px', lineHeight: '23px', fontWeight: 700, color: p.fg }}>{t.countLabel(count)}</Text>
                    </Column>
                </Row>
            </Section>

            <Paragraph palette={p}>{t.body}</Paragraph>

            <Callout palette={p} tone="gold">
                <Text style={{ margin: 0, fontSize: '14px', lineHeight: '21px', color: p.muted }}>
                    <span style={{ color: p.gold, fontWeight: 800 }}>⏱&nbsp; </span>{t.temporary}
                </Text>
            </Callout>

            <PrimaryButton href={dashboardUrl}>{t.cta}</PrimaryButton>
        </EmailLayout>
    );
}

export function getVodClipAnalysisFinishedSubject(language: string = 'en'): string {
    return translations[resolveLanguage(language)].subject;
}
