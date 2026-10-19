import { getWidgetDefinition, validWidgetModuleConfig, type WidgetStateEntry, type WidgetStateSnapshot } from './widget-contract.js';

export interface StateWidget { id?: string; kind: string; visible: boolean; configVersion?: unknown; config?: Readonly<Record<string, unknown>> }
type SourceState = Record<string, WidgetStateEntry | undefined>;
/** Providers return public aggregate state only, never credentials or raw provider responses. */
export interface WidgetStateSource {
  source: string;
  /** Optional module access gate; rejection excludes this source before its shared read. */
  authorize?(channel: string, widgets: readonly StateWidget[]): Promise<boolean>;
  snapshot(channel: string): Promise<SourceState>;
  /** Resource-bound modules can restrict a shared read to the selected, complete widget configs. */
  project?(snapshot: SourceState, widgets: readonly StateWidget[]): SourceState;
}
export type WidgetStateReadScope = Map<string, Promise<SourceState>>;
export interface WidgetStateResult extends WidgetStateSnapshot { failedSources: string[] }

/** Snapshot providers need no subscriptions: bounded read scopes own their complete lifecycle. */
export class WidgetStateRegistry {
  private readonly sources = new Map<string, WidgetStateSource>();
  private readonly pending = new Map<string, Promise<SourceState>>();
  constructor(sources: readonly WidgetStateSource[], private readonly definitionFor = getWidgetDefinition) {
    for (const source of sources) {
      if (this.sources.has(source.source)) throw new Error(`Duplicate widget state source: ${source.source}`);
      this.sources.set(source.source, source);
    }
  }
  createReadScope(): WidgetStateReadScope { return new Map(); }
  private read(channel: string, source: WidgetStateSource, scope: WidgetStateReadScope): Promise<SourceState> {
    const key = JSON.stringify([channel, source.source]);
    const cached = scope.get(key) ?? this.pending.get(key);
    if (cached) { scope.set(key, cached); return cached; }
    const promise = Promise.resolve().then(() => source.snapshot(channel));
    this.pending.set(key, promise); scope.set(key, promise);
    const release = () => { if (this.pending.get(key) === promise) this.pending.delete(key); };
    void promise.then(release, release);
    return promise;
  }
  async snapshot(channel: string, widgets: readonly StateWidget[], scope = this.createReadScope()): Promise<WidgetStateResult> {
    const selected = new Map<string, { keys: Set<string>; widgets: StateWidget[] }>();
    for (const widget of widgets) {
      if (!widget.visible || !validWidgetModuleConfig(widget as unknown as Record<string, unknown>, 'scene')) continue;
      const definition = this.definitionFor(widget.kind);
      if (definition?.delivery !== 'state' || !definition.state) continue;
      const selection = selected.get(definition.state.source) ?? { keys: new Set<string>(), widgets: [] };
      selection.keys.add(definition.state.stateKey); selection.widgets.push(widget);
      selected.set(definition.state.source, selection);
    }
    const widgetStates: WidgetStateResult['widgetStates'] = {}, failedSources: string[] = [];
    await Promise.all([...selected].map(async ([name, selection]) => {
      const source = this.sources.get(name);
      if (!source) { failedSources.push(name); return; }
      try {
        if (source.authorize && !await source.authorize(channel, selection.widgets)) {
          // Definitive access removal clears old client state; thrown access failures remain retryable.
          for (const key of selection.keys) widgetStates[key] = { revision: 0, state: null };
          return;
        }
        const shared = await this.read(channel, source, scope);
        const states = source.project ? source.project(shared, selection.widgets) : shared;
        // Stage the whole source before publishing; invalid output cannot leak partial state.
        const projected: typeof widgetStates = {};
        for (const key of selection.keys) {
          const entry = Object.hasOwn(states, key) ? states[key] : undefined;
          if (entry && (!Number.isSafeInteger(entry.revision) || entry.revision < 0 || !Object.hasOwn(entry, 'state') || entry.state === undefined)) throw new Error('Invalid widget state entry');
          projected[key] = entry ?? { revision: 0, state: null };
        }
        Object.assign(widgetStates, projected);
      } catch { failedSources.push(name); }
    }));
    return { widgetStates, serverTime: Date.now(), failedSources };
  }
}
