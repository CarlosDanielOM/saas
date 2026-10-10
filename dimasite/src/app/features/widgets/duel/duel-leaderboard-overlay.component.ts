import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { LinksService } from '../../../services/links.service';
import { DuelLeaderboard } from './duel-api.service';
import { DuelLeaderboardComponent } from './duel-leaderboard.component';
type Board = DuelLeaderboard & { enabled:boolean; language:'en'|'es' };
/** Vertical OBS source for the K/D leaderboard; it shares the duel overlay's private token. */
@Component({selector:'app-duel-leaderboard-overlay',imports:[DuelLeaderboardComponent],changeDetection:ChangeDetectionStrategy.OnPush,
  // Hidden while the duel or the leaderboard is off, and while custom battle rules pause it.
  template:`@if (board(); as current) { @if (current.enabled && (current.status ?? 'live') === 'live') { <app-duel-leaderboard [board]="current" [locale]="current.language" /> } }`,
  styles:`:host{display:block;width:100%;max-width:100vw}`})
export class DuelLeaderboardOverlayComponent {
  readonly board=signal<Board|null>(null);
  constructor(){
    const route=inject(ActivatedRoute).snapshot,doc=inject(DOCUMENT),destroy=inject(DestroyRef);
    const previous=[doc.body.style.background,doc.documentElement.style.background];doc.body.style.background='transparent';doc.documentElement.style.background='transparent';
    const channel=route.paramMap.get('channelID')??'',token=route.fragment??'';
    const socket=/^[0-9]{1,30}$/.test(channel)&&/^[\w-]{43}$/.test(token)?io(`${inject(LinksService).getApiUrl()}/overlays/duel/${channel}`,{auth:{token,view:'leaderboard'},transports:['websocket'],reconnection:true}):null;
    socket?.on('duel-leaderboard',(board:Board)=>this.board.set(board));
    // A revoked link or lost Premium ends the source; network blips keep the last board on screen.
    socket?.on('disconnect',reason=>{if(reason==='io server disconnect')this.board.set(null);});
    socket?.on('connect_error',error=>{if(/token/i.test(error.message))this.board.set(null);});
    destroy.onDestroy(()=>{socket?.disconnect();doc.body.style.background=previous[0];doc.documentElement.style.background=previous[1];});
  }
}
