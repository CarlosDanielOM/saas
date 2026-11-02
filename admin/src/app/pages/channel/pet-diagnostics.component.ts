import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PetDiagnosticsService, type PetDiagnostics, type PetComputer } from '../../services/pet-diagnostics.service';
import { IconComponent } from '../../shared/icon/icon.component';
@Component({
  selector: 'app-pet-diagnostics',
  imports: [IconComponent],
  templateUrl: './pet-diagnostics.component.html',
  styleUrl: './pet-diagnostics.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PetDiagnosticsComponent {
  readonly channelID = input.required<string>();
  private readonly api = inject(PetDiagnosticsService);
  private readonly destroy = inject(DestroyRef);
  readonly data = signal<PetDiagnostics | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  private requestSerial = 0;
  readonly summary = computed(() => {
    const d = this.data();
    if (!d?.configured) return 'Pet has not been set up';
    if (!d.enabled) return 'Pet is switched off';
    if (d.appearance !== 'vts') return 'Pet uses images; VTube Studio is not required';
    if (!d.vts.selectedSessionId) return 'Choose a VTube Studio computer';
    if (!d.vts.session) return 'The saved VTube Studio computer is unavailable';
    if (d.vts.session.authorization !== 'valid') return 'The selected computer needs authorization';
    if (!d.vts.connected) return 'The selected VTube Studio computer is disconnected';
    if (!d.vts.reportedReady) return 'Dima is connected; VTube Studio is not ready';
    if (!d.vts.ready) return 'VTube Studio readiness could not be confirmed';
    return 'VTube Studio is ready';
  });
  constructor() { effect(() => { this.channelID(); untracked(() => { this.data.set(null); this.refresh(true); }); }); }
  refresh(changedChannel = false) {
    if (this.loading() && !changedChannel) return;
    const serial = ++this.requestSerial;
    this.loading.set(true); this.error.set(false);
    this.api.get(this.channelID()).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: response => { if (serial === this.requestSerial) { this.data.set(response.data); this.loading.set(false); } },
      error: () => { if (serial === this.requestSerial) { this.error.set(true); this.loading.set(false); } },
    });
  }
  authorization(computer: PetComputer) {
    if (!computer.selectedSessionId) return 'No computer selected';
    if (!computer.session) return 'Saved session not found';
    return ({ valid: 'Valid saved session', expired: 'Expired — sign in again', revoked: 'Revoked — sign in again',
      insufficient_scope: 'Missing permissions — authorize again', client_disabled: 'Application disabled' })[computer.session.authorization];
  }
  date(value: string | null | undefined) { return value ? new Date(value).toLocaleString() : 'Not available'; }
}
