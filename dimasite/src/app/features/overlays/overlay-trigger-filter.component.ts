import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { LanguageService } from '../../services/language.service';
import { OverlayTestMediaService } from '../landing-mocks/dev/overlay-test-media.service';
import type { TriggerRecord } from '../triggers/triggers.model';

@Component({
  selector: 'app-overlay-trigger-filter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-trigger-filter.component.css',
  template: `
    <label class="filter-field"><span>{{ t('triggerFilter') }}</span>
      <select [attr.aria-label]="t('triggerFilter')" [value]="ids() === undefined ? 'all' : 'selected'" (change)="setMode($event)">
        <option value="all">{{ t('allTriggers') }}</option><option value="selected">{{ t('selectedTriggers') }}</option>
      </select>
    </label>
    <p class="filter-hint">{{ t('triggerFilterHint') }}</p>
    @if (ids() !== undefined) {
      <p class="filter-hint" aria-live="polite">{{ t(ids()!.length ? 'triggerSelectedCount' : 'triggerNoneSelected', { count: ids()!.length }) }}</p>
      @if (error()) {
        <p class="filter-error" role="alert">{{ t('triggerListError') }}</p><button type="button" (click)="load()" [disabled]="loading()">{{ t('retryTriggers') }}</button>
      }
      @if (loading() && !triggers().length) { <p class="filter-hint" role="status">{{ t('triggerListLoading') }}</p> }
      @if (triggers().length) {
        <label class="filter-field"><span>{{ t('searchTriggers') }}</span><input type="search" [value]="search()" (input)="setSearch($event)" /></label>
        <div class="trigger-choices" role="group" [attr.aria-label]="t('selectedTriggers')">
          @for (trigger of filtered(); track trigger._id) {
            <label class="trigger-choice"><input type="checkbox" [checked]="ids()?.includes(trigger._id)" (change)="toggle(trigger._id)" />
              <span>{{ trigger.name }}@if (!trigger.isEnabled) { <small>{{ t('triggerDisabled') }}</small> }</span>
            </label>
          } @empty { <p class="filter-hint">{{ t('noTriggerSearchResults') }}</p> }
        </div>
      } @else if (!loading() && !error()) { <p class="filter-hint">{{ t('triggerListEmpty') }}</p> }
      @if (!loading() && !error()) {
        @for (id of unavailable(); track id) {
          <div class="unavailable-trigger"><span>{{ t('triggerUnavailable', { id: id.slice(-6) }) }}</span>
            <button type="button" (click)="toggle(id)" [attr.aria-label]="t('removeUnavailableTrigger', { id: id.slice(-6) })">{{ t('remove') }}</button>
          </div>
        }
      }
    }
  `
})
export class OverlayTriggerFilterComponent {
  readonly channel = input.required<string>();
  readonly ids = input<string[] | undefined>();
  readonly changed = output<string[] | undefined>();
  readonly triggers = signal<TriggerRecord[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly search = signal('');
  private readonly media = inject(OverlayTestMediaService);
  private readonly language = inject(LanguageService);
  private request?: Subscription;
  readonly filtered = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    return this.triggers().filter(trigger => trigger.name.toLocaleLowerCase().includes(query));
  });
  readonly unavailable = computed(() => (this.ids() ?? []).filter(id => !this.triggers().some(trigger => trigger._id === id)));
  constructor() {
    effect(onCleanup => { this.channel(); this.load(); onCleanup(() => this.request?.unsubscribe()); });
    inject(DestroyRef).onDestroy(() => this.request?.unsubscribe());
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`overlayStudio.${key}`, params); }
  load(): void {
    this.request?.unsubscribe(); this.loading.set(true); this.error.set(false);
    if (!this.channel()) { this.loading.set(false); return; }
    this.request = this.media.getTriggers(this.channel()).subscribe({
      next: triggers => { this.triggers.set(triggers); this.loading.set(false); },
      error: () => { this.error.set(true); this.loading.set(false); }
    });
  }
  setMode(event: Event): void {
    const selected = (event.target as HTMLSelectElement).value === 'selected';
    this.changed.emit(selected ? this.ids() ?? [] : undefined);
  }
  setSearch(event: Event): void { this.search.set((event.target as HTMLInputElement).value); }
  toggle(id: string): void {
    const ids = this.ids(); if (!ids) return;
    this.changed.emit(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  }
}
