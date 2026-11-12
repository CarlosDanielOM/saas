INSERT INTO analytics_logs SELECT to_timestamp(at/1000),$2,channel,level,name,"traceId",fields
      FROM jsonb_to_recordset($1::jsonb) AS l(at double precision,channel text,level text,name text,"traceId" text,fields jsonb)
