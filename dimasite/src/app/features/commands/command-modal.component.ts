import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import {
  Command,
  CreateCommandRequest,
  USER_LEVELS
} from '../../models/command.model';
import { inspectExpression, type PermissionExpression } from '../../models/permission.model';
import {
  PermissionExpressionEditorComponent,
  type PermissionEditorValue
} from '../permissions/permission-expression-editor.component';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

export type PlanTier = 'free' | 'premium' | 'pro';

export interface CommandModalSavePayload {
  command: CreateCommandRequest;
  timer: {
    enabled: boolean;
    minutes: number | null;
  };
}

const FREE_INTERVALS = [15, 30, 45, 60] as const;
const PREMIUM_QUICK = [5, 10, 15, 30, 45, 60, 90, 120, 180] as const;
const PRO_QUICK = [1, 5, 7, 12, 15, 30, 45, 60, 90, 120, 180] as const;

@Component({
  selector: 'app-command-modal',
  imports: [ReactiveFormsModule, LfIconComponent, PermissionExpressionEditorComponent],
  templateUrl: './command-modal.component.html',
  styleUrl: './command-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandModalComponent {
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);

  readonly isOpen = input.required<boolean>();
  readonly command = input<Command | null>(null);
  readonly planTier = input<PlanTier>('free');
  /** Existing timer interval for this command (minutes), if linked. */
  readonly existingTimerMinutes = input<number | null>(null);

  readonly isEditMode = signal(false);
  readonly isSaving = signal(false);
  readonly formError = signal<string | null>(null);

  readonly save = output<CommandModalSavePayload>();
  readonly cancel = output<void>();

  readonly freeIntervals = FREE_INTERVALS;
  readonly premiumQuick = PREMIUM_QUICK;
  readonly proQuick = PRO_QUICK;

  readonly commandForm = this.fb.group({
    name: ['', [Validators.required]],
    cmd: ['', [Validators.required]],
    message: ['', [Validators.required]],
    description: [''],
    cooldown: [10, [Validators.required, Validators.min(5), Validators.max(60)]],
    /** Permission editor value: exclusive Level (legacy) vs Tags (advanced) mode. */
    permission: [this.defaultPermissionValue()],
    enabled: [true],
    timerEnabled: [false],
    timerMinutes: [15 as number | null]
  });

  readonly minCooldown = computed(() => this.planTier() === 'pro' ? 1 : this.planTier() === 'premium' ? 3 : 5);

  readonly isReserved = computed(() => Boolean(this.command()?.reserved));

  /** Invalid stored permission configuration surfaced for repair. */
  readonly storedPermissionInvalid = computed(() => this.command()?.permissionMode === 'invalid');

  readonly intervalHint = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') {
      return this.t('commands.modal.timerHintPro');
    }
    if (tier === 'premium') {
      return this.t('commands.modal.timerHintPremium');
    }
    return this.t('commands.modal.timerHintFree');
  });

  readonly timerLimitLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') return '50';
    if (tier === 'premium') return '15';
    return '5';
  });

  constructor() {
    effect(() => {
      const cooldown = this.commandForm.controls.cooldown;
      cooldown.setValidators([Validators.required, Validators.min(this.minCooldown()), Validators.max(60)]);
      cooldown.updateValueAndValidity({ emitEvent: false });
    });
    effect(() => {
      if (!this.isOpen()) {
        this.isSaving.set(false);
        this.formError.set(null);
        return;
      }
      this.setupForm();
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  onOverlayClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  onCancel(): void {
    this.cancel.emit();
  }

  setTimerEnabled(enabled: boolean): void {
    this.commandForm.patchValue({ timerEnabled: enabled });
    if (enabled && !this.commandForm.value.timerMinutes) {
      this.commandForm.patchValue({
        timerMinutes: this.planTier() === 'free' ? 15 : this.planTier() === 'premium' ? 15 : 5
      });
    }
    this.formError.set(null);
  }

  setTimerMinutes(minutes: number): void {
    this.commandForm.patchValue({ timerMinutes: minutes });
    this.formError.set(null);
  }

  onSubmit(): void {
    if (this.commandForm.invalid) {
      this.commandForm.markAllAsTouched();
      this.formError.set(this.t('commands.modal.validationRequired'));
      return;
    }

    const formValue = this.commandForm.getRawValue();
    const timerEnabled = Boolean(formValue.timerEnabled) && !this.isReserved();
    const timerMinutes = Number(formValue.timerMinutes);

    if (timerEnabled) {
      const validation = this.validateTimerMinutes(timerMinutes, this.planTier());
      if (!validation.valid) {
        this.formError.set(validation.error || this.t('commands.modal.timerInvalid'));
        return;
      }
    }

    const permission = (formValue.permission ?? this.defaultPermissionValue()) as PermissionEditorValue;

    // Tag mode cannot be saved without at least one valid node.
    if (permission.mode === 'tags' && !permission.permissionExpression) {
      this.formError.set(this.t('permissions.editor.needsNode'));
      return;
    }

    const userLevel = Number.isInteger(permission.userLevel) && permission.userLevel >= 1 && permission.userLevel <= 10
      ? permission.userLevel
      : 1;

    this.isSaving.set(true);
    this.formError.set(null);

    const request: CreateCommandRequest = {
      name: String(formValue.name || '').trim(),
      cmd: String(formValue.cmd || '')
        .trim()
        .replace(/^!/, ''),
      func: String(formValue.cmd || '')
        .trim()
        .replace(/^!/, ''),
      message: String(formValue.message || '').trim(),
      description: formValue.description ? String(formValue.description).trim() : null,
      cooldown: Number(formValue.cooldown) || 10,
      userLevel,
      userLevelName: USER_LEVELS[userLevel],
      // Level mode sends null (with the numeric pair); tags mode sends the
      // validated tree. Selecting Everyone in tag mode is {role:'everyone'}.
      permissionExpression: permission.mode === 'tags' ? permission.permissionExpression : null,
      enabled: formValue.enabled !== false,
      channel: ''
    };

    this.save.emit({
      command: request,
      timer: {
        enabled: timerEnabled,
        minutes: timerEnabled ? timerMinutes : null
      }
    });

    setTimeout(() => this.isSaving.set(false), 500);
  }

  private setupForm(): void {
    const cmd = this.command();
    this.isEditMode.set(!!cmd);
    this.formError.set(null);

    const existingMinutes = this.existingTimerMinutes();
    const hasTimer = existingMinutes !== null && existingMinutes !== undefined && existingMinutes > 0;

    if (cmd) {
      this.commandForm.patchValue({
        name: cmd.name,
        cmd: cmd.cmd,
        message: cmd.message,
        description: cmd.description || '',
        cooldown: cmd.cooldown,
        permission: this.permissionValueFor(cmd),
        enabled: cmd.enabled,
        timerEnabled: hasTimer && !cmd.reserved,
        timerMinutes: hasTimer ? existingMinutes : this.defaultTimerMinutes()
      });

      if (cmd.reserved) {
        this.commandForm.get('cmd')?.disable({ emitEvent: false });
        this.commandForm.get('message')?.disable({ emitEvent: false });
        this.commandForm.get('timerEnabled')?.disable({ emitEvent: false });
        this.commandForm.get('timerMinutes')?.disable({ emitEvent: false });
      } else {
        this.commandForm.get('cmd')?.enable({ emitEvent: false });
        this.commandForm.get('message')?.enable({ emitEvent: false });
        this.commandForm.get('timerEnabled')?.enable({ emitEvent: false });
        this.commandForm.get('timerMinutes')?.enable({ emitEvent: false });
      }
    } else {
      this.commandForm.reset({
        name: '',
        cmd: '',
        message: '',
        description: '',
        cooldown: 10,
        permission: this.defaultPermissionValue(),
        enabled: true,
        timerEnabled: false,
        timerMinutes: this.defaultTimerMinutes()
      });
      this.commandForm.enable({ emitEvent: false });
    }
  }

  private defaultPermissionValue(): PermissionEditorValue {
    return { mode: 'level', userLevel: 1, permissionExpression: null };
  }

  private permissionValueFor(cmd: Command): PermissionEditorValue {
    const state = inspectExpression(cmd.permissionExpression);
    const storedLevel = Number.isInteger(cmd.userLevel) && cmd.userLevel >= 1 && cmd.userLevel <= 10
      ? cmd.userLevel
      : 1;

    if (state.mode === 'tags') {
      // Preselect the existing expression; the numeric pair stays stored but
      // inert while tag mode is active.
      return { mode: 'tags', userLevel: storedLevel, permissionExpression: state.expression };
    }

    return { mode: 'level', userLevel: storedLevel, permissionExpression: null };
  }

  private defaultTimerMinutes(): number {
    return this.planTier() === 'free' ? 15 : 15;
  }

  private validateTimerMinutes(
    minutes: number,
    tier: PlanTier
  ): { valid: boolean; error?: string } {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return { valid: false, error: this.t('commands.modal.timerInvalid') };
    }

    if (tier === 'pro') {
      if (minutes > 180) {
        return { valid: false, error: this.t('commands.modal.timerHintPro') };
      }
      return { valid: true };
    }

    if (tier === 'premium') {
      if (minutes < 5 || minutes > 180 || minutes % 5 !== 0) {
        return { valid: false, error: this.t('commands.modal.timerHintPremium') };
      }
      return { valid: true };
    }

    if (![15, 30, 45, 60].includes(minutes)) {
      return { valid: false, error: this.t('commands.modal.timerHintFree') };
    }
    return { valid: true };
  }
}
