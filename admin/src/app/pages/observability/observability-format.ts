/** Labels and formatting shared by the analytics page and its dialogs. */
export const KIND_LABEL: Record<string, string> = {
  http: 'Endpoint',
  http_client: 'Outside service',
  database: 'Database',
  cache: 'Cache',
  cache_lookup: 'Cache lookup',
  chat: 'Chat message',
  chat_stage: 'Chat step',
  command: 'Command',
  command_body: 'Command handler',
  event: 'Twitch event',
  queue_wait: 'Waiting to start',
  queue_run: 'Running',
  queue_total: 'Start to finish',
  queue: 'Queue gauge',
  lifecycle: 'Stream',
  runtime: 'Process',
};
export const SERVICE_LABEL: Record<string, string> = {
  api: 'API',
  bot: 'Bot',
  cron: 'Workers',
  queues: 'Queues',
  dragonfly: 'Dragonfly',
  mongodb: 'MongoDB',
  qdrant: 'Qdrant',
  postgres: 'PostgreSQL',
  analytics: 'Analytics',
};

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1) return '<1 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  if (value < 3600000) return `${(value / 60000).toFixed(value < 600000 ? 1 : 0)} min`;
  return `${(value / 3600000).toFixed(1)} h`;
}

export function isFailedOutcome(outcome: string): boolean {
  return outcome === 'error' || outcome === 'aborted' || outcome === 'failed';
}
