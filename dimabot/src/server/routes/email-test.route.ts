/**
 * Email Test Routes
 *
 * Development-only endpoints for testing email templates.
 * These routes should NOT be mounted in production.
 */

import express, { type Request, type Response } from 'express';
import type { ReactElement } from 'react';
import { sendEmail, DASHBOARD_URL, DEFAULT_DISCOUNT_CODE, EMAIL_AUTH_BASE_URL, signEmailActivationToken } from '../../utils/email/email.service.js';
import { ActivationReminderEmail, getActivationReminderSubject } from '../../utils/email/templates/activation-reminder.js';
import { WelcomeEmail, getWelcomeEmailSubject } from '../../utils/email/templates/welcome.js';
import { StreamSummaryEmail, getStreamSummaryEmailSubject } from '../../utils/email/templates/stream-summary.js';

const router = express.Router();

interface TestEmailQuery {
    type?: 'activation-reminder' | 'welcome' | 'stream-summary';
    to?: string;
    lang?: 'en' | 'es';
    theme?: 'light' | 'dark';
}

router.get('/test', async (req: Request<{}, {}, {}, TestEmailQuery>, res: Response) => {
    const { type = 'welcome', to, lang = 'en', theme = 'dark' } = req.query;

    // Default test email
    const testEmail = to || process.env.DEV_TEST_EMAIL || 'test@example.com';
    const language = lang === 'es' ? 'es' : 'en';

    try {
        let emailComponent: ReactElement;
        let subject: string;

        let activationLink: string | undefined;

        switch (type) {
            case 'activation-reminder':
                // Use a realistic signed token for the test link (still dev-only)
                // This link goes through /email/auth which feeds the standardized pendingActionsQueue on the public site.
                const testToken = signEmailActivationToken('test-user-id-123', 'teststreamer');
                activationLink = `${EMAIL_AUTH_BASE_URL}?token=${encodeURIComponent(testToken)}`;
                emailComponent = ActivationReminderEmail({
                    streamerName: 'TestStreamer',
                    activationLink,
                    language,
                    theme
                });
                subject = getActivationReminderSubject(language);
                break;

            case 'stream-summary':
                const locale = language === 'es' ? 'es-ES' : 'en-US';
                const streamDate = new Date().toLocaleDateString(locale, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
                emailComponent = StreamSummaryEmail({
                    streamerName: 'TestStreamer',
                    streamDate,
                    streamDuration: 180,
                    headline: language === 'es'
                        ? '¡Un stream increíble con grandes vibras de comunidad!'
                        : 'An amazing stream with great community vibes!',
                    recapSnippet: language === 'es'
                        ? 'Hoy fue un stream increíble donde jugamos juegos, tuvimos grandes conversaciones con el chat, e incluso tuvimos una raid emocionante de otro streamer. La comunidad estuvo muy activa y alcanzamos grandes hitos juntos.'
                        : 'Today was an incredible stream where we played games, had great conversations with the chat, and even had some exciting raid incoming from a fellow streamer. The community was super active and we hit some great milestones together.',
                    highlights: language === 'es'
                        ? [
                            'La comunidad alcanzó 500 chateadores activos',
                            'Nuevo hito de suscriptores logrado',
                            'Gran raid de xQc con 10k espectadores'
                        ]
                        : [
                            'Community reached 500 active chatters',
                            'New subscriber milestone achieved',
                            'Great raid from xQc with 10k viewers'
                        ],
                    stats: {
                        averageViewers: 1250,
                        peakViewers: 3500,
                        follows: 89,
                        subs: 15,
                        bits: 45000,
                        donations: 50
                    },
                    memoryCount: 3,
                    fullSummaryLink: `${DASHBOARD_URL}/teststreamer/modules/stream-summary/latest`,
                    dashboardLink: DASHBOARD_URL,
                    language,
                    theme
                });
                subject = getStreamSummaryEmailSubject(streamDate, language);
                break;

            case 'welcome':
            default:
                emailComponent = WelcomeEmail({
                    streamerName: 'TestStreamer',
                    discountCode: DEFAULT_DISCOUNT_CODE || (language === 'es' ? 'BIENVENIDO10' : 'WELCOME10'),
                    dashboardLink: DASHBOARD_URL,
                    language,
                    theme
                });
                subject = getWelcomeEmailSubject(language);
                break;
        }

        const result = await sendEmail({
            to: testEmail,
            subject: `[TEST] ${subject}`,
            emailComponent
        });

        if (result.error) {
            return res.status(500).json({
                error: true,
                message: result.message,
                status: 500
            });
        }

        const responseData: any = {
            type,
            language,
            to: testEmail,
            messageId: result.data?.id
        };

        if (type === 'activation-reminder' && activationLink) {
            responseData.activationLink = activationLink;
        }

        return res.status(200).json({
            error: false,
            message: 'Test email sent successfully',
            data: responseData
        });

    } catch (error) {
        console.error('Error in /email/test:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Failed to send test email',
            status: 500
        });
    }
});

export const emailTestRoute = router;