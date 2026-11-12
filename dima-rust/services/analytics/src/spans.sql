INSERT INTO analytics_spans SELECT to_timestamp(at/1000), "traceId", "spanId", "parentId", $2, channel, kind, name, outcome, duration, partial
      FROM jsonb_to_recordset($1::jsonb) AS s(at double precision,"traceId" text,"spanId" text,"parentId" text,channel text,kind text,name text,outcome text,duration double precision,partial boolean)
      ON CONFLICT DO NOTHING
