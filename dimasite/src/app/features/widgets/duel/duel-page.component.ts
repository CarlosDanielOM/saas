import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { debounceTime, firstValueFrom, map } from 'rxjs';
import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import { UpgradeService } from '../../../services/upgrade.service';
import { getRouteParam } from '../../../shared/utils/route-param.util';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { MODULE_TIER_REQUIREMENTS, isModuleAccessible } from '../../modules/module-tier.model';
import { DuelApi, DuelLeaderboard, DuelLeaderboardStatus, DuelRecord, DuelSettings, DuelState } from './duel-api.service';
import { DuelArenaComponent } from './duel-arena.component';
import { DuelLeaderboardComponent } from './duel-leaderboard.component';
import { duelBalance, simulateBattle, ultimateBattle } from './duel-battle';
import { DEFAULT_DUEL_RULES, DUEL_RULE_GROUPS, DUEL_RULE_KEYS, DuelRuleKey, DuelRules, DuelRuleSpec, changedDuelRules, isDefaultDuelRules, normalizeDuelRules } from './duel-rules';
type RulesForm = FormGroup<Record<DuelRuleKey, FormControl<number>>>;
const healRange = (group: AbstractControl): ValidationErrors | null => { const value = group.value as DuelRules; return value.healMin > value.healMax ? { healRange: true } : null; };
/** The rules' balance check is a snapshot of these defaults, so it is computed once. */
const DEFAULT_BALANCE = duelBalance();
@Component({selector:'app-duel-page',imports:[ReactiveFormsModule,RouterLink,LfIconComponent,DuelArenaComponent,DuelLeaderboardComponent],templateUrl:'./duel-page.component.html',styleUrls:['../widgets-base.css','./duel-page.component.css'],changeDetection:ChangeDetectionStrategy.OnPush})
export class DuelPageComponent {
  private readonly auth=inject(SessionAuthService);
  private readonly api=inject(DuelApi);
  private readonly upgrade=inject(UpgradeService);
  readonly language=inject(LanguageService);
  readonly streamer=getRouteParam(inject(ActivatedRoute),'streamer')??'';
  readonly premium=computed(()=>isModuleAccessible(MODULE_TIER_REQUIREMENTS.widgets,this.auth.getPlanTierForStreamer(this.streamer)));
  readonly state=signal<DuelState|null>(null);readonly loading=signal(true);readonly busy=signal(false);readonly error=signal('');readonly notice=signal('');readonly overlayUrl=signal('');readonly rotateConfirm=signal(false);readonly uncertainSave=signal(false);
  private channel='';private formRevision=0;private stopped=false;private refreshing=false;
  readonly leaderboard=signal<DuelLeaderboard|null>(null);readonly leaderboardError=signal(false);
  /** The vertical leaderboard source shares the private overlay token. */
  readonly leaderboardUrl=computed(()=>this.overlayUrl().replace('#','/leaderboard#'));
  private seenBoardKey:string|undefined;
  private pending:{settings:DuelSettings;revision:number;key:string}|null=null;
  private readonly fb=inject(FormBuilder).nonNullable;
  readonly groups=DUEL_RULE_GROUPS;readonly defaults=DEFAULT_DUEL_RULES;
  /** Opens once on load when custom rules are saved; afterwards the streamer decides. */
  readonly rulesOpen=signal(false);private rulesOpened=false;
  readonly form=this.fb.group({enabled:true,timeoutEnabled:true,timeoutSeconds:[60,[Validators.required,Validators.min(1),Validators.max(1209600),Validators.pattern(/^\d+$/)]],language:this.fb.control<'en'|'es'>('en'),
    leaderboard:true,rivalries:true,
    rules:new FormGroup(Object.fromEntries(DUEL_RULE_KEYS.map(key=>[key,new FormControl(DEFAULT_DUEL_RULES[key],{nonNullable:true})])) as Record<DuelRuleKey,FormControl<number>>,{validators:healRange}) as RulesForm});
  /** Draft values as signals: the balance check and chips follow the sliders live. */
  readonly draft=toSignal(this.form.valueChanges.pipe(map(()=>this.form.getRawValue())),{initialValue:this.form.getRawValue()});
  readonly draftRules=computed(()=>normalizeDuelRules(this.draft().rules));
  readonly customDraft=computed(()=>!isDefaultDuelRules(this.draftRules()));
  readonly changed=computed(()=>changedDuelRules(this.draftRules()));
  readonly balance=toSignal(this.form.controls.rules.valueChanges.pipe(debounceTime(150),map(()=>duelBalance(normalizeDuelRules(this.form.controls.rules.getRawValue())))),{initialValue:DEFAULT_BALANCE});
  readonly defaultBalance=DEFAULT_BALANCE;
  /** Saved state, for the header chips. */
  readonly savedCustom=computed(()=>{const state=this.state();return !!state&&!isDefaultDuelRules(state.settings.rules);});
  readonly boardStatus=computed<DuelLeaderboardStatus>(()=>{const settings=this.state()?.settings;return !settings||settings.leaderboard?(this.savedCustom()?'paused':'live'):'off';});
  /** Saving custom rules while tracking is on pauses it, so that save asks first. */
  readonly pausesTracking=computed(()=>{const draft=this.draft();return this.customDraft()&&!this.savedCustom()&&(draft.leaderboard||draft.rivalries);});
  readonly confirmPause=signal(false);
  readonly dirty=signal(false);
  readonly elapsed=signal(0);readonly started=signal(false);readonly battle=signal(simulateBattle());readonly streamerFight=signal(false);private previewStarted=0;
  /** Sample head-to-head for the preview (sometimes a first meeting). */
  readonly previewRecord=signal<DuelRecord>({left:4,right:2});
  readonly previewRules=signal(false);
  constructor(){
    const destroy=inject(DestroyRef);destroy.onDestroy(()=>{this.stopped=true;});
    // Until a preview plays, the idle arena shows the current rules' HP and heal charges.
    this.form.valueChanges.subscribe(()=>{this.dirty.set(this.form.dirty);this.confirmPause.set(false);if(!this.started()&&this.form.controls.rules.valid)this.battle.set(simulateBattle(Math.random,null,this.draftRules()));});
    void this.load();const poll=setInterval(()=>{if(this.channel&&!this.busy())void this.refresh();},1500);
    const clock=setInterval(()=>{if(this.started())this.elapsed.set(Math.min(this.battle().duration,performance.now()-this.previewStarted));},40);
    destroy.onDestroy(()=>{clearInterval(poll);clearInterval(clock);});
  }
  t(key:string,params?:Record<string,string|number>):string{return this.language.translate('duelWidget.'+key,params);}
  promptUpgrade():void{void this.upgrade.promptUpgradeForModule({moduleId:'widgets',source:'duel_widget'});}
  private apply(raw:DuelState):void{if(this.stopped)return;
    // Settings saved before tracking switches and rules existed read as the defaults.
    const state={...raw,settings:{...raw.settings,leaderboard:raw.settings.leaderboard??true,rivalries:raw.settings.rivalries??true,rules:normalizeDuelRules(raw.settings.rules)}};this.state.set(state);
    // A finished fight or a tracking change may change the board.
    const key=`${state.run?.completedAt??null}:${state.settings.leaderboard}:${isDefaultDuelRules(state.settings.rules)}`;if(key!==this.seenBoardKey){this.seenBoardKey=key;void this.loadLeaderboard();}
    // Only patch real changes: every patch re-runs the balance simulation.
    if(!this.rulesOpened){this.rulesOpened=true;if(!isDefaultDuelRules(state.settings.rules))this.rulesOpen.set(true);}
    if(!this.form.dirty&&!this.pending){const next=state.settings;if(JSON.stringify(next)!==JSON.stringify(this.form.getRawValue()))this.form.patchValue(next);this.formRevision=state.revision;}}
  private async load():Promise<void>{try{this.channel=(await firstValueFrom(this.auth.resolveChannelID(this.streamer)))??'';if(this.premium()&&this.channel){this.apply(await this.api.read(this.channel));try{this.overlayUrl.set(sessionStorage.getItem('duel-overlay-'+this.channel)??'');}catch{}}}catch{this.error.set(this.t('loadError'));}finally{this.loading.set(false);}}
  async refresh():Promise<void>{if(this.refreshing)return;this.refreshing=true;try{this.apply(await this.api.read(this.channel));}catch{this.error.set(this.t('loadError'));}finally{this.refreshing=false;}}
  async save():Promise<void>{this.form.markAllAsTouched();if(this.form.invalid||this.busy()||!this.state())return;
    if(!this.pending&&this.pausesTracking()&&!this.confirmPause()){this.confirmPause.set(true);return;}
    this.busy.set(true);this.error.set('');this.notice.set('');this.confirmPause.set(false);
    const request=this.pending??{settings:this.form.getRawValue(),revision:this.formRevision,key:crypto.randomUUID()};this.pending=request;
    try{const state=await this.api.save(this.channel,request.settings,request.revision,request.key);this.pending=null;this.uncertainSave.set(false);this.form.markAsPristine();this.dirty.set(false);this.apply(state);this.notice.set(this.t('saved'));}
    catch(error){if(error instanceof HttpErrorResponse&&error.status===409){this.pending=null;this.error.set(this.t('conflict'));}else {this.uncertainSave.set(true);this.error.set(this.t('saveError'));}}finally{this.busy.set(false);}}
  async reload():Promise<void>{this.pending=null;this.uncertainSave.set(false);this.form.markAsPristine();this.dirty.set(false);this.error.set('');await this.refresh();}
  /** Back to the last saved settings. */
  discard():void{const state=this.state();if(!state||this.busy()||this.uncertainSave())return;this.form.reset({...state.settings,rules:normalizeDuelRules(state.settings.rules)});this.form.markAsPristine();this.dirty.set(false);this.confirmPause.set(false);}
  resetRules():void{this.form.controls.rules.setValue(normalizeDuelRules(null));this.form.markAsDirty();this.dirty.set(true);}
  async createLink():Promise<void>{if(this.busy())return;if(this.overlayUrl()&&!this.rotateConfirm()){this.rotateConfirm.set(true);return;}this.busy.set(true);this.error.set('');try{const token=await this.api.token(this.channel);const url=location.origin+'/overlays/duel/'+this.channel+'#'+token;this.overlayUrl.set(url);this.rotateConfirm.set(false);try{sessionStorage.setItem('duel-overlay-'+this.channel,url);}catch{}await this.refresh();}catch{this.error.set(this.t('linkError'));}finally{this.busy.set(false);}}
  async loadLeaderboard():Promise<void>{try{const board=await this.api.leaderboard(this.channel);if(!this.stopped){this.leaderboard.set(board);this.leaderboardError.set(false);}}catch{this.leaderboardError.set(true);}}
  async copyLink(board=false):Promise<void>{try{await navigator.clipboard.writeText(board?this.leaderboardUrl():this.overlayUrl());this.notice.set(this.t(board?'leaderboardCopied':'copied'));}catch{this.error.set(this.t('copyError'));}}
  /** Previews play the draft rules, so a streamer sees a change before saving it. */
  preview(ultimate=false):void{const enraged=this.streamerFight()?'right':null,rules=this.draftRules();this.previewRules.set(this.customDraft());this.battle.set(ultimate?ultimateBattle(enraged,rules):simulateBattle(Math.random,enraged,rules));const wins=()=>Math.floor(Math.random()*7);this.previewRecord.set(Math.random()<.2?{left:0,right:0}:{left:wins(),right:wins()});this.elapsed.set(0);this.previewStarted=performance.now();this.started.set(true);}
  /** "120 HP", "15%", "×2.0", "4.0%" (per mille), "5". */
  format(spec:DuelRuleSpec,value:number):string{const locale=this.language.currentLanguage(),number=(n:number,digits=0)=>new Intl.NumberFormat(locale,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n);
    switch(spec.unit){case 'hp':return `${number(value)} HP`;case 'percent':return `${number(value)}%`;case 'multiplier':return `×${number(value/100,1)}`;case 'permille':return `${number(value/10,1)}%`;default:return number(value);}}
  /** Slider fill: the track is coloured up to the thumb. */
  pct(spec:DuelRuleSpec,value:number):number{return (value-spec.min)/(spec.max-spec.min);}
  value(key:DuelRuleKey):number{return this.draftRules()[key];}
  percent(share:number):string{return new Intl.NumberFormat(this.language.currentLanguage(),{style:'percent',maximumFractionDigits:0}).format(share);}
  seconds(ms:number):number{return Math.round(ms/1000);}
  /** Flags a stat that moved well away from the tuned defaults. */
  drift(kind:'streamer'|'length'):boolean{const now=this.balance(),base=this.defaultBalance;
    return kind==='streamer'?Math.abs(now.streamerWin-base.streamerWin)>=.05:now.typical[1]>base.typical[1]*1.5||now.typical[0]<base.typical[0]*.6;}
}
