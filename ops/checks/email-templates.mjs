// Email template behavior check for the api and cron candidates (run through saas-ops).
// Renders every transactional email from the candidate's compiled dist and checks the
// redesign's guarantees. Never sends: Resend is not configured in test containers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderEmail, sendEmail } from '/app/dist/utils/email/email.service.js';
import { WelcomeEmail, getWelcomeEmailSubject } from '/app/dist/utils/email/templates/welcome.js';
import { ActivationReminderEmail, getActivationReminderSubject } from '/app/dist/utils/email/templates/activation-reminder.js';
import { StreamSummaryEmail, getStreamSummaryEmailSubject } from '/app/dist/utils/email/templates/stream-summary.js';
import { VodClipAnalysisFinishedEmail, getVodClipAnalysisFinishedSubject } from '/app/dist/utils/email/templates/vod-clip-analysis-finished.js';

const target = process.env.SAAS_TARGET;
assert.ok(['api', 'cron'].includes(target), `unexpected target ${target}`);

const render = async (subject, el) => renderEmail({ to: 'check@example.test', subject, emailComponent: el });
const common = (r, label) => {
    assert.match(r.html, /https:\/\/domdimabot\.com\/assets\/brand\/(mark|wordmark)-on-(dark|light)\.png/, `${label}: brand logo`);
    assert.doesNotMatch(r.html, /cdn\.domdimabot\.com/, `${label}: old broken CDN logo`);
    assert.doesNotMatch(r.html, /display:\s*flex/, `${label}: flexbox`);
    assert.doesNotMatch(r.html, /reply to this email|responde a este correo/i, `${label}: reply promise`);
    assert.match(r.html, /https:\/\/discord\.gg\/HdubYrkPXt/, `${label}: discord footer`);
    assert.ok(r.text.length > 200, `${label}: plain text body`);
};
let groups = 0;

for (const lang of ['en', 'es']) {
    for (const theme of ['dark', 'light']) {
        const welcome = await render(getWelcomeEmailSubject(lang), WelcomeEmail({ streamerName: 'fixture', dashboardLink: 'https://domdimabot.com', language: lang, theme }));
        common(welcome, `welcome ${lang} ${theme}`);
        assert.doesNotMatch(welcome.html, /coming soon|llegará pronto|WELCOME10/i, 'no discount block without a code');
        assert.match(welcome.html, lang === 'es' ? /docs\.domdimabot\.com\/es\/getting-started\// : /docs\.domdimabot\.com\/getting-started\//);
        const withCode = await render('x', WelcomeEmail({ streamerName: 'fixture', discountCode: 'CHECK10', dashboardLink: 'https://domdimabot.com', language: lang, theme }));
        assert.match(withCode.html, /CHECK10/, 'discount code shown when present');

        const link = 'https://api.domdimabot.com/email/auth?token=check-token';
        const reminder = await render(getActivationReminderSubject(lang), ActivationReminderEmail({ streamerName: 'fixture', activationLink: link, language: lang, theme }));
        common(reminder, `reminder ${lang} ${theme}`);
        assert.ok(reminder.html.split('email/auth?token=check-token').length - 1 >= 3, 'button + visible fallback link');
        assert.match(reminder.html, lang === 'es' ? /Activar Bot/ : /Activate Bot/, 'expired-link fallback');

        const summary = await render(getStreamSummaryEmailSubject('Oct 21', lang), StreamSummaryEmail({
            streamerName: 'fixture', streamDate: 'Oct 21', streamDuration: 187, headline: 'Check headline',
            recapSnippet: 'Check recap', highlights: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            stats: { averageViewers: 1250, peakViewers: 3480, follows: 0, subs: 15, bits: 45000, donations: 0 },
            memoryCount: 3, fullSummaryLink: 'https://domdimabot.com/fixture/modules/stream-summaries',
            dashboardLink: 'https://domdimabot.com', language: lang, theme
        }));
        common(summary, `summary ${lang} ${theme}`);
        for (const value of ['1.3k', '3.5k', '45k', '3h 07m', 'Check headline', 'Check recap']) assert.ok(summary.html.includes(value), `summary shows ${value}`);
        assert.ok(summary.html.includes('h5') && !summary.html.includes('h6'), 'at most five highlights');
        assert.match(summary.html, /fixture\/modules\/stream-summaries/);

        const vod = await render(getVodClipAnalysisFinishedSubject(lang), VodClipAnalysisFinishedEmail({ streamerName: 'fixture', approvedCount: 7, dashboardUrl: 'https://domdimabot.com/fixture/modules/clip-recommendations', language: lang, theme }));
        common(vod, `vod ${lang} ${theme}`);
        assert.match(vod.html, /modules\/clip-recommendations/);
        groups += 1;
    }
}

// Spanish copy is really Spanish; unknown languages fall back to English instead of throwing.
assert.match(getWelcomeEmailSubject('es'), /Bienvenido/);
assert.equal(getVodClipAnalysisFinishedSubject('fr'), getVodClipAnalysisFinishedSubject('en'));
const fallback = await render('x', VodClipAnalysisFinishedEmail({ streamerName: 'fixture', approvedCount: 1, dashboardUrl: 'https://domdimabot.com', language: 'fr' }));
assert.match(fallback.html, /likely clip moment in your latest VOD/);
groups += 1;

// The stream-summary sender links to the real module route.
const runner = fs.readFileSync('/app/dist/utils/ai/memory/stream_memory_runner.js', 'utf8');
assert.match(runner, /modules\/stream-summaries`/);
assert.doesNotMatch(runner, /modules\/stream-summary\//);
groups += 1;

// Sending without RESEND_API_KEY fails closed (no real email leaves a test container).
assert.equal(process.env.RESEND_API_KEY, undefined);
const sent = await sendEmail({ to: 'check@example.test', subject: 'x', emailComponent: WelcomeEmail({ streamerName: 'x', dashboardLink: 'https://domdimabot.com' }) });
assert.equal(sent.error, true);
groups += 1;

console.log(`email-templates: ${groups} groups passed on ${target}`);
