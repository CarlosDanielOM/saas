import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, signal, untracked, viewChild } from '@angular/core';

import type { DecisionRow, DecisionSort } from '../../services/decisions-api.service';
import { ChannelPickerComponent, type PickedChannel } from '../channel-picker/channel-picker.component';
import { IconComponent } from '../icon/icon.component';
import { SORTS, SOURCE_LABEL, modelName } from './decision-format';
import type { ExplorerView } from './decisions-explorer.component';

export type FiltersChange = Partial<{
  channel: string | null;
  /** Only for the chip label; not a URL param. */
  channelName: string | null;
  chatter: string | null;
  chatterName: string | null;
  model: string | null;
  source: DecisionRow['source'] | null;
  feedback: 'agree' | 'disagree' | null;
  sort: DecisionSort | null;
}>;

/**
 * The rarer filters in one bottom sheet: streamer, viewer, model, why it was reviewed, the owner's
 * verdict against the bot, and the sort. Every change applies at once; the list updates behind the sheet.
 */
@Component({
  selector: 'app-decisions-filters',
  template: `
    <dialog #sheet class="lf-dialog df" aria-labelledby="df-title" (close)="onClose()" (click)="onClick($event)" data-decisions-filter-sheet>
      @if (open()) {
        <div class="lf-dialog__head">
          <h2 id="df-title">Filters</h2>
          <button type="button" class="lf-btn lf-btn--icon" aria-label="Close filters" (click)="sheet.close()"><app-icon name="x" /></button>
        </div>
        <div class="lf-dialog__body df__body">
          @if (!fixed()) {
            <div class="df__group">
              @if (view().channel) {
                <p class="df__current">
                  <span>{{ channelLabel() || 'Streamer: picked channel' }}</span>
                  <button type="button" class="lf-btn lf-btn--sm lf-btn--ghost" (click)="changed.emit({ channel: null })">Any streamer</button>
                </p>
              }
              <app-channel-picker [label]="view().channel ? 'Pick another streamer' : 'Streamer'" (picked)="pickChannel($event)" />
            </div>
          }

          <form class="lf-field df__group" (submit)="$event.preventDefault(); applyViewer()">
            <label class="lf-label" for="df-viewer">Viewer</label>
            <div class="df__inline">
              <input id="df-viewer" class="lf-input" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Their Twitch name, exactly"
                [value]="viewerName()" (input)="viewerName.set($any($event.target).value)" data-filter-viewer />
              <button type="submit" class="lf-btn">Apply</button>
            </div>
            @if (view().chatter) {
              <p class="df__current">
                <span>Showing one viewer picked from a decision.</span>
                <button type="button" class="lf-btn lf-btn--sm lf-btn--ghost" (click)="changed.emit({ chatter: null })">Any viewer</button>
              </p>
            }
          </form>

          <div class="lf-field df__group">
            <label class="lf-label" for="df-model">Model</label>
            <select id="df-model" class="lf-input" (change)="changed.emit({ model: $any($event.target).value || null })" data-filter-model>
              <option value="" [selected]="!view().model">Any model</option>
              @for (model of modelList(); track model) {
                <option [value]="model" [selected]="view().model === model">{{ modelName(model) }}</option>
              }
            </select>
          </div>

          <fieldset class="df__group df__set">
            <legend class="lf-label">Why it was reviewed</legend>
            <div class="df__chips">
              <button type="button" class="lf-chip" [attr.aria-pressed]="!view().source" (click)="changed.emit({ source: null })">Any reason</button>
              @for (key of sources; track key) {
                <button type="button" class="lf-chip" [attr.aria-pressed]="view().source === key" (click)="changed.emit({ source: key })" [attr.data-filter-source]="key">{{ sourceLabel[key] }}</button>
              }
            </div>
          </fieldset>

          <fieldset class="df__group df__set">
            <legend class="lf-label">Your verdict against the bot</legend>
            <div class="df__chips">
              <button type="button" class="lf-chip" [attr.aria-pressed]="view().feedback !== 'agree' && view().feedback !== 'disagree'" (click)="changed.emit({ feedback: null })">Any</button>
              <button type="button" class="lf-chip" [attr.aria-pressed]="view().feedback === 'agree'" (click)="changed.emit({ feedback: 'agree' })" data-filter-feedback="agree">You agreed</button>
              <button type="button" class="lf-chip" [attr.aria-pressed]="view().feedback === 'disagree'" (click)="changed.emit({ feedback: 'disagree' })" data-filter-feedback="disagree">You didn't agree</button>
            </div>
          </fieldset>

          <fieldset class="df__group df__set">
            <legend class="lf-label">Sort</legend>
            <div class="df__chips">
              @for (sort of sorts; track sort.key) {
                <button type="button" class="lf-chip" [attr.aria-pressed]="view().sort === sort.key" (click)="changed.emit({ sort: sort.key })" [attr.data-filter-sort]="sort.key">{{ sort.label }}</button>
              }
            </div>
          </fieldset>
        </div>
        <div class="lf-dialog__foot">
          <button type="button" class="lf-btn lf-btn--ghost" (click)="viewerName.set(''); cleared.emit()">Clear all</button>
          <button type="button" class="lf-btn lf-btn--primary" (click)="sheet.close()" data-filter-done>Show results</button>
        </div>
      }
    </dialog>
  `,
  styles: [
    `
      .df__body { gap: 1.1rem; }
      .df__group { display: grid; gap: 0.45rem; min-width: 0; }
      .df__set { margin: 0; padding: 0; border: 0; }
      .df__set legend { margin-bottom: 0.45rem; padding: 0; }
      .df__chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
      .df__chips .lf-chip { min-height: 2.75rem; font-size: 0.85rem; cursor: pointer; }
      .df__inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
      .df__current { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.4rem; margin: 0; font-size: 0.86rem; font-weight: 650; }
      .df__current .lf-btn { min-height: 2.75rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ChannelPickerComponent],
})
export class DecisionsFiltersComponent {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('sheet');
  readonly open = input(false);
  readonly view = input.required<ExplorerView>();
  readonly fixed = input(false);
  readonly models = input<string[]>([]);
  readonly channelLabel = input<string | null>(null);
  readonly closed = output<void>();
  readonly changed = output<FiltersChange>();
  readonly cleared = output<void>();

  readonly viewerName = signal('');
  readonly sources: DecisionRow['source'][] = ['first_message', 'spam_continuous', 'rule'];
  readonly sourceLabel = SOURCE_LABEL;
  readonly sorts = SORTS;
  readonly modelName = modelName;

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => {
        const dialog = this.dialog().nativeElement;
        if (open && !dialog.open) {
          this.viewerName.set(this.view().chatterName ?? '');
          dialog.showModal();
        } else if (!open && dialog.open) dialog.close();
      });
    });
  }

  /** The summary's models, plus the one in the URL when the summary has none for this range. */
  modelList(): string[] {
    const picked = this.view().model;
    const list = this.models();
    return picked && !list.includes(picked) ? [...list, picked] : list;
  }

  pickChannel(channel: PickedChannel): void {
    this.changed.emit({ channel: channel.channelID, channelName: channel.channel });
  }

  applyViewer(): void {
    const name = this.viewerName().trim().replace(/^@/, '');
    this.changed.emit({ chatterName: name || null, chatter: null });
  }

  onClose(): void {
    if (this.open()) this.closed.emit();
  }

  onClick(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.dialog().nativeElement.close();
  }
}
