import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from '../../services/language.service';
import { OverlayWidgetHostComponent } from './overlay-widget-host.component';
import { OverlayWidgetSettingsComponent } from './overlay-widget-settings.component';
import type { WidgetRenderContext } from './overlay-widget-module';
import { createWidget } from './overlay-widget-registry';
import * as registry from './overlay-widget-registry';

@Component({
  selector: 'app-test-widget-renderer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<span class="custom-renderer">{{ context().state }}:{{ context().widget.id }}</span>'
})
class TestWidgetRenderer { readonly context = input.required<WidgetRenderContext>(); }

describe('registered widget hosts', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [OverlayWidgetHostComponent, OverlayWidgetSettingsComponent, TestWidgetRenderer], providers: [
    { provide: LanguageService, useValue: { translate: (key: string) => key.replace('overlayStudio.', ''), currentLanguage: () => 'en' } }
  ] }));
  afterEach(() => { vi.restoreAllMocks(); TestBed.resetTestingModule(); });
  it('renders the same registered component for live and local fixtures, without needing a live provider', () => {
    const fixture = TestBed.createComponent(OverlayWidgetHostComponent), widget = createWidget('poll', { id: 'poll-a', placement: 'scene' })!;
    fixture.componentRef.setInput('widget', widget); fixture.componentRef.setInput('preview', true);
    fixture.componentRef.setInput('previewFixture', 'result'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')?.getAttribute('data-phase')).toBe('completed');
    expect(fixture.nativeElement.textContent).toContain('pollSampleTitle');
    const state = registry.getWidgetModule('poll')!.preview!.create('begin', () => 'Live question');
    fixture.componentRef.setInput('preview', false); fixture.componentRef.setInput('state', state); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')?.getAttribute('data-phase')).toBe('active');
    expect(fixture.nativeElement.textContent).toContain('Live question');
  });
  it('renders any registered state component through the shared context contract', () => {
    const module = registry.getWidgetModule('poll')!, renderer = module.renderer, preview = module.preview;
    try {
      module.renderer = TestWidgetRenderer; module.preview = undefined;
      const fixture = TestBed.createComponent(OverlayWidgetHostComponent);
      fixture.componentRef.setInput('widget', createWidget('poll', { id: 'arbitrary-widget', placement: 'scene' })!);
      fixture.componentRef.setInput('state', 'arbitrary state'); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.custom-renderer')?.textContent).toBe('arbitrary state:arbitrary-widget');
    } finally { module.renderer = renderer; module.preview = preview; }
  });
  it('renders empty for future config, unknown kinds and incompatible adapter state', () => {
    const fixture = TestBed.createComponent(OverlayWidgetHostComponent), widget = createWidget('poll', { id: 'poll-a', placement: 'scene' })!;
    fixture.componentRef.setInput('widget', { ...widget, configVersion: 2 }); fixture.componentRef.setInput('preview', true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
    fixture.componentRef.setInput('widget', { ...widget, kind: 'unknown' }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
    fixture.componentRef.setInput('widget', widget); fixture.componentRef.setInput('preview', false); fixture.componentRef.setInput('state', { kind: 'poll', choices: 'bad' }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });
  it('binds independent settings and local fixtures for multiple instances and preserves the config namespace', () => {
    const a = TestBed.createComponent(OverlayWidgetSettingsComponent), b = TestBed.createComponent(OverlayWidgetSettingsComponent);
    const first = createWidget('poll', { id: 'poll-a', placement: 'scene' })!, second = { ...first, id: 'poll-b', config: { interactionDesign: 'compact' } };
    a.componentRef.setInput('widget', first); b.componentRef.setInput('widget', second);
    a.componentRef.setInput('previewFixture', 'result'); b.componentRef.setInput('previewFixture', 'begin');
    const config = vi.fn(), preview = vi.fn(); b.componentInstance.configChange.subscribe(config); b.componentInstance.previewChange.subscribe(preview);
    a.detectChanges(); b.detectChanges();
    expect(a.componentInstance.context().previewFixture).toBe('result'); expect(b.componentInstance.context().previewFixture).toBe('begin');
    const aSelects = a.nativeElement.querySelectorAll('select') as NodeListOf<HTMLSelectElement>, bSelects = b.nativeElement.querySelectorAll('select') as NodeListOf<HTMLSelectElement>;
    expect(aSelects[0].value).toBe('card'); expect(aSelects[1].value).toBe('result');
    expect(bSelects[0].value).toBe('compact'); expect(bSelects[1].value).toBe('begin');
    bSelects[0].value = 'card'; bSelects[0].dispatchEvent(new Event('change'));
    bSelects[1].value = 'tie'; bSelects[1].dispatchEvent(new Event('change'));
    expect(config).toHaveBeenCalledWith({ config: { interactionDesign: 'card' } }); expect(preview).toHaveBeenCalledWith('tie');
    expect(first.interactionDesign).toBe('card'); expect(second.config.interactionDesign).toBe('compact');
    expect(aSelects[1].value).toBe('result');
    // A different selection updates the dynamic settings input without rebuilding the editor.
    b.componentRef.setInput('widget', createWidget('prediction', { id: 'prediction-a', placement: 'scene' })!); b.detectChanges();
    expect([...b.nativeElement.querySelectorAll('select')[1].options].map((option: HTMLOptionElement) => option.value)).toContain('locked');
  });
});
