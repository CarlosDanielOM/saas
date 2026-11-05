import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { LanguageService } from '../../services/language.service';
import type { WidgetManifest } from './custom-widget-format.generated';
import { CustomWidgetsService } from './custom-widgets.service';
import { OverlayCustomWidgetComponent } from './overlay-custom-widget.component';
import type { DimaEvent } from './widget-runtime/dima-events';
import { CUSTOM_WIDGET_ENV, WidgetEventBus, type CustomWidgetEnv, type RuntimeBundle } from './widget-runtime/widget-env';

const WIDGET = 'b'.repeat(24), OTHER = 'c'.repeat(24);
const REMOTE = 'https://cdn.streamelements.com/uploads/alert.mp3', COPIED = 'https://api.example/overlay-studio/public/p/assets/a1';

/** Host behaviour around the sandboxed frame, driven with fake frame messages (no widget code runs here). */
describe('custom widget frame host', () => {
  let fixture: ComponentFixture<OverlayCustomWidgetComponent>;
  let bus: WidgetEventBus;
  let rpc: Mock<CustomWidgetEnv['rpc']>;
  const bundle = (engine: WidgetManifest['engine']): RuntimeBundle => ({
    widgetId: WIDGET, revision: 1, engine, manifest: { engine, api: 1, uses: ['store', 'session'] },
    html: '', css: '', js: '', fields: [], data: { sound: REMOTE, list: [REMOTE] }, media: { [REMOTE]: COPIED },
    channel: { id: '1', login: 'chan', name: 'Chan' }
  });

  async function start(engine: WidgetManifest['engine'] = 'dima') {
    bus = new WidgetEventBus();
    rpc = vi.fn<CustomWidgetEnv['rpc']>();
    const env: CustomWidgetEnv = {
      mode: 'live', bundle: async () => bundle(engine), subscribe: listener => bus.subscribe(listener),
      rpc: (...args) => rpc(...args), session: () => null, report: () => {}
    };
    TestBed.configureTestingModule({ providers: [
      { provide: CUSTOM_WIDGET_ENV, useValue: env },
      { provide: CustomWidgetsService, useValue: { widget: () => undefined, list: () => null } },
      { provide: LanguageService, useValue: { translate: (key: string) => key } }
    ] });
    fixture = TestBed.createComponent(OverlayCustomWidgetComponent);
    fixture.componentRef.setInput('context', { widget: { id: 'layer-1', kind: 'custom', config: { widgetId: WIDGET, revision: 1 }, x: 0, y: 0, width: 100, height: 100, visible: true, locked: false }, state: null, preview: false, clockOffset: 0 });
    fixture.detectChanges();
    return loadedFrame();
  }
  /** Waits for a (new) frame, spies on what the host posts to it and reports it as loaded. */
  async function loadedFrame(previous?: HTMLIFrameElement) {
    let frame: HTMLIFrameElement | null = null;
    for (let i = 0; i < 100 && (!frame || frame === previous); i++) { await new Promise(r => setTimeout(r, 5)); frame = fixture.nativeElement.querySelector('iframe'); }
    if (!frame || frame === previous) throw new Error('frame not created');
    const posts: Record<string, unknown>[] = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message: unknown) => { posts.push(message as Record<string, unknown>); });
    const exec = (fixture.componentInstance as unknown as { exec: string }).exec;
    const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { source: frame!.contentWindow, data: { dima: 1, exec, ...data } }));
    send({ type: 'loaded' });
    return { frame, posts, send };
  }

  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('/*jquery*/'))); });
  afterEach(() => { fixture?.destroy(); TestBed.resetTestingModule(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('starts the frame with copied media in its settings', async () => {
    const { posts } = await start();
    const init = posts.find(message => message['type'] === 'init') as { context: { fields: Record<string, unknown> } };
    expect(init.context.fields).toEqual({ sound: COPIED, list: [COPIED] });
  });

  it('delivers store updates only from the store this widget shares', async () => {
    const { posts } = await start();
    const store = (namespace?: string): DimaEvent => ({ type: 'store', data: { key: 'score', value: 1, namespace } });
    bus.emit(store(OTHER)); bus.emit(store('se')); bus.emit(store(WIDGET));
    const delivered = posts.filter(message => message['type'] === 'event').map(message => (message['event'] as DimaEvent).data);
    expect(delivered).toEqual([{ key: 'score', value: 1, namespace: WIDGET }]);
  });

  it('StreamElements widgets share the "se" store', async () => {
    const { posts } = await start('streamelements');
    bus.emit({ type: 'store', data: { key: 'k', value: 2, namespace: WIDGET } }); bus.emit({ type: 'store', data: { key: 'k', value: 3, namespace: 'se' } });
    expect(posts.filter(message => message['type'] === 'event').map(message => (message['event'] as { data: { value: number } }).data.value)).toEqual([3]);
  });

  it('drops answers to requests made by a frame that has since restarted', async () => {
    const first = await start();
    let answer!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    first.send({ type: 'rpc', id: 7, method: 'store.get', params: { key: 'score' } });
    await new Promise(r => setTimeout(r, 0));
    expect(rpc).toHaveBeenCalledTimes(1);
    (fixture.componentInstance as unknown as { reload(): void }).reload();
    const second = await loadedFrame(first.frame);
    answer(42);
    await new Promise(r => setTimeout(r, 0));
    expect([...first.posts, ...second.posts].some(message => message['type'] === 'rpc-result')).toBe(false);

    // The new run's own requests are answered.
    rpc.mockResolvedValueOnce(5);
    second.send({ type: 'rpc', id: 1, method: 'store.get', params: { key: 'score' } });
    await new Promise(r => setTimeout(r, 0));
    expect(second.posts.find(message => message['type'] === 'rpc-result')).toMatchObject({ id: 1, ok: true, value: 5 });
  });
});
