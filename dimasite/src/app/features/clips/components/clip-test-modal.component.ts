import {
  ChangeDetectionStrategy,
  Component,
  NgZone,
  OnDestroy,
  OnInit,
  inject,
  input,
  output,
  signal
} from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ClipDesign, ClipTestRequest, ClipTestResponse } from '../clips.model';
import { ClipsService } from '../clips.service';

type TestState = 'sending' | 'ended' | 'error';

@Component({
  selector: 'app-clip-test-modal',
  templateUrl: './clip-test-modal.component.html',
  styleUrl: './clip-test-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipTestModalComponent implements OnInit, OnDestroy {
  private readonly zone = inject(NgZone);
  private readonly clipsService = inject(ClipsService);
  private readonly languageService = inject(LanguageService);

  readonly channelID = input.required<string>();
  readonly streamer = input.required<string>();
  readonly design = input.required<ClipDesign>();
  readonly timeout = input<number>(30);
  readonly closed = output<void>();

  readonly testState = signal<TestState>('sending');
  readonly progress = signal(12);
  readonly errorMessage = signal('');
  readonly isClosing = signal(false);

  private closeTimeoutId: number | null = null;
  private requestTimeoutId: number | null = null;
  private progressKickoffId: number | null = null;
  private readonly closeAnimationMs = 280;

  ngOnInit(): void {
    queueMicrotask(() => this.startTest());
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  startTest(): void {
    this.clearTimers();
    this.isClosing.set(false);
    this.testState.set('sending');
    this.progress.set(14);
    this.errorMessage.set('');
    this.startProgressLeadIn();
    this.startRequestTimeout();

    const request: ClipTestRequest = {
      channelID: this.channelID(),
      streamer: this.streamer(),
      timeout: this.timeout()
    };

    this.clipsService.testClip(request).subscribe({
      next: (response: ClipTestResponse) => {
        if (response.error) {
          this.clearTimers();
          this.errorMessage.set(response.message || this.t('clips.test.errorFallback'));
          this.testState.set('error');
          this.progress.set(0);
          return;
        }
        this.finishSuccessSequence();
      },
      error: () => {
        this.clearTimers();
        this.errorMessage.set(this.t('clips.test.sendFailed'));
        this.testState.set('error');
        this.progress.set(0);
      }
    });
  }

  onBackdropClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.requestClose();
    }
  }

  requestClose(delay = this.closeAnimationMs): void {
    if (this.isClosing()) {
      return;
    }

    this.clearTimers();
    this.isClosing.set(true);
    this.closeTimeoutId = window.setTimeout(() => {
      this.zone.run(() => {
        this.closed.emit();
      });
    }, delay);
  }

  private startProgressLeadIn(): void {
    this.clearProgressKickoff();
    this.progressKickoffId = window.setTimeout(() => {
      this.zone.run(() => {
        if (!this.isClosing() && this.testState() === 'sending') {
          this.progress.set(68);
        }
      });
    }, 140);
  }

  private startRequestTimeout(): void {
    this.clearRequestTimeout();
    this.requestTimeoutId = window.setTimeout(() => {
      this.zone.run(() => {
        if (!this.isClosing() && this.testState() === 'sending') {
          this.testState.set('error');
          this.progress.set(0);
          this.errorMessage.set(this.t('clips.test.timeout'));
        }
      });
    }, 8000);
  }

  private clearTimers(): void {
    this.clearCloseTimeout();
    this.clearRequestTimeout();
    this.clearProgressKickoff();
  }

  private clearRequestTimeout(): void {
    if (this.requestTimeoutId !== null) {
      window.clearTimeout(this.requestTimeoutId);
      this.requestTimeoutId = null;
    }
  }

  private clearProgressKickoff(): void {
    if (this.progressKickoffId !== null) {
      window.clearTimeout(this.progressKickoffId);
      this.progressKickoffId = null;
    }
  }

  private clearCloseTimeout(): void {
    if (this.closeTimeoutId !== null) {
      window.clearTimeout(this.closeTimeoutId);
      this.closeTimeoutId = null;
    }
  }

  private finishSuccessSequence(): void {
    this.clearRequestTimeout();
    this.clearProgressKickoff();
    this.progress.set(100);
    this.testState.set('ended');
    this.scheduleCloseSequence(900);
  }

  private scheduleCloseSequence(waitBeforeClose = 320): void {
    this.clearCloseTimeout();
    this.closeTimeoutId = window.setTimeout(() => {
      this.requestClose();
    }, waitBeforeClose);
  }
}
