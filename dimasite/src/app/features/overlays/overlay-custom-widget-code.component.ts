import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { BookOpen, Code2, Eye, LucideAngularModule, RotateCcw, Star, X } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { PackageFormatError, readPackage, type FieldIssue } from './custom-widget-format.generated';
import { CODE_FILES, clearCodeDraft, emptyCodeFiles, readCodeDraft, sameCodeFiles, toPackage, writeCodeDraft, type CodeDraft, type CodeFile, type CodeFiles } from './custom-widget-code-drafts';
import type { CodeEditor, CodeLanguage, CodeTab } from './custom-widget-code-mirror';
import { starterFiles, type StarterKind, type StarterTexts } from './custom-widget-templates';
import { CustomWidgetsService, errorCode, message, type CustomWidgetView } from './custom-widgets.service';
import { OverlayCustomWidgetComponent } from './overlay-custom-widget.component';
import type { OverlayWidget } from './overlay.model';
import type { WidgetRenderContext } from './overlay-widget-module';
import { EditorWidgetEnv, type LayerLog } from './widget-runtime/editor-env';
import type { AlertTest, ChatTest } from './widget-runtime/test-events';
import type { RuntimeBundle } from './widget-runtime/widget-env';

/** Layer id of the editor's preview; test events and the widget log are addressed to it only. */
const PREVIEW_LAYER = 'cw-code-preview';
const TAB_LANGUAGE: Record<CodeFile, CodeLanguage> = { html: 'html', css: 'css', js: 'js', fields: 'json', data: 'json', manifest: 'json' };
const ISSUE_TAB: Record<FieldIssue['code'], CodeFile> = {
  'invalid-key': 'fields', 'invalid-field': 'fields', 'too-many-fields': 'fields', 'no-options': 'fields', 'invalid-value': 'fields',
  'invalid-data-key': 'data', 'data-value-dropped': 'data', 'unknown-use': 'manifest'
};
const ERROR_TAB: Record<string, CodeFile> = { 'invalid-fields': 'fields', 'invalid-data': 'data', 'data-too-large': 'data', 'invalid-manifest': 'manifest', 'unsupported-api': 'manifest' };

export interface CodeProblem { tab: CodeFile | null; key: string; text: string; line: number | null; blocking: boolean }
export interface CodeCheck { pkg: ReturnType<typeof readPackage> | null; problems: CodeProblem[] }

/** JSON errors name a line or a character position; either becomes a line to jump to. */
export function errorLine(text: string, detail: string): number | null {
  const line = /line (\d+)/i.exec(detail); if (line) return Number(line[1]);
  const position = /position (\d+)/i.exec(detail);
  return position ? text.slice(0, Number(position[1])).split('\n').length : null;
}
/** Parses the files like an import would: blocking errors (bad JSON, too large) and skipped settings per tab. */
export function checkCode(files: CodeFiles, issueText: (issue: FieldIssue) => string): CodeCheck {
  try {
    const pkg = readPackage(toPackage(files));
    return { pkg, problems: pkg.issues.map(issue => ({ tab: ISSUE_TAB[issue.code] ?? null, key: issue.key ?? issue.detail ?? '', text: issueText(issue), line: null, blocking: false })) };
  } catch (error) {
    if (!(error instanceof PackageFormatError)) throw error;
    const sized = /The (html|css|js|fields|data) file/.exec(error.message)?.[1] as CodeFile | undefined;
    const tab = ERROR_TAB[error.code] ?? sized ?? (/widget\.json/.test(error.message) ? 'manifest' : null);
    return { pkg: null, problems: [{ tab, key: '', text: error.message, line: tab ? errorLine(files[tab], error.message) : null, blocking: true }] };
  }
}

/**
 * The custom widget code editor: start a widget from a template or edit one's files (HTML, CSS, JS, fields, data,
 * widget.json) with a live preview of the unsaved code, test events, the widget log and version history.
 * Saving makes a new revision (published overlays keep theirs until republished). Unsaved work stays in this browser.
 */
@Component({
  selector: 'app-overlay-custom-widget-code',
  imports: [LucideAngularModule, OverlayCustomWidgetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-custom-widget-code.component.html',
  styleUrl: './overlay-custom-widget-code.component.css'
})
export class OverlayCustomWidgetCodeComponent {
  /** Edit this widget; without one the dialog starts a new widget. */
  readonly widget = input<CustomWidgetView | null>(null);
  /** The layer it was opened from: preview size and that layer's settings. */
  readonly layer = input<OverlayWidget | null>(null);
  readonly created = output<CustomWidgetView>();
  readonly closed = output<void>();

  private readonly widgets = inject(CustomWidgetsService);
  readonly env = inject(EditorWidgetEnv);
  private readonly language = inject(LanguageService);
  private readonly auth = inject(SessionAuthService);
  private readonly upgrades = inject(UpgradeService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly editorHost = viewChild<ElementRef<HTMLElement>>('editorHost');
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  readonly icons = { BookOpen, Code2, Eye, RotateCcw, Star, X };
  readonly codeFiles = CODE_FILES;
  readonly starters: readonly StarterKind[] = ['dima', 'streamelements'];
  readonly chatTests: readonly ChatTest[] = ['viewer', 'subscriber', 'moderator', 'first', 'emotes', 'long'];
  readonly alertTests: readonly AlertTest[] = ['follow', 'sub', 'gift', 'bits', 'raid'];

  /** `opening` until we know whether this is a new widget (starter step) or an existing one (code). */
  readonly step = signal<'opening' | 'start' | 'code'>('opening');
  readonly starter = signal<StarterKind>('dima');
  readonly name = signal('');
  readonly widgetId = signal<string | null>(null);
  /** Revision the editor's text started from (0 = not created yet). */
  readonly base = signal(0);
  /** Text of the last saved version (null until a new widget is created). */
  readonly saved = signal<CodeFiles | null>(null);
  readonly files = signal<CodeFiles>(emptyCodeFiles());
  /** `files` once typing pauses: what the checks and the preview use. */
  private readonly settled = signal<CodeFiles>(emptyCodeFiles());
  readonly tab = signal<CodeFile>('html');
  /** Phones show code or preview. */
  readonly pane = signal<'code' | 'preview'>('code');
  readonly loading = signal(false);
  readonly loadError = signal('');
  readonly editorState = signal<'loading' | 'ready' | 'failed'>('loading');
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly stale = signal(false);
  readonly limitReached = signal(false);
  /** Unsaved work found in this browser when the editor opened. */
  readonly draftNote = signal<{ at: number; base: number; mismatch: boolean } | null>(null);
  private pendingDraft: CodeDraft | null = null;
  readonly newDraft = signal<CodeDraft | null>(null);
  readonly draftBlocked = signal(false);
  readonly openedVersion = signal<number | null>(null);
  readonly versionBusy = signal<number | null>(null);
  readonly versionError = signal('');
  readonly previewBundle = signal<RuntimeBundle | null>(null);
  readonly scale = signal(1);
  private media: Record<string, string> = {};
  private editor: CodeEditor<CodeFile> | null = null;
  /** The element CodeMirror lives in; a new one (re-render) gets a new editor. */
  private editorParent: HTMLElement | null = null;
  private destroyed = false;
  private returnFocus: HTMLElement | null = null;

  readonly check = computed(() => checkCode(this.settled(), issue => this.t('customIssue_' + issue.code)));
  readonly problems = computed(() => this.check().problems);
  readonly blocking = computed(() => this.problems().some(problem => problem.blocking));
  readonly tabProblems = computed(() => {
    const counts: Partial<Record<CodeFile, number>> = {};
    for (const problem of this.problems()) if (problem.tab) counts[problem.tab] = (counts[problem.tab] ?? 0) + 1;
    return counts;
  });
  readonly dirty = computed(() => !sameCodeFiles(this.files(), this.saved()));
  /** The manifest of the last code that parsed (with errors, the engine and tests stay as they were). */
  private readonly lastManifest = signal<ReturnType<typeof readPackage>['manifest'] | null>(null);
  readonly manifest = computed(() => this.check().pkg?.manifest ?? this.lastManifest());
  readonly engine = computed(() => this.manifest()?.engine ?? 'streamelements');
  readonly uses = computed<readonly string[]>(() => this.manifest()?.uses ?? []);
  readonly size = computed(() => ({ width: this.layer()?.width || 480, height: this.layer()?.height || 640 }));
  readonly previewContext = computed<WidgetRenderContext>(() => {
    const { width, height } = this.size(), values = this.layer()?.config?.['values'];
    return { widget: { id: PREVIEW_LAYER, kind: 'custom', name: this.name(), x: 0, y: 0, width, height, visible: true, locked: false,
      config: { widgetId: this.widgetId() ?? '', values: values && typeof values === 'object' ? values : {} } }, state: null, preview: true, clockOffset: 0 };
  });
  readonly log = computed<LayerLog | null>(() => this.env.logs()[PREVIEW_LAYER] ?? null);
  readonly history = computed(() => { const id = this.widgetId(); return (id ? this.widgets.widget(id)?.history : undefined) ?? []; });
  readonly list = this.widgets.list;
  readonly blockedByLimit = computed(() => !this.widgetId() && (this.widgets.atLimit() || this.limitReached()));
  readonly canUpgrade = computed(() => this.list()?.planTier !== 'pro');
  readonly usage = computed(() => { const list = this.list(); return list ? this.t('customUsage', { used: Math.min(list.used + 1, list.limit), limit: list.limit, plan: this.t('customPlan_' + list.planTier) }) : ''; });
  /** Short state for the header chip; the footer says it in a sentence. */
  readonly status = computed<'saving' | 'new' | 'problems' | 'unsaved' | 'saved'>(() =>
    this.saving() ? 'saving' : this.blocking() ? 'problems' : !this.widgetId() ? 'new' : this.dirty() ? 'unsaved' : 'saved');
  readonly hint = computed(() => this.t(`customCodeHint_${this.tab()}${this.tab() === 'js' ? (this.engine() === 'dima' ? 'Dima' : 'Se') : ''}`));
  readonly docsUrl = computed(() => `https://docs.domdimabot.com/${this.language.currentLanguage() === 'es' ? 'es/' : ''}building-custom-widgets-dima-sdk/`);

  constructor() {
    const destroy = inject(DestroyRef);
    let settleTimer: ReturnType<typeof setTimeout> | null = null, draftTimer: ReturnType<typeof setTimeout> | null = null;
    destroy.onDestroy(() => {
      this.destroyed = true; this.editor?.destroy();
      for (const timer of [settleTimer, draftTimer]) if (timer) clearTimeout(timer);
      this.env.clearLog(PREVIEW_LAYER);
    });
    // Checks and the preview follow the text once typing pauses.
    effect(() => {
      const files = this.files();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => this.settled.set(files), 400);
    });
    // Only code that parses runs; with errors the preview keeps the last good version.
    effect(() => {
      const pkg = this.check().pkg, files = this.settled();
      if (!pkg || this.step() !== 'code' || this.loading()) return;
      untracked(() => this.lastManifest.set(pkg.manifest));
      untracked(() => this.previewBundle.set({
        widgetId: this.widgetId() ?? 'draft-preview', revision: 0, engine: pkg.manifest.engine, manifest: pkg.manifest,
        html: files.html, css: files.css, js: files.js, fields: pkg.fields, data: pkg.data, media: this.media, channel: this.channel()
      }));
    });
    // Unsaved work is kept in this browser (per widget, or `new`) until it's saved or discarded.
    effect(() => {
      const files = this.files(), dirty = this.dirty(), id = this.widgetId() ?? 'new', base = this.base(), name = this.name();
      if (this.step() !== 'code' || this.loading() || this.loadError()) return;
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        const channel = this.widgets.channelId;
        if (!dirty) { clearCodeDraft(channel, id); this.draftBlocked.set(false); return; }
        this.draftBlocked.set(!writeCodeDraft(channel, id, { files, base, at: Date.now(), name }));
      }, 500);
    });
    // CodeMirror loads on its own (lazy chunk) once the editor area exists.
    effect(() => {
      const host = this.editorHost()?.nativeElement;
      if (host && host !== this.editorParent && this.step() === 'code') untracked(() => void this.mountEditor(host));
    });
    // The preview keeps the layer's real size, scaled to fit.
    effect(onCleanup => {
      const stage = this.stage()?.nativeElement; if (!stage) return;
      const fit = () => {
        const { width, height } = untracked(this.size), box = stage.getBoundingClientRect();
        if (box.width && box.height) this.scale.set(Math.max(0.1, Math.min((box.width - 16) / width, (box.height - 16) / height)));
      };
      const observer = new ResizeObserver(fit); observer.observe(stage); fit();
      onCleanup(() => observer.disconnect());
    });
    afterNextRender(() => {
      this.returnFocus = document.activeElement as HTMLElement | null;
      this.dialog().nativeElement.showModal();
      void this.init();
    });
  }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }
  fileLabel(file: CodeFile): string { return this.t('customCodeFile_' + file); }
  when(at: number | string): string { return new Date(at).toLocaleString(this.language.currentLanguage() === 'es' ? 'es' : 'en', { dateStyle: 'medium', timeStyle: 'short' }); }
  private channel(): RuntimeBundle['channel'] {
    const user = this.auth.session()?.twitchUser, id = this.widgets.channelId;
    return user && user.id === id ? { id, login: user.login, name: user.display_name || user.login } : { id, login: '', name: '' };
  }
  private starterTexts(): StarterTexts {
    const keys: (keyof StarterTexts)[] = ['groupLook', 'groupChat', 'groupAlerts', 'accent', 'text', 'size', 'max', 'alerts', 'follow', 'sub', 'gift', 'bits', 'raid'];
    return Object.fromEntries(keys.map(key => [key, this.t('customTpl_' + key)])) as unknown as StarterTexts;
  }

  private async init(): Promise<void> {
    const widget = untracked(this.widget);
    if (widget) { await this.openWidget(widget); return; }
    const draft = readCodeDraft(this.widgets.channelId, 'new');
    this.newDraft.set(draft);
    this.name.set(this.t('customCodeDefaultName'));
    this.step.set('start');
  }
  private async fetchFiles(id: string, revision: number): Promise<CodeFiles> {
    const parts = ['html', 'css', 'js', 'fields', 'data'] as const;
    const [texts, manifest] = await Promise.all([Promise.all(parts.map(part => this.widgets.file(id, part, revision))),
      this.widgets.file(id, 'manifest', revision).catch(() => '')]);
    return { html: texts[0], css: texts[1], js: texts[2], fields: texts[3], data: texts[4], manifest };
  }
  private async openWidget(widget: CustomWidgetView): Promise<void> {
    this.step.set('code'); this.loading.set(true); this.loadError.set('');
    this.widgetId.set(widget.id); this.name.set(widget.name);
    try {
      const files = await this.fetchFiles(widget.id, widget.revision);
      // Copied StreamElements files load from preview links (the frame can't send the login token).
      if (Object.keys(widget.media ?? {}).length) this.media = (await this.widgets.resolveMedia({ media: widget.media } as RuntimeBundle)).media;
      this.saved.set(files); this.base.set(widget.revision);
      const draft = readCodeDraft(this.widgets.channelId, widget.id);
      let start = files;
      if (draft && !sameCodeFiles(draft.files, files)) {
        if (draft.base === widget.revision) { start = draft.files; this.draftNote.set({ at: draft.at, base: draft.base, mismatch: false }); }
        else { this.pendingDraft = draft; this.draftNote.set({ at: draft.at, base: draft.base, mismatch: true }); }
      }
      this.replaceAll(start); this.settled.set(start);
    } catch (error) {
      this.loadError.set(message(error) || this.t('customCodeLoadFailed'));
    } finally { this.loading.set(false); }
  }
  private async mountEditor(host: HTMLElement): Promise<void> {
    this.editor?.destroy(); this.editor = null; this.editorParent = host;
    this.editorState.set('loading');
    try {
      const { createCodeEditor } = await import('./custom-widget-code-mirror');
      if (this.destroyed || this.editorParent !== host) return;
      const files = this.files();
      const tabs = Object.fromEntries(CODE_FILES.map(file => [file, { text: files[file], language: TAB_LANGUAGE[file], label: this.t('customCodeEditorLabel', { file: this.fileLabel(file) }) }])) as Record<CodeFile, CodeTab>;
      this.editor = createCodeEditor(host, tabs, this.tab(), (tab, text) => this.files.update(all => all[tab] === text ? all : { ...all, [tab]: text }));
      this.editorState.set('ready');
    } catch {
      this.editorState.set('failed');
    }
  }
  /** Puts new text in every tab (editor and state), each as an undoable change. */
  private replaceAll(files: CodeFiles): void {
    for (const file of CODE_FILES) this.editor?.setText(file, files[file]);
    this.files.set({ ...files });
  }
  setFile(file: CodeFile, text: string): void { this.files.update(all => ({ ...all, [file]: text })); }

  start(): void {
    if (this.blockedByLimit()) return;
    const name = this.name().trim() || this.t('customCodeDefaultName');
    const files = starterFiles(this.starter(), name, this.starterTexts());
    this.name.set(name); this.saved.set(null); this.base.set(0); this.tab.set('js');
    this.files.set(files); this.settled.set(files); this.step.set('code');
  }
  continueDraft(): void {
    const draft = this.newDraft(); if (!draft) return;
    this.name.set(draft.name || this.t('customCodeDefaultName')); this.saved.set(null); this.base.set(0); this.tab.set('js');
    this.files.set(draft.files); this.settled.set(draft.files); this.step.set('code');
  }
  discardNewDraft(): void { clearCodeDraft(this.widgets.channelId, 'new'); this.newDraft.set(null); }
  discardRestored(): void {
    const saved = this.saved(); if (saved) this.replaceAll(saved);
    clearCodeDraft(this.widgets.channelId, this.widgetId() ?? 'new'); this.draftNote.set(null);
  }
  openPendingDraft(): void { if (this.pendingDraft) this.replaceAll(this.pendingDraft.files); this.pendingDraft = null; this.draftNote.set(null); }
  dropPendingDraft(): void { clearCodeDraft(this.widgets.channelId, this.widgetId() ?? 'new'); this.pendingDraft = null; this.draftNote.set(null); }
  discardChanges(): void { const saved = this.saved(); if (saved) { this.replaceAll(saved); this.openedVersion.set(null); } }

  selectTab(file: CodeFile): void { this.tab.set(file); this.editor?.show(file); }
  /** Arrow keys move between tabs (WAI-ARIA tabs). */
  tabKey(event: KeyboardEvent, file: CodeFile): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!step) return;
    event.preventDefault();
    const next = CODE_FILES[(CODE_FILES.indexOf(file) + step + CODE_FILES.length) % CODE_FILES.length];
    this.selectTab(next);
    (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-cwc-tab="${next}"]`)?.focus();
  }
  goTo(problem: CodeProblem): void {
    if (!problem.tab) return;
    this.pane.set('code');
    if (problem.line && this.editor) { this.tab.set(problem.tab); this.editor.reveal(problem.tab, problem.line); }
    else this.selectTab(problem.tab);
  }
  /** widget.json written from what Studio worked out, so it can be adjusted. */
  addManifest(): void {
    const manifest = this.manifest(); if (!manifest) return;
    const written: Record<string, unknown> = { ...manifest, name: this.name() }; delete written['inferred'];
    const text = JSON.stringify(written, null, 2) + '\n';
    if (this.editor) this.editor.setText('manifest', text); else this.setFile('manifest', text);
  }

  async loadVersion(revision: number): Promise<void> {
    const id = this.widgetId(); if (!id || this.versionBusy() !== null) return;
    this.versionBusy.set(revision); this.versionError.set('');
    try { this.replaceAll(await this.fetchFiles(id, revision)); this.openedVersion.set(revision); this.pane.set('code'); }
    catch (error) { this.versionError.set(message(error) || this.t('customCodeLoadFailed')); }
    finally { this.versionBusy.set(null); }
  }

  /** Creates the widget (first save) or adds a revision. `force` skips the "changed elsewhere" check. */
  async save(force = false): Promise<void> {
    if (this.saving() || this.blockedByLimit()) return;
    const files = this.files(), id = this.widgetId();
    if (id && !this.dirty()) return;
    const checked = checkCode(files, issue => this.t('customIssue_' + issue.code));
    const problem = checked.problems.find(item => item.blocking);
    // The problems list and footer already say what to fix: jump to it.
    if (problem) { this.settled.set(files); this.saveError.set(''); this.goTo(problem); return; }
    this.saving.set(true); this.saveError.set(''); this.stale.set(false);
    try {
      if (!id) {
        const result = await this.widgets.create(this.name().trim() || this.t('customCodeDefaultName'), toPackage(files));
        clearCodeDraft(this.widgets.channelId, 'new');
        this.widgetId.set(result.widget.id); this.base.set(result.widget.revision); this.name.set(result.widget.name);
        this.created.emit(result.widget);
      } else {
        const result = await this.widgets.replace(id, toPackage(files), force ? undefined : this.base());
        this.base.set(result.widget.revision);
        clearCodeDraft(this.widgets.channelId, id);
      }
      this.saved.set(files); this.openedVersion.set(null); this.draftNote.set(null);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'stale') this.stale.set(true);
      else if (code === 'plan_limit' || code === 'limit') this.limitReached.set(true);
      this.saveError.set(code === 'stale' ? '' : message(error) || this.t('customCodeSaveFailed'));
    } finally { this.saving.set(false); }
  }

  sendChat(kind: ChatTest): void { this.env.emit(this.env.chatTest(kind), PREVIEW_LAYER); }
  sendAlert(kind: AlertTest): void { this.env.emit(this.env.alertTest(kind), PREVIEW_LAYER); }
  deleteLast(): void { const event = this.env.deleteTest(); if (event) this.env.emit(event, PREVIEW_LAYER); }
  clearChat(): void { this.env.emit(this.env.clearTest(), PREVIEW_LAYER); }
  reloadPreview(): void { const bundle = this.previewBundle(); if (bundle) this.previewBundle.set({ ...bundle }); }
  clearLog(): void { this.env.clearLog(PREVIEW_LAYER); }
  time(at: number): string { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  upgrade(): void { void this.upgrades.promptUpgradeForAnyPlan('custom_widgets'); }

  /** Ctrl/⌘+S saves. */
  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.step() === 'code') { event.preventDefault(); void this.save(); }
  }
  /** Escape inside the code is the editor's (closing search, leaving with Tab), not the dialog's. */
  onCancel(event: Event): void {
    if (this.saving() || (document.activeElement as HTMLElement | null)?.closest('.cm-editor')) event.preventDefault();
  }
  close(): void { if (!this.saving()) this.dialog().nativeElement.close(); }
  onClosed(): void { this.returnFocus?.focus?.(); this.closed.emit(); }
}
