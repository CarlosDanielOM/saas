import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LucideAngularModule, Sparkles } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { TriggersService } from '../triggers/triggers.service';
import { OverlayTestMediaService } from '../landing-mocks/dev/overlay-test-media.service';
import { lookTargetFor, type MediaLibraryItem, type TriggerLookTarget, type TriggerRecord } from '../triggers/triggers.model';

/**
 * Trigger box settings in Overlay Studio: every trigger of the channel, and whether it plays its own look in
 * Studio overlays. Choosing one opens the look editor in place. Sized by its own width (container queries).
 */
@Component({
  selector: 'app-overlay-trigger-looks',
  imports: [LucideAngularModule],
  styleUrl: './overlay-trigger-looks.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="tl" aria-labelledby="trigger-looks-title">
      <div class="tl__head">
        <h3 class="tl__title" id="trigger-looks-title"><lucide-icon [img]="icons.Sparkles" [size]="15" aria-hidden="true" />{{ t('triggerLooksTitle') }}</h3>
        <p class="tl__note">{{ t('triggerLooksHint') }}</p>
      </div>
      @if (loading() && !triggers().length) {
        <p class="tl__note" role="status">{{ t('triggerLooksLoading') }}</p>
      } @else if (failed()) {
        <div class="tl__problem" role="alert"><p class="tl__note">{{ t('triggerLooksError') }}</p><button type="button" class="tl__btn" (click)="load()">{{ t('triggerLooksRetry') }}</button></div>
      } @else if (!triggers().length) {
        <p class="tl__note">{{ t('triggerLooksEmpty') }}</p>
      } @else {
        @if (triggers().length > 6) {
          <label class="tl__search"><span class="tl__sr">{{ t('triggerLooksSearch') }}</span><input type="search" [placeholder]="t('triggerLooksSearch')" [value]="search()" (input)="search.set($any($event.target).value)" /></label>
        }
        <ul class="tl__list">
          @for (trigger of shown(); track trigger._id) {
            <li class="tl__row" [attr.data-trigger-id]="trigger._id">
              <span class="tl__line">
                <span class="tl__name" [title]="trigger.name">{{ trigger.name }}</span>
                @if (trigger.look) { <span class="tl__chip">{{ t('lookChip') }}</span> }
              </span>
              <button type="button" class="tl__btn" [class.tl__btn--primary]="!!trigger.look" [disabled]="disabled()" (click)="choose(trigger)"
                [attr.aria-label]="t(trigger.look ? 'editLookNamed' : 'giveLookNamed', { name: trigger.name })">{{ t(trigger.look ? 'editLook' : 'giveLook') }}</button>
            </li>
          } @empty { <li class="tl__note">{{ t('triggerLooksNoMatches') }}</li> }
        </ul>
      }
    </section>`
})
export class OverlayTriggerLooksComponent {
  readonly channel = input.required<string>();
  readonly disabled = input(false);
  readonly opened = output<TriggerLookTarget>();
  readonly icons = { Sparkles };
  private readonly triggersApi = inject(TriggersService);
  /** The editor's trigger catalog: shares its request with the trigger filter next to this list. */
  private readonly catalog = inject(OverlayTestMediaService);
  private readonly language = inject(LanguageService);
  readonly triggers = signal<TriggerRecord[]>([]);
  private library: MediaLibraryItem[] = [];
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly search = signal('');
  readonly shown = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    return this.triggers().filter(trigger => trigger.name.toLocaleLowerCase().includes(query));
  });
  constructor() { queueMicrotask(() => void this.load()); }
  t(key: string, params?: Record<string, string | number>): string { this.language.currentLanguage(); return this.language.translate('overlayStudio.' + key, params); }
  async load(): Promise<void> {
    if (!this.channel()) return;
    this.loading.set(true); this.failed.set(false);
    try {
      const [triggers, library] = await Promise.all([firstValueFrom(this.catalog.getTriggers(this.channel())), firstValueFrom(this.triggersApi.getLibrary(this.channel()))]);
      this.library = library.items; this.triggers.set([...triggers].sort((a, b) => a.name.localeCompare(b.name)));
    } catch { this.failed.set(true); }
    finally { this.loading.set(false); }
  }
  choose(trigger: TriggerRecord): void { this.opened.emit(lookTargetFor(this.channel(), trigger, this.library)); }
}
