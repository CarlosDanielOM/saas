import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';

import {
  countExpressionNodes,
  describeExpression,
  inspectExpression,
  isRoleTag,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  ROLE_TAGS,
  validateExpression,
  type PermissionExpression,
  type RoleTag
} from '../../models/permission.model';
import { USER_LEVELS, USER_LEVEL_NAMES } from '../../models/command.model';
import { LanguageService } from '../../services/language.service';

/** Shape exchanged with the parent form. */
export interface PermissionEditorValue {
  mode: 'level' | 'tags';
  userLevel: number;
  /** Valid tree in tags mode; null in level mode or while invalid. */
  permissionExpression: PermissionExpression | null;
}

type EditorNode =
  | { kind: 'role'; role: RoleTag }
  | { kind: 'level'; level: number }
  | { kind: 'not'; child: EditorNode | null }
  | { kind: 'group'; operator: 'and' | 'or'; children: EditorNode[] };

const LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function editorNodeToExpression(node: EditorNode | null): PermissionExpression | null {
  if (!node) return null;

  switch (node.kind) {
    case 'role':
      return { role: node.role };
    case 'level':
      return { level: node.level };
    case 'not': {
      const child = editorNodeToExpression(node.child);
      return child ? { not: child } : null;
    }
    case 'group': {
      if (node.children.length === 0) return null;
      const children = node.children
        .map((child) => editorNodeToExpression(child))
        .filter((child): child is PermissionExpression => child !== null);
      if (children.length !== node.children.length) return null;
      return { [node.operator]: children } as PermissionExpression;
    }
  }
}

function expressionToEditorNode(expr: PermissionExpression | null | undefined): EditorNode | null {
  if (!expr || typeof expr !== 'object') return null;

  if ('role' in expr && isRoleTag((expr as { role: unknown }).role)) {
    return { kind: 'role', role: (expr as { role: RoleTag }).role };
  }
  if ('level' in expr && typeof (expr as { level: unknown }).level === 'number') {
    return { kind: 'level', level: (expr as { level: number }).level };
  }
  if ('not' in expr) {
    return { kind: 'not', child: expressionToEditorNode((expr as { not: unknown }).not as PermissionExpression) };
  }
  if ('and' in expr || 'or' in expr) {
    const operator = 'and' in expr ? 'and' : 'or';
    const children = ((expr as { and?: unknown[]; or?: unknown[] })[operator] ?? []) as PermissionExpression[];
    return {
      kind: 'group',
      operator,
      children: children.map(expressionToEditorNode).filter((child): child is EditorNode => child !== null)
    };
  }

  return null;
}

interface DepthNode {
  kind?: string;
  child?: DepthNode | null;
  children?: DepthNode[];
}

function nodeDepth(node: DepthNode | null | undefined): number {
  if (!node) return 0;
  switch (node.kind) {
    case 'not':
      return 1 + nodeDepth(node.child);
    case 'group':
      return 1 + Math.max(0, ...(node.children ?? []).map(nodeDepth));
    default:
      return 1;
  }
}

/**
 * Recursive permission-expression editor (TAG_PERMISSION_SYSTEM.md §6.1).
 *
 * Exclusive mode toggle: Level (legacy numeric) vs Tags (boolean expression
 * tree). Emits PermissionEditorValue through ControlValueAccessor; tag mode
 * requires at least one valid node before it can be saved. The live localized
 * preview is produced entirely client-side from translated labels.
 *
 * Tree mutations edit the working nodes in place and then publish a fresh
 * clone through the `root` signal so OnPush change detection and the
 * computed validators re-run on every edit.
 */
@Component({
  selector: 'app-permission-expression-editor',
  imports: [NgTemplateOutlet],
  templateUrl: './permission-expression-editor.component.html',
  styleUrl: './permission-expression-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: PermissionExpressionEditorComponent,
      multi: true
    }
  ]
})
export class PermissionExpressionEditorComponent implements ControlValueAccessor {
  private readonly languageService = inject(LanguageService);

  /** Set when the stored configuration is invalid and must be repaired. */
  readonly storedInvalid = input<boolean>(false);
  readonly disabled = input(false);

  /**
   * Standalone value binding for signal-based pages (moderation). External
   * values are applied only when they differ from the last emitted value, so
   * feeding the emitted value back does not reset in-progress edits.
   */
  readonly value = input<unknown>(null);
  readonly valueChange = output<PermissionEditorValue>();

  readonly roleTags = ROLE_TAGS;
  readonly levelOptions = LEVEL_OPTIONS;
  readonly maxDepth = MAX_EXPRESSION_DEPTH;
  readonly maxNodes = MAX_EXPRESSION_NODES;

  readonly mode = signal<'level' | 'tags'>('level');
  readonly level = signal<number>(1);
  readonly root = signal<EditorNode | null>(null);

  private readonly currentExpression = computed<PermissionExpression | null>(() => {
    if (this.mode() !== 'tags') return null;
    return editorNodeToExpression(this.root());
  });

  readonly treeNodes = computed(() => {
    this.root();
    return this.mode() === 'tags' ? countExpressionNodes(this.currentExpression()) : 0;
  });
  readonly treeDepth = computed(() => {
    this.root();
    return this.mode() === 'tags' ? nodeDepth(this.root()) : 0;
  });
  readonly nodesRemaining = computed(() => MAX_EXPRESSION_NODES - this.treeNodes());
  readonly depthRemaining = computed(() => MAX_EXPRESSION_DEPTH - this.treeDepth());

  readonly validationResult = computed<{ ok: boolean; errorKey: string | null }>(() => {
    if (this.mode() !== 'tags') return { ok: true, errorKey: null };
    const tree = this.currentExpression();
    if (!tree) return { ok: false, errorKey: 'permissions.editor.needsNode' };
    const result = validateExpression(tree);
    if (!result.ok) return { ok: false, errorKey: result.error };
    return { ok: true, errorKey: null };
  });

  readonly validExpression = computed<PermissionExpression | null>(() => {
    if (this.mode() !== 'tags') return null;
    return this.validationResult().ok ? this.currentExpression() : null;
  });

  readonly previewText = computed(() => {
    if (this.mode() === 'level') {
      return this.t(USER_LEVEL_NAMES[this.level()] ?? 'commands.userLevels.everyone');
    }
    const tree = this.validExpression();
    if (!tree) return this.t('permissions.editor.needsNode');
    return describeExpression(tree, {
      roleLabel: (role) => this.t(`permissions.roles.${role}`),
      operatorLabel: () => '',
      levelLabel: (levelValue) => this.t(USER_LEVEL_NAMES[levelValue] ?? 'commands.userLevels.everyone'),
      formatSummary: (pattern, params) => this.t(pattern, params)
    });
  });

  private onChange: (value: PermissionEditorValue) => void = () => undefined;
  private onTouched: () => void = () => undefined;
  private internalDisabled = false;
  private lastEmittedJson: string | null = null;

  constructor() {
    effect(() => {
      const incoming = this.value();
      if (incoming === null || incoming === undefined) return;
      const incomingJson = JSON.stringify(incoming);
      if (incomingJson === this.lastEmittedJson) return;
      this.writeValue(incoming);
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  levelName(level: number): string {
    return USER_LEVEL_NAMES[level] ?? 'commands.userLevels.everyone';
  }

  // ========== ControlValueAccessor ==========

  writeValue(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.mode.set('level');
      this.level.set(1);
      this.root.set(null);
      return;
    }

    const record = value as Partial<PermissionEditorValue> & { permissionExpression?: unknown };
    const state = inspectExpression(record.permissionExpression ?? null);
    const storedLevel = typeof record.userLevel === 'number' ? record.userLevel : 1;

    if (state.mode === 'tags') {
      this.mode.set('tags');
      this.level.set(storedLevel);
      this.root.set(expressionToEditorNode(state.expression));
    } else if (state.mode === 'invalid') {
      // Repair flow: start in tags mode with an empty tree; the parent
      // surfaces the invalid-configuration warning.
      this.mode.set('tags');
      this.level.set(storedLevel);
      this.root.set(null);
    } else {
      this.mode.set('level');
      this.level.set(storedLevel);
      this.root.set(null);
    }
  }

  registerOnChange(fn: (value: PermissionEditorValue) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.internalDisabled = isDisabled;
  }

  isDisabled(): boolean {
    return this.internalDisabled || this.disabled();
  }

  // ========== Mode + level ==========

  setMode(mode: 'level' | 'tags'): void {
    if (this.isDisabled() || this.mode() === mode) return;
    this.mode.set(mode);
    this.emitChange();
  }

  onLevelChange(event: Event): void {
    if (this.isDisabled()) return;
    const parsed = Number((event.target as HTMLSelectElement).value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) return;
    this.level.set(parsed);
    this.emitChange();
  }

  // ========== Tree editing ==========

  setRoot(node: EditorNode | null): void {
    if (this.isDisabled()) return;
    this.root.set(node);
    this.emitChange();
  }

  canAddChild(parentDepth: number): boolean {
    if (this.isDisabled()) return false;
    return this.nodesRemaining() > 0 && parentDepth < MAX_EXPRESSION_DEPTH;
  }

  addChild(group: { children: EditorNode[] }, child: EditorNode): void {
    if (!this.canAddChild(nodeDepth(group))) return;
    group.children.push(child);
    this.commit();
  }

  removeChild(group: { children: EditorNode[] }, index: number): void {
    if (this.isDisabled()) return;
    group.children.splice(index, 1);
    this.commit();
  }

  setNotChild(node: { child: EditorNode | null }, child: EditorNode | null): void {
    if (this.isDisabled()) return;
    node.child = child;
    this.commit();
  }

  onGroupOperatorChange(group: { operator: 'and' | 'or' }, event: Event): void {
    if (this.isDisabled()) return;
    const value = (event.target as HTMLSelectElement).value;
    if (value !== 'and' && value !== 'or') return;
    group.operator = value;
    this.commit();
  }

  onNodeRoleChange(node: { role: RoleTag }, event: Event): void {
    if (this.isDisabled()) return;
    const value = (event.target as HTMLSelectElement).value;
    if (!isRoleTag(value)) return;
    node.role = value;
    this.commit();
  }

  onNodeLevelChange(node: { level: number }, event: Event): void {
    if (this.isDisabled()) return;
    const parsed = Number((event.target as HTMLSelectElement).value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) return;
    node.level = parsed;
    this.commit();
  }

  nodeTrackKey(node: EditorNode, index: number): string {
    return `${node.kind}-${index}`;
  }

  private commit(): void {
    // Publish a fresh reference so OnPush + computed validators re-run.
    this.root.set(this.root() ? structuredClone(this.root()) as EditorNode : null);
    this.emitChange();
  }

  private emitChange(): void {
    this.onTouched();
    const value: PermissionEditorValue = {
      mode: this.mode(),
      userLevel: this.level(),
      permissionExpression: this.validExpression()
    };
    this.lastEmittedJson = JSON.stringify(value);
    this.onChange(value);
    this.valueChange.emit(value);
  }
}
