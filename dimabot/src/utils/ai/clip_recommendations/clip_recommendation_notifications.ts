import type { HydratedDocument } from 'mongoose';
import type { IClipRecommendation } from '../../../schemas/clip_recommendation.schema.js';
import type { IUsers } from '../../../schemas/users.schema.js';
import { DASHBOARD_URL, renderEmail, sendRenderedEmail } from '../../email/email.service.js';
import { VodClipAnalysisFinishedEmail, getVodClipAnalysisFinishedSubject } from '../../email/templates/vod-clip-analysis-finished.js';

export async function sendClipCompletionNotification(
    rec: HydratedDocument<IClipRecommendation>,
    user: IUsers,
    channelID: string,
    channel: string,
    deps: { renderEmail?: typeof renderEmail; sendRenderedEmail?: typeof sendRenderedEmail } = {}
): Promise<void> {
    if (rec.notificationStatus === 'sent') return;

    const attemptedAt = new Date();
    if (!rec.notificationPayload) {
        const account = user.accounts.find((item) => item.type === 'twitch' && item.id === channelID);
        const email = account?.email || user.email;
        if (!email) {
            rec.notificationStatus = 'not_required';
            rec.notificationLastAttemptAt = attemptedAt;
            rec.notificationError = '';
            rec.notificationNextRetryAt = null;
            rec.notifiedAt = null;
            await rec.save();
            return;
        }

        rec.notificationPayload = await (deps.renderEmail ?? renderEmail)({
            to: email,
            subject: getVodClipAnalysisFinishedSubject(user.language || 'en'),
            emailComponent: VodClipAnalysisFinishedEmail({
                streamerName: channel || account?.name || user.name || 'streamer',
                approvedCount: rec.approvedCount,
                dashboardUrl: `${DASHBOARD_URL}/${encodeURIComponent(channel || channelID)}/modules/clip-recommendations`,
                language: user.language || 'en'
            })
        });
    }

    // Persist the actual rendered body before sending; retries must never render it again.
    rec.notificationLastAttemptAt = attemptedAt;
    rec.notificationStatus = 'pending';
    await rec.save();

    const result = await (deps.sendRenderedEmail ?? sendRenderedEmail)(
        rec.notificationPayload,
        `clip-recommendation-complete:${rec.queueJobID || rec._id}`
    );
    if (result.error) {
        const retryDelay = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_NOTIFICATION_RETRY_DELAY_MS) || 60 * 60 * 1000);
        rec.notificationStatus = 'failed';
        rec.notificationError = result.message.slice(0, 2000);
        rec.notificationNextRetryAt = new Date(attemptedAt.getTime() + retryDelay);
    } else {
        rec.notificationStatus = 'sent';
        rec.notifiedAt = new Date();
        rec.notificationError = '';
        rec.notificationNextRetryAt = null;
    }
    await rec.save();
}
