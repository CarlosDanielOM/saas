INSERT INTO analytics_metrics AS existing
      SELECT resolution, to_timestamp(floor(m.at / 1000 / resolution) * resolution), $2, kind, name, channel, outcome,
             sum(count), sum(sum), max(max), ARRAY[sum(histogram[1]),sum(histogram[2]),sum(histogram[3]),sum(histogram[4]),sum(histogram[5]),sum(histogram[6]),sum(histogram[7]),sum(histogram[8]),sum(histogram[9]),sum(histogram[10]),sum(histogram[11]),sum(histogram[12]),sum(histogram[13]),sum(histogram[14]),sum(histogram[15]),sum(histogram[16])]
      FROM jsonb_to_recordset($1::jsonb) AS m(at double precision, kind text, name text, channel text, outcome text, count bigint, sum double precision, max double precision, histogram bigint[])
      CROSS JOIN (VALUES (10),(60),(3600)) AS r(resolution)
      GROUP BY resolution, floor(m.at / 1000 / resolution), kind, name, channel, outcome
      ON CONFLICT (resolution, at, service, kind, name, channel, outcome) DO UPDATE SET
        count=existing.count+excluded.count, sum=existing.sum+excluded.sum, max=greatest(existing.max,excluded.max),
        histogram=ARRAY[existing.histogram[1]+excluded.histogram[1],existing.histogram[2]+excluded.histogram[2],existing.histogram[3]+excluded.histogram[3],existing.histogram[4]+excluded.histogram[4],existing.histogram[5]+excluded.histogram[5],existing.histogram[6]+excluded.histogram[6],existing.histogram[7]+excluded.histogram[7],existing.histogram[8]+excluded.histogram[8],existing.histogram[9]+excluded.histogram[9],existing.histogram[10]+excluded.histogram[10],existing.histogram[11]+excluded.histogram[11],existing.histogram[12]+excluded.histogram[12],existing.histogram[13]+excluded.histogram[13],existing.histogram[14]+excluded.histogram[14],existing.histogram[15]+excluded.histogram[15],existing.histogram[16]+excluded.histogram[16]]
    
