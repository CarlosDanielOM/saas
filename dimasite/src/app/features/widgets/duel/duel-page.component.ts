import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import { UpgradeService } from '../../../services/upgrade.service';
import { getRouteParam } from '../../../shared/utils/route-param.util';
import { MODULE_TIER_REQUIREMENTS, isModuleAccessible } from '../../modules/module-tier.model';
import { DuelApi, DuelLeaderboard, DuelRecord, DuelSettings, DuelState } from './duel-api.service';
import { DuelArenaComponent } from './duel-arena.component';
import { DuelLeaderboardComponent } from './duel-leaderboard.component';
import { simulateBattle, ultimateBattle } from './duel-battle';
@Component({selector:'app-duel-page',imports:[ReactiveFormsModule,RouterLink,DuelArenaComponent,DuelLeaderboardComponent],templateUrl:'./duel-page.component.html',styleUrls:['../widgets-base.css','./duel-page.component.css'],changeDetection:ChangeDetectionStrategy.OnPush})
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
  private seenCompletion:number|null|undefined;
  private pending:{settings:DuelSettings;revision:number;key:string}|null=null;
  private readonly fb=inject(FormBuilder).nonNullable;
  readonly form=this.fb.group({enabled:true,timeoutEnabled:true,timeoutSeconds:[60,[Validators.required,Validators.min(1),Validators.max(1209600),Validators.pattern(/^\d+$/)]],language:this.fb.control<'en'|'es'>('en')});
  readonly elapsed=signal(0);readonly started=signal(false);readonly battle=signal(simulateBattle());readonly streamerFight=signal(false);private previewStarted=0;
  /** Sample head-to-head for the preview (sometimes a first meeting). */
  readonly previewRecord=signal<DuelRecord>({left:4,right:2});
  constructor(){
    const destroy=inject(DestroyRef);destroy.onDestroy(()=>{this.stopped=true;});
    void this.load();const poll=setInterval(()=>{if(this.channel&&!this.busy())void this.refresh();},1500);
    const clock=setInterval(()=>{if(this.started())this.elapsed.set(Math.min(this.battle().duration,performance.now()-this.previewStarted));},40);
    destroy.onDestroy(()=>{clearInterval(poll);clearInterval(clock);});
  }
  t(key:string,params?:Record<string,string|number>):string{return this.language.translate('duelWidget.'+key,params);}
  promptUpgrade():void{void this.upgrade.promptUpgradeForModule({moduleId:'widgets',source:'duel_widget'});}
  private apply(state:DuelState):void{if(this.stopped)return;this.state.set(state);
    // A finished fight may have changed the rankings.
    const completed=state.run?.completedAt??null;if(completed!==this.seenCompletion){this.seenCompletion=completed;void this.loadLeaderboard();}if(!this.form.dirty&&!this.pending){this.form.patchValue(state.settings);this.formRevision=state.revision;}}
  private async load():Promise<void>{try{this.channel=(await firstValueFrom(this.auth.resolveChannelID(this.streamer)))??'';if(this.premium()&&this.channel){this.apply(await this.api.read(this.channel));try{this.overlayUrl.set(sessionStorage.getItem('duel-overlay-'+this.channel)??'');}catch{}}}catch{this.error.set(this.t('loadError'));}finally{this.loading.set(false);}}
  async refresh():Promise<void>{if(this.refreshing)return;this.refreshing=true;try{this.apply(await this.api.read(this.channel));}catch{this.error.set(this.t('loadError'));}finally{this.refreshing=false;}}
  async save():Promise<void>{this.form.markAllAsTouched();if(this.form.invalid||this.busy()||!this.state())return;this.busy.set(true);this.error.set('');this.notice.set('');
    const request=this.pending??{settings:this.form.getRawValue(),revision:this.formRevision,key:crypto.randomUUID()};this.pending=request;
    try{const state=await this.api.save(this.channel,request.settings,request.revision,request.key);this.pending=null;this.uncertainSave.set(false);this.form.markAsPristine();this.apply(state);this.notice.set(this.t('saved'));}
    catch(error){if(error instanceof HttpErrorResponse&&error.status===409){this.pending=null;this.error.set(this.t('conflict'));}else {this.uncertainSave.set(true);this.error.set(this.t('saveError'));}}finally{this.busy.set(false);}}
  async reload():Promise<void>{this.pending=null;this.uncertainSave.set(false);this.form.markAsPristine();this.error.set('');await this.refresh();}
  async createLink():Promise<void>{if(this.busy())return;if(this.overlayUrl()&&!this.rotateConfirm()){this.rotateConfirm.set(true);return;}this.busy.set(true);this.error.set('');try{const token=await this.api.token(this.channel);const url=location.origin+'/overlays/duel/'+this.channel+'#'+token;this.overlayUrl.set(url);this.rotateConfirm.set(false);try{sessionStorage.setItem('duel-overlay-'+this.channel,url);}catch{}await this.refresh();}catch{this.error.set(this.t('linkError'));}finally{this.busy.set(false);}}
  async loadLeaderboard():Promise<void>{try{const board=await this.api.leaderboard(this.channel);if(!this.stopped){this.leaderboard.set(board);this.leaderboardError.set(false);}}catch{this.leaderboardError.set(true);}}
  async copyLink(board=false):Promise<void>{try{await navigator.clipboard.writeText(board?this.leaderboardUrl():this.overlayUrl());this.notice.set(this.t(board?'leaderboardCopied':'copied'));}catch{this.error.set(this.t('copyError'));}}
  preview(ultimate=false):void{const enraged=this.streamerFight()?'right':null;this.battle.set(ultimate?ultimateBattle(enraged):simulateBattle(Math.random,enraged));const wins=()=>Math.floor(Math.random()*7);this.previewRecord.set(Math.random()<.2?{left:0,right:0}:{left:wins(),right:wins()});this.elapsed.set(0);this.previewStarted=performance.now();this.started.set(true);}
}
