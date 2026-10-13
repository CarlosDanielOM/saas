import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, OnInit } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SessionAuthService } from '../../services/session-auth.service';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { environment } from '../../../environments/environment';

interface NamedChannels { channelNames?: Record<string, string | null> }
interface Summary { count: number; average: number | null; p50: number | null; p95: number | null; p99: number | null; errors: number; max: number }
interface Group extends Summary { service: string; kind: string; name: string; channel: string; lastAt: string; lastValue: number }
interface Overview extends NamedChannels { lastAt: string | null; generatedAt: string; truncated: boolean; http: Summary; chat: Summary; groups: Group[]; timeline: Array<{ at: number; httpRps: number; chatRps: number }>; minutes: number }
interface Grant { role: 'owner' | 'viewer' | 'investigator'; channels: string[]; services: string[] }
interface AccessGrant extends Grant { user_id: string; expires_at: string | null }
interface Span { at: string; trace_id: string; span_id: string; parent_id: string | null; service: string; channel: string; kind: string; name: string; outcome: string; duration: number; partial: boolean }
interface Resource { at: string; service: string; name: string; value: number }
interface Log { at: string; service: string; channel: string; level: string; name: string; trace_id: string | null; fields: Record<string, unknown> }
type Tab = 'overview' | 'endpoints' | 'chat' | 'queues' | 'resources' | 'traces' | 'logs' | 'access';

@Component({
  selector: 'app-observability-page', imports: [DatePipe, DecimalPipe, FormsModule, RouterLink],
  templateUrl: './observability-page.component.html', styleUrl: './observability-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ObservabilityPageComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly auth = inject(SessionAuthService);
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly base = `${environment.DIMA_API}/observability/api`;
  readonly grant = signal<Grant | null>(null);
  readonly channelNames = signal<Record<string, string | null>>({});
  readonly knownChannels = computed(() => Object.entries(this.channelNames()).map(([id,name]) => ({id,name:name || `${this.t('unknownChannel')} (${id})`})).sort((a,b) => a.name.localeCompare(b.name)));
  readonly data = signal<Overview | null>(null);
  readonly tab = signal<Tab>('overview');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly denied = signal(false);
  readonly resources = signal<Resource[]>([]);
  readonly spans = signal<Span[]>([]);
  readonly logs = signal<Log[]>([]);
  readonly grants = signal<AccessGrant[]>([]);
  readonly selectedTrace = signal<{ spans: Span[]; partial: boolean } | null>(null);
  readonly saving = signal(false);
  readonly confirmation = signal<'save' | string | null>(null);
  readonly notice = signal('');
  minutes = 60; service = ''; channel = ''; search = '';
  grantUser = ''; grantRole: 'viewer' | 'investigator' = 'viewer'; grantChannels = ''; grantServices = ''; grantExpires = '';
  private request = 0;
  readonly tabs = computed(() => {
    const result: Tab[] = ['overview', 'endpoints', 'chat', 'queues'];
    if (!this.grant()?.channels.length) result.push('resources');
    if (this.grant()?.role !== 'viewer') result.push('traces', 'logs');
    if (this.grant()?.role === 'owner') result.push('access');
    return result;
  });
  readonly rows = computed(() => (this.data()?.groups || []).filter(row => {
    const tab = this.tab();
    return tab === 'endpoints' ? ['http', 'http_client', 'database', 'cache', 'cache_lookup'].includes(row.kind)
      : tab === 'chat' ? ['chat', 'chat_stage', 'command', 'command_body', 'event'].includes(row.kind)
      : tab === 'queues' ? row.kind.startsWith('queue') : true;
  }));
  readonly streamers = computed(() => {
    const counts = new Map<string, { channel: string; events: number; commands: number; calls: number; waitMs: number }>();
    for (const row of this.data()?.groups || []) {
      if (!row.channel) continue;
      const value = counts.get(row.channel) || { channel: row.channel, events: 0, commands: 0, calls: 0, waitMs: 0 };
      if (row.kind === 'event') value.events += row.count;
      if (row.kind === 'command') value.commands += row.count;
      if (['http_client', 'database', 'cache'].includes(row.kind)) value.calls += row.count;
      if (row.kind === 'queue_wait') value.waitMs += (row.average || 0) * row.count;
      counts.set(row.channel, value);
    }
    return [...counts.values()].sort((a,b) => b.events-a.events).slice(0,30);
  });
  readonly lifecycle = computed(() => (this.data()?.groups || []).filter(r => r.kind === 'lifecycle'));
  readonly runtime = computed(() => (this.data()?.groups || []).filter(r => r.kind === 'runtime'));
  readonly latestResources = computed(() => {
    const seen = new Set<string>();
    return this.resources().filter(r => { const key = r.service + r.name; if (seen.has(key)) return false; seen.add(key); return true; });
  });
  readonly chartMax = computed(() => Math.max(1, ...(this.data()?.timeline || []).flatMap(p => [p.httpRps, p.chatRps])));
  readonly stale = computed(() => { const date = this.data()?.lastAt; return !!date && Date.parse(this.data()!.generatedAt) - Date.parse(date) > 90000; });
  readonly traceStart = computed(() => Math.min(...(this.selectedTrace()?.spans || []).map(s => Date.parse(s.at))));
  readonly traceDuration = computed(() => Math.max(1, ...(this.selectedTrace()?.spans || []).map(s => Date.parse(s.at) + s.duration - this.traceStart())));

  t(key: string): string { return this.language.translate('observability.' + key); }
  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const requested = Number(params.get('minutes'));
    if ([15,60,360,1440,10080].includes(requested)) this.minutes=requested;
    this.service=params.get('service')||''; this.channel=params.get('channel')||'';
    if (['overview','endpoints','chat','queues','resources','traces','logs','access'].includes(params.get('tab')||'')) this.tab.set(params.get('tab') as Tab);
    if (this.auth.token()) await this.initialize();
    const timer = setInterval(() => { if (!document.hidden && this.grant() && !this.loading() && this.tab() !== 'access') void this.refresh(false); },15000);
    this.destroy.onDestroy(() => { clearInterval(timer); this.request++; });
  }
  async initialize(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const session = await firstValueFrom(this.http.get<{ grant: Grant } & NamedChannels>(this.base + '/session'));
      this.grant.set(session.grant); this.channelNames.set(session.channelNames || {}); this.denied.set(false);
      if (!this.tabs().includes(this.tab())) this.tab.set('overview');
      await this.refresh(false);
    } catch (error) { this.handleError(error); } finally { this.loading.set(false); }
  }
  selectTab(tab: Tab): void { this.tab.set(tab); this.selectedTrace.set(null); void this.refresh(); }
  async refresh(updateUrl = true): Promise<void> {
    const id = ++this.request, tab = this.tab();
    this.loading.set(true); this.error.set('');
    if (updateUrl) void this.router.navigate([], { relativeTo: this.route, queryParams: { tab, minutes: this.minutes, service: this.service || null, channel: this.channel || null }, replaceUrl: true });
    let params = new HttpParams().set('minutes',this.minutes);
    if(this.service)params=params.set('service',this.service);
    if(this.channel)params=params.set('channel',this.channel);
    if(this.search)params=params.set('search',this.search);
    try {
      if (tab === 'access') { const value=await firstValueFrom(this.http.get<{grants:AccessGrant[]} & NamedChannels>(this.base+'/grants'));if(id===this.request){this.grants.set(value.grants);this.mergeNames(value);} }
      else if(tab==='traces'){const value=await firstValueFrom(this.http.get<{spans:Span[]} & NamedChannels>(this.base+'/traces',{params}));if(id===this.request){this.spans.set(value.spans);this.mergeNames(value);}}
      else if(tab==='logs'){const value=await firstValueFrom(this.http.get<{logs:Log[]} & NamedChannels>(this.base+'/logs',{params}));if(id===this.request){this.logs.set(value.logs);this.mergeNames(value);}}
      else {
        const [value,resources]=await Promise.all([firstValueFrom(this.http.get<Overview>(this.base+'/overview',{params})),tab==='resources'?firstValueFrom(this.http.get<{samples:Resource[]}>(this.base+'/resources',{params})):Promise.resolve(null)]);
        if(id===this.request){this.data.set(value);this.mergeNames(value);if(resources)this.resources.set(resources.samples);}
      }
    } catch(error){if(id===this.request)this.handleError(error);}finally{if(id===this.request)this.loading.set(false);}
  }
  private handleError(error: unknown): void {
    if(error instanceof HttpErrorResponse){this.denied.set(error.status===401||error.status===403);this.error.set(this.t(error.status===403?'noAccess':error.status===401?'signIn':'unavailable'));}
    else this.error.set(this.t('unavailable'));
  }
  async openTrace(id: string): Promise<void> {
    try { const value=await firstValueFrom(this.http.get<{spans:Span[];partial:boolean} & NamedChannels>(this.base+'/traces/'+id));this.selectedTrace.set(value);this.mergeNames(value); }
    catch(error){this.handleError(error);}
  }
  private mergeNames(value: NamedChannels): void { if(value.channelNames)this.channelNames.update(current => Object.fromEntries(Object.entries({...current,...value.channelNames}).slice(-1000))); }
  channelName(id: string): string { return id ? this.channelNames()[id] || this.t('unknownChannel') : this.t('system'); }
  channelLabel(id: string): string { return id ? `${this.channelName(id)} (${id})` : this.t('system'); }
  channelList(ids: string[]): string { return ids.map(id=>this.channelLabel(id)).join(', '); }
  traceOffset(span: Span): number { return Math.max(0,(Date.parse(span.at)-this.traceStart())/this.traceDuration()*100); }
  traceWidth(span: Span): number { return Math.max(.5,span.duration/this.traceDuration()*100); }
  chartPaths(series:'httpRps'|'chatRps'): string[] {
    const data=this.data();if(!data)return [];
    const start=Date.parse(data.generatedAt)-this.minutes*60000,end=Date.parse(data.generatedAt),paths:string[]=[];
    let previous=0,current='';
    const step=this.minutes>1440?3600000:60000;
    for(const point of data.timeline){const x=Math.max(0,Math.min(680,(point.at-start)/(end-start)*680));const y=160-point[series]/this.chartMax()*145;
      if(point.at-previous>step*1.5){if(current)paths.push(current);current=`M${x},${y}`;}else current+=` L${x},${y}`;
      previous=point.at;
    }
    if(current)paths.push(current);return paths;
  }
  bytes(value:number):string { if(value<1024)return `${value.toFixed(0)} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KiB`;if(value<1073741824)return `${(value/1048576).toFixed(1)} MiB`;return `${(value/1073741824).toFixed(2)} GiB`; }
  resourceValue(row:Resource|Group):string {const value='value'in row?row.value:row.lastValue;return /bytes|Size|^(used_memory|used_memory_rss|maxmemory)$/.test(row.name)?this.bytes(value):`${value.toFixed(2)}${row.name.endsWith('_ms')?' ms':''}`;}
  fields(log:Log):string{return Object.entries(log.fields).map(([k,v])=>`${k}: ${v}`).join(' · ');}
  login():void {sessionStorage.setItem('dimasite.observability-return','1');void this.router.navigate(['/login']);}
  async confirmAccess():Promise<void>{
    const action=this.confirmation();if(!action)return;this.saving.set(true);this.notice.set('');
    try{
      if(action==='save')await firstValueFrom(this.http.put(this.base+'/grants/'+this.grantUser.trim(),{role:this.grantRole,channels:this.grantChannels.split(',').map(x=>x.trim()).filter(Boolean),services:this.grantServices.split(',').map(x=>x.trim()).filter(Boolean),expiresAt:this.grantExpires?new Date(this.grantExpires).toISOString():null}));
      else await firstValueFrom(this.http.delete(this.base+'/grants/'+action));
      this.confirmation.set(null);this.notice.set(this.t('saved'));await this.refresh(false);
    }catch(error){this.error.set(error instanceof HttpErrorResponse&&error.status===400?this.t('invalidGrant'):this.t('unavailable'));}finally{this.saving.set(false);}
  }
}
