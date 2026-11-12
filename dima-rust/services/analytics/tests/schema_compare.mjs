// Optional reference comparison. No package installation and no production data.
// Run: DATABASE_URL=<admin URI> node tests/schema_compare.mjs <Rust binary>
// The caller runs this from services/analytics after loading tools/test-env.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root='/home/dom/Projects/saas/dima-analytics';
if(!existsSync(root+'/node_modules/pg')) {console.error('NOT RUN: reference node_modules absent; no catalogue comparison recorded');process.exit(2);}
const require=createRequire(root+'/package.json');const pg=require('pg');
const admin=new pg.Client({connectionString:process.env.DIMA_TEST_POSTGRES_URI});await admin.connect();
const names=['node','rust'].map(s=>'dima_test_analytics_'+s+'_'+randomUUID().replaceAll('-',''));
const clients=[],children=[];
const uri=name=>{const u=new URL(process.env.DIMA_TEST_POSTGRES_URI);u.pathname='/'+name;return u.href;};
const catalogue=async db=>(await db.query(`SELECT json_build_object('tables',(SELECT json_agg(r ORDER BY tablename) FROM (SELECT tablename FROM pg_tables WHERE schemaname='public') r),'columns',(SELECT json_agg(r ORDER BY table_name,ordinal_position) FROM (SELECT table_name,column_name,ordinal_position,is_nullable,data_type,udt_name,column_default FROM information_schema.columns WHERE table_schema='public') r),'indexes',(SELECT json_agg(r ORDER BY tablename,indexname) FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') r),'constraints',(SELECT json_agg(r ORDER BY relname,conname) FROM (SELECT c.relname,p.conname,pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') r)) AS value`)).rows[0].value;
try {
 for(const name of names){await admin.query(`CREATE DATABASE ${name}`);const c=new pg.Client({connectionString:uri(name)});await c.connect();clients.push(c);}
 // Migrate is the exact function called by Node startup. No timers, collectors or inbox consumer.
 const store=await import(pathToFileURL(root+'/src/store.mjs').href);await store.migrate(clients[0]);
 const child=spawn(process.argv[2],['--migrate-only'],{env:{...process.env,DATABASE_URL:uri(names[1]),REDIS_URL:'redis://127.0.0.1:6379/5',OWNER_TWITCH_ID:'1',COLLECTORS_DISABLED:'true',HOSTSTATS_URL:'off',PORT:'0'},stdio:'ignore'});children.push(child);
 for(let i=0;i<50;i++){if(child.exitCode!==null){assert.equal(child.exitCode,0);break;}if((await clients[1].query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n===23)break;await new Promise(r=>setTimeout(r,100));}
 if(child.exitCode===null)await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0);children.pop();
 assert.deepEqual(await catalogue(clients[0]),await catalogue(clients[1]));console.log('PASS: tables, columns, types, defaults, indexes and constraints match');
} finally {
 for(const child of children){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 for(const c of clients)await c.end();for(const name of names)await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();
}
