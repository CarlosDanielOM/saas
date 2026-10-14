import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
assert.equal(process.env.ANALYTICS_TEST,'1');assert.match(process.env.DATABASE_URL,/observability_test/);
// Includes the long-range aggregation test: >25k buckets in 24h, hourly 7d buckets, fresh latest values and grant scoping.
const output=execFileSync(process.execPath,['--test','--test-isolation=none','test/analytics.test.mjs','test/channel-names.test.mjs'],{encoding:'utf8'});
console.log(output);assert.match(output,/[ℹ#] fail 0\n/);assert.match(output,/[ℹ#] skipped 0\n/);
const pg=createRequire('/app/package.json')('pg');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const get=async path=>{const r=await fetch('http://127.0.0.1:3210'+path,{headers:{Authorization:'Bearer owner'}});assert.equal(r.status,200,path);return r.json();};
try{
  for(const minutes of [15,60,360,1440,10080,43200]){const data=await get('/api/overview?minutes='+minutes);assert.equal(data.minutes,minutes);assert.equal(data.truncated,undefined);assert(Array.isArray(data.groups)&&Array.isArray(data.timeline));}
  // 24h of 30-second samples for four series is 11,520 rows; the old endpoint returned only the newest 5,000 (about 10 hours).
  await pool.query(`INSERT INTO analytics_resources SELECT now()-interval '1 second'-s*interval '30 seconds','fixture','metric_'||r,s+r FROM generate_series(0,2879) s CROSS JOIN generate_series(0,3) r ON CONFLICT DO NOTHING`);
  const day=await get('/api/resources?minutes=1440&service=fixture');
  assert.equal(day.limited,false);
  for(let r=0;r<4;r++){
    const series=day.samples.filter(s=>s.name==='metric_'+r).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    assert(series.length>=355&&series.length<=362,`metric_${r} has ${series.length} slots`);
    assert(Date.now()-Date.parse(series[0].at)>23.5*3600000,'oldest sample spans the whole day');
    assert.equal(series.at(-1).value,r,'latest sample is exact');
  }
  const quarter=await get('/api/resources?minutes=15&service=fixture');assert.equal(quarter.samples.filter(s=>s.name==='metric_0').length,30);
  console.log('Overview totals are complete across ranges; resource history spans the full range with exact latest values');
}finally{await pool.query("DELETE FROM analytics_resources WHERE service='fixture'");await pool.end();}
