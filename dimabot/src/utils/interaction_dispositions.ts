import { InteractionDisposition, type IInteractionDisposition } from '../schemas/interaction_disposition.schema.js';

type Kind = IInteractionDisposition['kind'];
type Disposition = IInteractionDisposition['disposition'];
const key = (channel: string, kind: Kind, id: string) => `${channel}:${kind}:${id}`;

/**
 * True when this call is the first to settle the poll or prediction, i.e. the caller may announce it
 * (or has just canceled it). False when it was already announced or canceled. A database error
 * throws: an "ended" script can do far more than post a line, so when in doubt nothing runs.
 */
export async function claimInteraction(channel: string, kind: Kind, id: string, disposition: Disposition): Promise<boolean> {
    if (!channel || !id) return false;
    try {
        await InteractionDisposition.create({ _id: key(channel, kind, id), channelID: channel, kind, disposition, at: new Date() });
        return true;
    } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
    }
}

/** Takes a claim back, only if it still has this disposition (a refused `cancel.poll`). */
export async function releaseInteraction(channel: string, kind: Kind, id: string, disposition: Disposition): Promise<void> {
    if (!channel || !id) return;
    await InteractionDisposition.deleteOne({ _id: key(channel, kind, id), disposition });
}
