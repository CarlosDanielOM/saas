/**
 * Renews a lease every `everyMs`, one renewal at a time. `renew` resolves false when the lease is
 * no longer ours. `stop()` waits for a renewal in flight: an overlapping or late renewal would
 * otherwise re-arm the lease after its release and block the next claim until it expires.
 */
export function leaseHeartbeat(renew: () => PromiseLike<boolean>, everyMs = 10_000) {
    let lost = false, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> = Promise.resolve();
    const schedule = (): void => {
        timer = setTimeout(() => {
            pending = Promise.resolve().then(renew).then(renewed => { if (!renewed) lost = true; }, () => { lost = true; })
                .then(() => { if (!stopped && !lost) schedule(); });
        }, everyMs);
        timer.unref();
    };
    schedule();
    return {
        get lost(): boolean { return lost; },
        async stop(): Promise<void> { stopped = true; clearTimeout(timer); await pending; },
    };
}
