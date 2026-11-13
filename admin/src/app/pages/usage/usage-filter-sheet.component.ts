import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, output, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { UsageSummary } from '../../services/usage-api.service';
import { ChannelPickerComponent, type PickedChannel } from '../../shared/channel-picker/channel-picker.component';
import { IconComponent } from '../../shared/icon/icon.component';
import type { UsageState } from './usage-page.component';
import { modelName, sourceLabel } from './usage-labels';

export interface SheetChange {
  state: Partial<UsageState>;
  /** A name to remember for an id (the picked streamer). */
  name?: { id: string; label: string };
  /** Close the sheet (it moved the page to another view). */
  view?: boolean;
}

/** "Filters": the rarer filters (streamer, viewer, provider, model, source) in a bottom sheet. Changes apply at once. */
@Component({
  selector: 'app-usage-filter-sheet',
  template: `
    <dialog class="lf-dialog" #dialog aria-labelledby="usage-sheet-title" (close)="closed.emit()" (click)="backdrop($event)" data-usage-sheet>
      <div class="lf-dialog__head">
        <div>
          <h2 id="usage-sheet-title">Filters</h2>
          <p class="lf-note">Each change applies right away.</p>
        </div>
        <button type="button" class="lf-btn lf-btn--icon lf-btn--ghost" (click)="close()" aria-label="Close filters"><app-icon name="x" /></button>
      </div>
      <div class="lf-dialog__body">
        <div class="lf-field">
          @if (state().channel) {
            <span class="lf-label">Streamer</span>
            <div class="us-picked">
              <span class="us-picked__name">{{ channelName() }}</span>
              <button type="button" class="lf-btn lf-btn--sm" (click)="emit({ channel: null })">Remove</button>
            </div>
          } @else {
            <app-channel-picker label="Streamer" (picked)="pickChannel($event)" />
          }
        </div>

        <div class="lf-field">
          <span class="lf-label">Viewer</span>
          @if (state().actor) {
            <div class="us-picked">
              <span class="us-picked__name">{{ actorName() }}</span>
              <button type="button" class="lf-btn lf-btn--sm" (click)="emit({ actor: null })">Remove</button>
            </div>
            <a class="us-link" routerLink="/activity" [queryParams]="{ actor: state().actor }"><app-icon name="history" />Everything from this viewer</a>
          } @else {
            <p class="lf-hint">Tap a viewer in the Viewers list to see only their usage.</p>
            <button type="button" class="lf-btn lf-btn--sm us-show" (click)="filtersChange.emit({ state: { view: 'viewers' }, view: true })"><app-icon name="users" />Show viewers</button>
          }
        </div>

        <div class="lf-field">
          <label class="lf-label" for="usage-sheet-provider">Provider</label>
          <select id="usage-sheet-provider" class="lf-input" [value]="state().provider ?? ''" (change)="emit({ provider: $any($event.target).value || null })">
            <option value="">Any provider</option>
            @for (option of providers(); track option) {
              <option [value]="option" [selected]="option === state().provider">{{ option }}</option>
            }
          </select>
        </div>

        <div class="lf-field">
          <label class="lf-label" for="usage-sheet-model">Model</label>
          <select id="usage-sheet-model" class="lf-input" [value]="state().model ?? ''" (change)="emit({ model: $any($event.target).value || null })">
            <option value="">Any model</option>
            @for (option of models(); track option.value) {
              <option [value]="option.value" [selected]="option.value === state().model">{{ option.label }}</option>
            }
          </select>
        </div>

        <div class="lf-field">
          <label class="lf-label" for="usage-sheet-source">Where it came from</label>
          <select id="usage-sheet-source" class="lf-input" [value]="state().source ?? ''" (change)="emit({ source: $any($event.target).value || null })">
            <option value="">Anywhere</option>
            @for (option of sources(); track option.value) {
              <option [value]="option.value" [selected]="option.value === state().source">{{ option.label }}</option>
            }
          </select>
          <p class="lf-hint">Lists show what the current range and filters contain.</p>
        </div>
      </div>
      <div class="lf-dialog__foot">
        <button type="button" class="lf-btn" (click)="emit({ channel: null, actor: null, provider: null, model: null, source: null })" [disabled]="!count()">Clear these filters</button>
        <button type="button" class="lf-btn lf-btn--primary" (click)="close()">Done</button>
      </div>
    </dialog>
  `,
  styles: [
    `
      .us-picked { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; min-height: 3rem; padding: 0.35rem 0.35rem 0.35rem 0.85rem; border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-soft); }
      .us-picked__name { font-weight: 750; overflow-wrap: anywhere; }
      .us-picked .lf-btn, .us-show { min-height: 2.75rem; }
      .us-show { justify-self: start; }
      .us-link { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 2.75rem; color: var(--accent); font-size: 0.88rem; font-weight: 700; }
      .us-link app-icon { width: 1.05rem; height: 1.05rem; }
      select.lf-input { min-height: 2.9rem; font-size: 1rem; }
      .lf-dialog__foot .lf-btn { min-height: 2.75rem; }
      .lf-dialog__head .lf-btn--icon { min-width: 2.75rem; min-height: 2.75rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ChannelPickerComponent],
})
export class UsageFilterSheetComponent {
  readonly open = input(false);
  readonly state = input.required<UsageState>();
  readonly summary = input<UsageSummary | null>(null);
  readonly channelName = input('');
  readonly actorName = input('');
  readonly filtersChange = output<SheetChange>();
  readonly closed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly count = computed(() => {
    const s = this.state();
    return [s.channel, s.actor, s.provider, s.model, s.source].filter(Boolean).length;
  });
  readonly providers = computed(() => {
    const set = new Set((this.summary()?.byModel ?? []).map((row) => row.provider).filter((provider) => provider && provider !== 'unknown'));
    const current = this.state().provider;
    if (current) set.add(current);
    return [...set].sort();
  });
  readonly models = computed(() => {
    const set = new Set((this.summary()?.byModel ?? []).map((row) => row.model).filter((model): model is string => !!model));
    const current = this.state().model;
    if (current) set.add(current);
    return [...set].sort().map((value) => ({ value, label: modelName(value)! }));
  });
  readonly sources = computed(() => {
    const set = new Set((this.summary()?.bySource ?? []).map((row) => row.source).filter(Boolean));
    const current = this.state().source;
    if (current) set.add(current);
    const options = [...set].map((value) => ({ value, label: sourceLabel(value) }));
    // Several stored sources share a plain name ("Stream memory"): tell them apart.
    const seen = new Map<string, number>();
    for (const option of options) seen.set(option.label, (seen.get(option.label) ?? 0) + 1);
    return options
      .map((option) => ((seen.get(option.label) ?? 0) > 1 ? { ...option, label: `${option.label} (${option.value.replace(/_/g, ' ')})` } : option))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  constructor() {
    effect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.open() && !dialog.open) dialog.showModal();
      if (!this.open() && dialog.open) dialog.close();
    });
  }

  emit(state: Partial<UsageState>): void {
    this.filtersChange.emit({ state });
  }

  pickChannel(picked: PickedChannel): void {
    this.filtersChange.emit({ state: { channel: picked.channelID }, name: { id: picked.channelID, label: picked.channel } });
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  /** A tap on the dimmed backdrop closes the sheet. */
  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }
}
