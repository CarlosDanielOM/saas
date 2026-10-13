import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, input, output, viewChild } from '@angular/core';

import { IconComponent } from '../../shared/icon/icon.component';
import { KIND_LABEL, SERVICE_LABEL, formatMs, isFailedOutcome } from './observability-format';

export interface Span {
  at: string;
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  service: string;
  channel: string;
  kind: string;
  name: string;
  outcome: string;
  duration: number;
  partial: boolean;
}

/** One request as a waterfall: bottom sheet on phones, centred dialog from 640px. */
@Component({
  selector: 'app-observability-trace',
  imports: [IconComponent],
  templateUrl: './observability-trace.component.html',
  styleUrl: './observability-trace.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityTraceComponent implements AfterViewInit {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly trace = input.required<{ spans: Span[]; partial: boolean }>();
  readonly channelNames = input.required<Record<string, string | null>>();
  readonly closed = output<void>();

  readonly start = computed(() => Math.min(...this.trace().spans.map((s) => Date.parse(s.at))));
  readonly duration = computed(() => Math.max(1, ...this.trace().spans.map((s) => Date.parse(s.at) + s.duration - this.start())));
  readonly root = computed(() => this.trace().spans.find((s) => !s.parent_id) ?? this.trace().spans[0] ?? null);

  readonly ms = formatMs;
  readonly isFailed = isFailedOutcome;

  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }
  close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }
  onBackdrop(event: MouseEvent): void {
    const dialog = this.dialog().nativeElement;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
  }
  offset(span: Span): number {
    return Math.max(0, ((Date.parse(span.at) - this.start()) / this.duration()) * 100);
  }
  width(span: Span): number {
    return Math.max(0.8, (span.duration / this.duration()) * 100);
  }
  label(span: Span): string {
    const channel = span.channel ? `${this.channelNames()[span.channel] || 'Unknown channel'} (${span.channel})` : 'System';
    return `${KIND_LABEL[span.kind] ?? span.kind} · ${SERVICE_LABEL[span.service] ?? span.service} · ${channel}`;
  }
}
