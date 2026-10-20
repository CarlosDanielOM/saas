import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Check, LucideAngularModule } from 'lucide-angular';

import { LpCopy } from './lp-copy';
import { FREE_MODULES, LpLive, MODULES, PAID_MODULES, PLAN_CREDITS, PLAN_PRICE, PlanKey } from './lp-live.service';

const KEYS: PlanKey[] = ['free', 'premium', 'pro'];

/** Values from the Plans guide (dimadocs/plans.mdx); text cells are copy keys. */
const ROWS: { key: string; values: Record<PlanKey, string | number | [string, number]> }[] = [
  { key: 'credits', values: { free: PLAN_CREDITS.free, premium: PLAN_CREDITS.premium, pro: PLAN_CREDITS.pro } },
  { key: 'cooldown', values: { free: ['sec', 5], premium: ['sec', 3], pro: ['sec', 1] } },
  { key: 'storage', values: { free: 'none', premium: '250 MB', pro: '1 GB' } },
  { key: 'upload', values: { free: '5 MB', premium: '25 MB', pro: '100 MB' } },
  { key: 'bandwidth', values: { free: '10 GB', premium: '1 TB', pro: 'unlimited' } },
  { key: 'history', values: { free: ['days', 30], premium: ['days', 180], pro: ['days', 365] } },
  { key: 'memory', values: { free: ['days', 15], premium: ['days', 45], pro: ['days', 120] } }
];

/** Plan cards with value cues computed from the real prices and credits. */
@Component({
  selector: 'app-lp-plans',
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./lp-ui.css'],
  styles: `
    .plans { display: grid; gap: 0.75rem; }
    .plan { display: grid; gap: 0.7rem; align-content: start; position: relative; }
    .plan--rec { border-color: #7c3aed; box-shadow: 0 0 0 1px #7c3aed, var(--shadow); }
    .plan--paid .plan__name { color: var(--gold); }
    .plan__top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem; }
    .plan__name { margin: 0; font-weight: 800; font-size: 1rem; }
    .plan__price { margin: 0; font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .plan__price span { font-size: 0.9rem; font-weight: 600; color: var(--muted); letter-spacing: 0; }
    .plan__credits { margin: 0; font-weight: 700; font-size: 0.92rem; }
    .plan__cue { margin: 0; color: var(--muted); font-size: 0.84rem; }
    .plan ul { display: grid; gap: 0.45rem; margin: 0; padding: 0; list-style: none; font-size: 0.88rem; line-height: 1.4; }
    .plan li { display: grid; grid-template-columns: 1rem 1fr; gap: 0.5rem; }
    .plan li lucide-icon { color: var(--ok); margin-top: 0.15rem; }
    .plan .lp-btn { width: 100%; }
    .compare { margin-top: 0.75rem; padding: 0; overflow: hidden; }
    .compare summary {
      display: flex; align-items: center; min-height: 48px; padding: 0 1.1rem; cursor: pointer; font-weight: 700;
      list-style: none;
    }
    .compare summary::-webkit-details-marker { display: none; }
    .compare summary::after { content: '+'; margin-left: auto; font-size: 1.2rem; color: var(--muted); }
    .compare[open] summary::after { content: '–'; }
    .row {
      display: grid; grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, 1fr)); gap: 0.4rem;
      padding: 0.6rem 1.1rem; border-top: 1px solid var(--line); font-size: 0.82rem; align-items: center;
    }
    .row span:not(:first-child) { font-variant-numeric: tabular-nums; }
    .row--head { color: var(--muted); font-weight: 800; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; }
    .compare .lp-note { padding: 0.7rem 1.1rem 1rem; border-top: 1px solid var(--line); }
    @media (min-width: 960px) {
      .plans { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .row { font-size: 0.9rem; }
    }
  `,
  template: `
    <div class="plans">
      @for (p of plans(); track p.key) {
        <article class="lp-tile plan" [class.plan--paid]="p.key !== 'free'" [class.plan--rec]="recommended() === p.key" [attr.data-plan]="p.key">
          <div class="plan__top">
            <p class="plan__name">{{ c.t('common.' + p.key) }}</p>
            @if (recommended() === p.key) {
              <span class="lp-chip">{{ c.t('plans.recommended') }}</span>
            } @else if (p.best) {
              <span class="lp-chip lp-chip--gold">{{ c.t('plans.best') }}</span>
            }
          </div>
          <p class="plan__price">\${{ p.price }}<span>{{ c.t('plans.perMonth') }}</span></p>
          <p class="plan__credits">{{ c.t('plans.credits', { credits: c.number(p.credits) }) }}</p>
          <p class="plan__cue">{{ p.cue }}</p>
          <ul>
            @for (b of p.bullets; track b) {
              <li><lucide-icon class="lp-ico" [name]="check" aria-hidden="true" /><span>{{ b }}</span></li>
            }
          </ul>
          <button type="button" class="lp-btn" [class.lp-btn--primary]="recommended() ? recommended() === p.key : p.key === 'free'" (click)="live.start(p.key)">
            {{ p.cta }}
          </button>
        </article>
      }
    </div>
    <details class="lp-tile compare">
      <summary>{{ c.t('plans.compare') }}</summary>
      <div class="row row--head">
        <span>{{ c.t('plans.capability') }}</span>
        @for (k of keys; track k) { <span>{{ c.t('common.' + k) }}</span> }
      </div>
      @for (r of rows(); track r.key) {
        <div class="row">
          <span>{{ r.label }}</span>
          @for (v of r.values; track $index) { <span>{{ v }}</span> }
        </div>
      }
      <p class="lp-note">{{ c.t('plans.compareNote') }}</p>
    </details>
  `
})
export class LpPlansComponent {
  readonly recommended = input<PlanKey | null>(null);

  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly check = Check;
  readonly keys = KEYS;

  private readonly perDollar = (k: PlanKey) => PLAN_CREDITS[k] / PLAN_PRICE[k];

  readonly plans = computed(() => {
    const c = this.c;
    c.lang();
    const total = MODULES.length;
    const paidNames = PAID_MODULES.map((m) => c.pair(`modules.${m.id}`)[0]).join(', ');
    const best = (['premium', 'pro'] as PlanKey[]).reduce((a, b) => (this.perDollar(b) > this.perDollar(a) ? b : a));
    return KEYS.map((key) => ({
      key,
      price: PLAN_PRICE[key],
      credits: PLAN_CREDITS[key],
      best: key === best,
      cue:
        key === 'free'
          ? c.t('plans.cueFree', { n: FREE_MODULES, total })
          : c.t('plans.cuePaid', {
              times: Math.round(PLAN_CREDITS[key] / PLAN_CREDITS.free),
              perDollar: Math.round(this.perDollar(key) / 1000)
            }),
      bullets:
        key === 'free'
          ? [c.t('plans.free1', { n: FREE_MODULES, total }), c.t('plans.free2'), c.t('plans.free3')]
          : key === 'premium'
            ? [c.t('plans.premium1', { modules: paidNames }), c.t('plans.premium2'), c.t('plans.premium3')]
            : [c.t('plans.pro1'), c.t('plans.pro2'), c.t('plans.pro3')],
      cta: c.t(key === 'free' ? 'plans.ctaFree' : key === 'premium' ? 'plans.ctaPremium' : 'plans.ctaPro')
    }));
  });

  readonly rows = computed(() => {
    const c = this.c;
    c.lang();
    return ROWS.map((r) => ({
      key: r.key,
      label: c.t(`plans.rows.${r.key}`),
      values: KEYS.map((k) => {
        const v = r.values[k];
        if (typeof v === 'number') return c.number(v);
        if (Array.isArray(v)) return c.t(`plans.rows.${v[0]}`, { n: v[1] });
        return v === 'none' || v === 'unlimited' ? c.t(`plans.rows.${v}`) : v;
      })
    }));
  });
}
