import { randomUUID } from 'node:crypto';
import { PetSettingsSchema } from '../schemas/pet_settings.schema.js';
import { PetRuntime } from '../schemas/pet_runtime.schema.js';
import { selectedVtsController } from './peers.js';
import { PetReadiness } from './readiness.schema.js';

export const VTS_READINESS_TTL_MS = 15_000;
let apiInstanceId: string | undefined;
let timer: NodeJS.Timeout | undefined;
let refreshing = false;
const activeOwners = new Set<string>();
const refreshes = new Map<string, { dirty: boolean; promise: Promise<void> }>();
/** API-only startup: a restart cannot revive the previous process's ready projection. */
export async function initializePetReadiness() {
    apiInstanceId = undefined;
    clearInterval(timer);
    await PetReadiness.init();
    const instance = randomUUID();
    await PetReadiness.updateOne({ _id: 'api-instance' }, { $set: { apiInstanceId: instance } }, { upsert: true });
    await PetReadiness.deleteMany({ _id: { $ne: 'api-instance' } });
    apiInstanceId = instance;
    // Refresh comfortably before the 15s proof expiry. Only previously validated
    // owners participate; publishing never changes settings revision or broadcasts.
    clearInterval(timer); activeOwners.clear();
    timer = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        void (async () => { for (const ownerId of activeOwners) await refreshPetReadiness(ownerId); })()
            .catch(() => {}).finally(() => { refreshing = false; });
    }, 5000);
    timer.unref();
}
export function stopPetReadiness() { clearInterval(timer); timer = undefined; activeOwners.clear(); apiInstanceId = undefined; }

async function refreshOnce(ownerId: string) {
    const instance = apiInstanceId;
    if (!instance) return; // Producers never publish/invent readiness.
    const [settings, runtime] = await Promise.all([
        PetSettingsSchema.findOne({ userId: ownerId }).select('settings.appearance settings.playback revision').lean(),
        PetRuntime.findById(ownerId).lean()
    ]);
    if (!runtime || instance !== apiInstanceId) return;
    const sessionId = settings?.settings.playback?.vtsSessionId ?? null;
    const controller = settings?.settings.appearance?.kind === 'vts' ? await selectedVtsController(ownerId, sessionId) : null;
    const expiresAt = controller ? Math.min(controller.validatedAt + VTS_READINESS_TTL_MS, controller.authorizationExpiresAt) : 0;
    if (instance !== apiInstanceId) return;
    if (!controller || !controller.socket.connected || expiresAt <= Date.now()) {
        await PetReadiness.deleteOne({ _id: ownerId, apiInstanceId: instance, generation: { $lte: runtime.generation } });
        activeOwners.delete(ownerId);
        return;
    }
    await PetReadiness.updateOne({ _id: ownerId }, { $set: { generation: runtime.generation,
        settingsRevision: settings!.revision, sessionId, peerId: controller.id, apiInstanceId: instance,
        validatedAt: new Date(controller.validatedAt), authorizationExpiresAt: new Date(controller.authorizationExpiresAt), expiresAt: new Date(expiresAt)
    } }, { upsert: true });
    activeOwners.add(ownerId);
}
/** One in-flight observation per owner; concurrent changes coalesce into a fresh pass.
 * A delayed ready-false/disconnect clear cannot land after a newer ready publication.
 */
export function refreshPetReadiness(ownerId: string): Promise<void> {
    if (!apiInstanceId) return Promise.resolve();
    const previous = refreshes.get(ownerId);
    if (previous) { previous.dirty = true; return previous.promise; }
    const entry = { dirty: true, promise: Promise.resolve() };
    entry.promise = (async () => {
        do { entry.dirty = false; await refreshOnce(ownerId); } while (entry.dirty);
    })().finally(() => { refreshes.delete(ownerId); });
    refreshes.set(ownerId, entry);
    return entry.promise;
}
export async function hasSharedVtsReadiness(ownerId: string, generation: number | undefined, revision: number, sessionId: string | null) {
    if (!sessionId || generation === undefined) return false;
    const instance = await PetReadiness.findById('api-instance').select('apiInstanceId').lean();
    if (!instance?.apiInstanceId) return false;
    const now = new Date();
    return !!await PetReadiness.exists({ _id: ownerId, apiInstanceId: instance.apiInstanceId, generation, settingsRevision: revision, sessionId,
        expiresAt: { $gt: now }, authorizationExpiresAt: { $gt: now },
        validatedAt: { $gt: new Date(now.getTime() - VTS_READINESS_TTL_MS), $lte: now } });
}
