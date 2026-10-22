import assert from 'node:assert/strict';

// validateBatch checks the envelope/histograms before this narrower ownership check.
export function standaloneMetricsReady(metrics, workers) {
    const droppedName = 'cron_index_rust.telemetry_dropped';
    const allowed = new Set([droppedName, ...workers.flatMap(name =>
        ['rss_bytes', 'cpu_cores', name === 'roulette-completion' ? 'batch_channels' : 'batch_items', 'project_batch']
            .map(metric => `${name.replaceAll('-', '_')}_rust.${metric}`))]);
    assert(metrics.every(row => allowed.has(row.name) && row.channel === ''), 'only selected-worker and fixed supervisor metrics');
    const dropped = metrics.filter(row => row.name === droppedName);
    for (const row of dropped) {
        assert.equal(row.kind, 'runtime'); assert.equal(row.outcome, 'ok');
        assert(Number.isSafeInteger(row.count) && row.count > 0);
        for (const value of [row.sum, row.max]) assert(Number.isSafeInteger(value) && value >= 0 && value <= 1e15);
        assert(row.max <= row.sum);
    }
    return dropped.length > 0 && workers.every(name => {
        const prefix = `${name.replaceAll('-', '_')}_rust.`;
        return metrics.some(row => row.name === prefix + 'rss_bytes' && row.kind === 'runtime' && row.max > 0)
            && metrics.some(row => row.name === prefix + 'cpu_cores' && row.kind === 'runtime')
            && metrics.some(row => row.name === prefix + (name === 'roulette-completion' ? 'batch_channels' : 'batch_items')
                && row.kind === 'worker' && row.sum === 3 && row.count === 1);
    });
}
