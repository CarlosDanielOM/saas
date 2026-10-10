import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../../services/language.service';
import { DuelLeaderboard, DuelRanking } from './duel-api.service';
/** Vertical K/D board: the OBS source and the widget page show the same thing. */
@Component({selector:'app-duel-leaderboard',changeDetection:ChangeDetectionStrategy.OnPush,
  template:`<section class="board" [attr.aria-label]="t('title')">
    <header><span class="kicker">!duel · K/D</span><strong class="title">{{ t('title') }}</strong><span class="subtitle">{{ t('subtitle') }}</span></header>
    @if (board().players.length) {
      <ol>
        @for (row of board().players; track row.login + ':' + row.kills + ':' + row.deaths) {
          <li class="row" [attr.data-rank]="$index + 1" [style.--i]="$index">
            <span class="rank" [attr.aria-label]="t('rank', {n: $index + 1})">{{ $index + 1 }}</span>
            <span class="who"><b>{{ row.login }}</b><small>{{ t('record', {w: row.kills, l: row.deaths}) }}</small></span>
            <span class="kd"><b>{{ kd(row) }}</b><small>K/D</small></span>
          </li>
        }
      </ol>
      <footer>{{ t('footer', {n: board().ranked, d: board().duels}) }}</footer>
    } @else {
      <div class="empty"><span aria-hidden="true">⚔</span><b>{{ t('empty') }}</b><small>{{ t('emptyHint') }}</small></div>
    }
  </section>`,
  styles:`:host{display:block;container-type:inline-size;font-family:"Plus Jakarta Sans","Segoe UI",system-ui,sans-serif;color:#f5f7fb}
*{box-sizing:border-box}
.board{padding:6cqw 5cqw 5cqw;border:1px solid #aa91ff40;border-radius:6cqw;background:radial-gradient(ellipse at 20% 0%,#59368955,transparent 60%),#11101de8;box-shadow:0 0 40px #8b5cf622}
header{display:grid;gap:1cqw;margin-bottom:5cqw}
.kicker{color:#c6b3ff;font-size:3.4cqw;font-weight:800;letter-spacing:.2em;text-transform:uppercase}
.title{font-size:8.6cqw;line-height:1.05;font-weight:900;letter-spacing:-.04em}
.subtitle{color:#c9c1d9;font-size:3.6cqw}
ol{display:grid;gap:2.2cqw;margin:0;padding:0;list-style:none}
.row{display:grid;grid-template-columns:10cqw minmax(0,1fr) auto;align-items:center;gap:3.4cqw;padding:2.6cqw 3.4cqw;border:1px solid #ffffff14;border-radius:3.4cqw;background:#ffffff0d;--tone:#b798ff;animation:enter .6s cubic-bezier(.2,.9,.3,1.2) both,glow 1.6s ease-out both;animation-delay:calc(var(--i) * 70ms)}
.row[data-rank="1"]{--tone:#ffd68e;background:linear-gradient(90deg,#ffc56826,#ffffff0d 70%);border-color:#ffd68e66}
.row[data-rank="2"]{--tone:#dfe4f0;border-color:#dfe4f040}
.row[data-rank="3"]{--tone:#e7a878;border-color:#e7a87840}
.rank{display:grid;place-items:center;width:10cqw;aspect-ratio:1;border-radius:50%;font-size:4.6cqw;font-weight:900;color:#11101d;background:var(--tone);box-shadow:0 0 14px color-mix(in srgb,var(--tone) 55%,transparent)}
.row:not([data-rank="1"]):not([data-rank="2"]):not([data-rank="3"]) .rank{color:#f5f7fb;background:#ffffff14;box-shadow:none}
.who{display:grid;gap:.6cqw;min-width:0}
.who b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:5cqw;font-weight:850;letter-spacing:-.02em}
.who small,.kd small{color:#c9c1d9;font-size:3.2cqw;font-variant-numeric:tabular-nums}
.kd{display:grid;justify-items:end;gap:.2cqw}
.kd b{font-size:6.6cqw;line-height:1;font-weight:950;color:var(--tone);font-variant-numeric:tabular-nums}
.kd small{font-weight:800;letter-spacing:.14em}
footer{margin-top:4cqw;color:#c9c1d9;font-size:3.2cqw;text-align:center}
.empty{display:grid;justify-items:center;gap:1.6cqw;padding:8cqw 0 4cqw;text-align:center}
.empty span{font-size:12cqw;color:#c6b3ff}
.empty b{font-size:5cqw}
.empty small{color:#c9c1d9;font-size:3.6cqw}
@keyframes enter{from{opacity:0;translate:12cqw 0}to{opacity:1;translate:0}}
@keyframes glow{from{box-shadow:0 0 0 2px var(--tone),0 0 30px var(--tone)}to{box-shadow:0 0 0 0 transparent}}
@media(prefers-reduced-motion:reduce){.row{animation:none}}`})
export class DuelLeaderboardComponent {
  private readonly language=inject(LanguageService);
  readonly board=input<DuelLeaderboard>({players:[],ranked:0,duels:0});
  readonly locale=input<'en'|'es'>('en');
  private readonly number=computed(()=>new Intl.NumberFormat(this.locale(),{minimumFractionDigits:2,maximumFractionDigits:2}));
  t(key:string,params?:Record<string,string|number>):string{return this.language.translate('duelWidget.board.'+key,params,this.locale());}
  kd(row:DuelRanking):string{return this.number().format(row.kd);}
}
