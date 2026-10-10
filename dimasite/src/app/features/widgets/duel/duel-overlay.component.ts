import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { LinksService } from '../../../services/links.service';
import { LanguageService } from '../../../services/language.service';
import { DuelState } from './duel-api.service';
import { DuelArenaComponent } from './duel-arena.component';
import { DuelBattle, legacyBattle } from './duel-battle';
@Component({selector:'app-duel-overlay',imports:[DuelArenaComponent],changeDetection:ChangeDetectionStrategy.OnPush,
  template:`@if (visible(); as current) {
    @if (current.challenge; as challenge) { <section class="challenge" role="status"><span>!duel</span>@if (challenge.enraged) { <strong class="enraged">{{ t('enragedChallenge') }}</strong> }<h1>{{ t('challengeTitle', {name:challenge.opponent}) }}</h1><p>{{ t('challengeFrom', {name:challenge.challenger, seconds:secondsLeft()}) }}</p><div class="countdown-bar" aria-hidden="true"><i [style.width.%]="secondsLeft() / 30 * 100"></i></div><strong>!duel accept · !duel decline</strong></section> }
    @else if (current.run; as run) { <app-duel-arena [names]="{left:run.challenger,right:run.opponent}" [battle]="battle()" [elapsed]="elapsed()" [started]="true" [transparent]="true" [locale]="current.settings.language" [record]="run.record ?? null" /> }
  }`,
  styles:`:host{display:block;width:100%;max-width:1920px}.challenge{box-sizing:border-box;margin:8% auto;padding:3rem;max-width:800px;text-align:center;background:#11101de8;color:#fff;border:1px solid #aa91ff;border-radius:24px;font-family:system-ui}.challenge span{color:#c6b3ff}.challenge h1{font-size:clamp(24px,4vw,48px);overflow-wrap:anywhere}.challenge p{color:#dbd5ee}.challenge strong{display:block;margin-top:24px;color:#ffd68e}.countdown-bar{height:8px;margin:16px auto 0;max-width:420px;border-radius:99px;background:#ffffff1f;overflow:hidden}.countdown-bar i{display:block;height:100%;margin:auto;background:linear-gradient(90deg,#aa91ff,#ffd68e);transition:width 1s linear}.challenge .enraged{margin:12px 0 0;color:#ff8a8a;text-transform:uppercase;letter-spacing:.08em;text-shadow:0 0 12px #ff3b3b}@media(max-width:480px){.challenge{padding:24px;margin:16px}}`})
export class DuelOverlayComponent {
  readonly state=signal<DuelState|null>(null);
  readonly now=signal(Date.now());
  private offset=0;
  private readonly language=inject(LanguageService);
  // Runs accepted before turn-based battles carry only a winner.
  readonly battle=computed<DuelBattle>(()=>{const run=this.state()?.run;if(!run)return legacyBattle('left');return run.fighters&&run.turns?.length?{fighters:run.fighters,turns:run.turns,winner:run.winner,duration:run.endsAt-run.startedAt,enraged:run.enraged??null}:legacyBattle(run.winner);});
  /** Seconds left to accept the challenge (challenges last 30 s). */
  readonly secondsLeft=computed(()=>{const challenge=this.state()?.challenge;return challenge?Math.max(0,Math.ceil((challenge.expiresAt-this.now()-this.offset)/1000)):0;});
  readonly elapsed=computed(()=>Math.max(0,Math.min(this.battle().duration,this.now()+this.offset-(this.state()?.run?.startedAt??0))));
  readonly visible=computed(()=>{const s=this.state();if(!s?.settings.enabled)return null;const now=this.now()+this.offset;if(s.challenge&&s.challenge.expiresAt>now)return s;return s.run?.mode==='overlay'&&now<s.run.endsAt+6000?s:null;});
  t(key:string,params?:Record<string,string|number>):string {return this.language.translate('duelWidget.'+key,params,this.state()?.settings.language??'en');}
  constructor(){
    const route=inject(ActivatedRoute).snapshot,doc=inject(DOCUMENT),destroy=inject(DestroyRef);
    const previous=[doc.body.style.background,doc.documentElement.style.background];doc.body.style.background='transparent';doc.documentElement.style.background='transparent';
    const channel=route.paramMap.get('channelID')??'',token=route.fragment??'';
    const socket=/^[0-9]{1,30}$/.test(channel)&&/^[\w-]{43}$/.test(token)?io(`${inject(LinksService).getApiUrl()}/overlays/duel/${channel}`,{auth:{token},transports:['websocket'],reconnection:true}):null;
    socket?.on('duel-state',(state:DuelState)=>{this.offset=state.serverTime-Date.now();this.state.set(state);this.now.set(Date.now());socket.emit('duel-ready',{version:1});});
    const clear=()=>this.state.set(null);socket?.on('disconnect',clear);socket?.on('connect_error',clear);socket?.on('duel-error',clear);
    const timer=setInterval(()=>this.now.set(Date.now()),40),heartbeat=setInterval(()=>{if(socket?.connected&&this.state())socket.emit('duel-ready',{version:1});},2000);
    destroy.onDestroy(()=>{clearInterval(timer);clearInterval(heartbeat);socket?.disconnect();doc.body.style.background=previous[0];doc.documentElement.style.background=previous[1];});
  }
}
