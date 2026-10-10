import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { DuelBattle, DuelSide, COMBO_HEAL, legacyBattle, otherSide, turnLength } from '../../../widgets/duel/duel-battle';
import { LanguageService } from '../../../../services/language.service';
import { DuelAstra3dScene, DuelSceneStats, healthAt } from './duel-astra-3d-scene';

@Component({
  selector:'app-duel-astra-3d-arena',
  templateUrl:'./duel-astra-3d-arena.component.html',
  styleUrl:'./duel-astra-3d-arena.component.css',
  changeDetection:ChangeDetectionStrategy.OnPush,
})
export class DuelAstra3dArenaComponent {
  readonly names=input({left:'Dima',right:'ChatChampion'});
  readonly battle=input<DuelBattle>(legacyBattle('left'));
  readonly elapsed=input(0);
  readonly started=input(false);
  readonly paused=input(false);
  readonly transparent=input(false);
  readonly locale=input<'en'|'es'>('en');
  readonly canvas=viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly unavailable=signal(false);
  readonly stats=signal<DuelSceneStats>({fps:0,calls:0,triangles:0});
  private readonly language=inject(LanguageService);
  readonly sides:DuelSide[]=['left','right'];
  readonly health=computed(()=>healthAt(this.battle(),this.elapsed(),this.started()));
  readonly phase=computed(()=>!this.started()?'ready':this.elapsed()<1300?'entrance':this.elapsed()<3400?'countdown':this.elapsed()<(this.battle().turns.at(-1)?.hitAt??0)?'fight':this.elapsed()<this.battle().duration?'knockout':'winner');
  readonly turnIndex=computed(()=>{
    if(!this.started())return -1;
    const turns=this.battle().turns;
    let index=-1;
    while(index+1<turns.length&&turns[index+1].at<=this.elapsed())index++;
    return index;
  });
  readonly current=computed(()=>{const turn=this.battle().turns[this.turnIndex()];return turn&&this.elapsed()<turn.at+(turn.move==='ultimate'?5000:turnLength(turn))?turn:null;});
  readonly ultimate=computed(()=>this.current()?.move==='ultimate'&&this.phase()!=='winner'?this.current():null);
  readonly impact=computed(()=>{const turn=this.current();return turn&&this.elapsed()>=turn.hitAt&&this.elapsed()<turn.hitAt+850?turn:null;});
  readonly countdown=computed(()=>Math.max(1,3-Math.floor((this.elapsed()-1300)/700)));
  readonly ultimateProgress=computed(()=>{const turn=this.ultimate();return turn?Math.min(1,(this.elapsed()-turn.at)/(turn.hitAt-turn.at)):0;});
  readonly damageSide=computed(()=>this.impact()?.move==='heal'?this.impact()!.attacker:this.impact()?otherSide(this.impact()!.attacker):null);
  readonly charges=computed(()=>{
    const max=this.battle().healCharges??5,left={left:max,right:max};
    if(this.started())for(const turn of this.battle().turns){if(turn.at>this.elapsed())break;if(turn.move==='heal')left[turn.attacker]--;if(turn.comboHeal&&this.elapsed()>=turn.hitAt+COMBO_HEAL.delay)left[otherSide(turn.attacker)]--;}
    return left;
  });
  constructor() {
    const destroy=inject(DestroyRef);
    afterNextRender(()=>{
      let scene:DuelAstra3dScene|undefined;
      try {
        scene=new DuelAstra3dScene(this.canvas().nativeElement,()=>({battle:this.battle(),elapsed:this.elapsed(),started:this.started(),paused:this.paused(),transparent:this.transparent()}),stats=>this.stats.set(stats),()=>this.unavailable.set(true));
      } catch {this.unavailable.set(true);}
      destroy.onDestroy(()=>scene?.dispose());
    });
  }
  t(key:string,params?:Record<string,string|number>):string{return this.language.translate('duelMock.'+key,params,this.locale());}
  hpPercent(side:DuelSide):number{return this.health()[side]/(this.battle().maxHp??100)*100;}
  turnLabel():string {
    const turn=this.current();if(!turn)return this.t('phase.'+this.phase());
    const character=this.battle().fighters[turn.attacker];
    return this.t(turn.move==='ultimate'?'ultimate.'+character:turn.move==='heal'?'heal.'+character:turn.move==='special'?'special.'+character:'move.'+turn.move);
  }
}
