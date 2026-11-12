CREATE TABLE IF NOT EXISTS analytics_batches (id uuid PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS analytics_metrics (
      resolution integer NOT NULL, at timestamptz NOT NULL, service text NOT NULL, kind text NOT NULL,
      name text NOT NULL, channel text NOT NULL, outcome text NOT NULL,
      count bigint NOT NULL, sum double precision NOT NULL, max double precision NOT NULL, histogram bigint[] NOT NULL,
      PRIMARY KEY (resolution, at, service, kind, name, channel, outcome)
    ) PARTITION BY RANGE (at);
    CREATE TABLE IF NOT EXISTS analytics_spans (
      at timestamptz NOT NULL, trace_id text NOT NULL, span_id text NOT NULL, parent_id text,
      service text NOT NULL, channel text NOT NULL, kind text NOT NULL, name text NOT NULL,
      outcome text NOT NULL, duration double precision NOT NULL, partial boolean NOT NULL,
      PRIMARY KEY(at, span_id)
    ) PARTITION BY RANGE (at);
    CREATE INDEX IF NOT EXISTS analytics_spans_lookup ON analytics_spans(trace_id, at);
    CREATE INDEX IF NOT EXISTS analytics_spans_scope ON analytics_spans(channel, at);
    CREATE TABLE IF NOT EXISTS analytics_logs (
      at timestamptz NOT NULL, service text NOT NULL, channel text NOT NULL, level text NOT NULL,
      name text NOT NULL, trace_id text, fields jsonb NOT NULL
    ) PARTITION BY RANGE (at);
    CREATE INDEX IF NOT EXISTS analytics_logs_scope ON analytics_logs(channel, at);
    CREATE TABLE IF NOT EXISTS analytics_resources (
      at timestamptz NOT NULL, service text NOT NULL, name text NOT NULL, value double precision NOT NULL,
      PRIMARY KEY(at, service, name)
    ) PARTITION BY RANGE (at);
    CREATE TABLE IF NOT EXISTS analytics_grants (
      user_id text PRIMARY KEY, role text NOT NULL CHECK(role IN ('viewer','investigator')),
      channels text[] NOT NULL DEFAULT '{}', services text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz, granted_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_audit (
      at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL, subject text NOT NULL
    );
