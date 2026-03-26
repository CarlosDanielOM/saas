import { 
  Component, 
  ElementRef, 
  AfterViewInit,
  OnInit, 
  OnDestroy, 
  viewChild, 
  ChangeDetectionStrategy, 
  NgZone,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule, X, Zap, Loader2 } from 'lucide-angular';
import * as THREE from 'three';
import { ClipsService } from '../clips.service';
import { ClipDesign, ClipTestRequest, ClipTestResponse } from '../clips.model';

type TestState = 'idle' | 'connecting' | 'sending' | 'playing' | 'ended' | 'error';

@Component({
  selector: 'app-clip-test-modal',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  template: `
    <div class="modal-backdrop" [class.mobile]="isMobile" [class.closing]="isClosing()" (click)="onBackdropClick()">
      <div class="modal-container" [class.mobile]="isMobile" [class.closing]="isClosing()" (click)="$event.stopPropagation()">
        @if (!isMobile) {
          <div class="stage-3d" #stage3d></div>
        }
        
        <div class="modal-content">
          <button class="close-btn" (click)="requestClose()">
            <lucide-icon [name]="closeIcon" class="close-icon"></lucide-icon>
          </button>
          
          <div class="status-display">
            @switch (testState()) {
              @case ('connecting') {
                <div class="status-content">
                  <lucide-icon [name]="loaderIcon" class="status-icon spin"></lucide-icon>
                  <h3>Preparing test...</h3>
                  <p>Connecting to your clip overlay</p>
                </div>
              }
              @case ('sending') {
                <div class="status-content">
                  <lucide-icon [name]="zapIcon" class="status-icon pulse-fast"></lucide-icon>
                  <h3>Sending Request...</h3>
                  <p>Triggering clip playback</p>
                </div>
              }
              @case ('playing') {
                <div class="status-content">
                  <div class="playing-animation">
                    <div class="wave"></div>
                    <div class="wave"></div>
                    <div class="wave"></div>
                  </div>
                  <h3>Now Playing!</h3>
                  <p>Your clip is currently being displayed</p>
                </div>
              }
              @case ('ended') {
                <div class="status-content">
                  <div class="success-check"></div>
                  <h3>Clip Finished!</h3>
                  <p>Test completed successfully</p>
                  <div class="action-row">
                    <button class="test-btn subtle" (click)="requestClose()">Close</button>
                    <button class="test-btn" (click)="startTest()">Test Again</button>
                  </div>
                </div>
              }
              @case ('error') {
                <div class="status-content error">
                  <lucide-icon [name]="zapIcon" class="status-icon"></lucide-icon>
                  <h3>Test couldn\'t start</h3>
                  <p>{{ errorMessage() }}</p>
                  <div class="action-row">
                    <button class="test-btn subtle" (click)="requestClose()">Close</button>
                    <button class="test-btn" (click)="startTest()">Try Again</button>
                  </div>
                </div>
              }
            }
          </div>
          
          <div class="progress-container">
            <div class="progress-bar" [style.width.%]="progress()"></div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: contents;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: transparent;
      backdrop-filter: none;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      z-index: 1000;
      pointer-events: none;
    }

    .modal-backdrop.mobile {
      background: transparent;
      backdrop-filter: none;
      padding: 1rem;
    }

    .modal-backdrop.closing {
      opacity: 0;
      transition: opacity 0.38s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .modal-container {
      position: relative;
      width: min(92vw, 600px);
      max-width: 600px;
      height: min(78vh, 500px);
      border-radius: 24px;
      overflow: hidden;
      animation: modal-enter 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 
        0 25px 50px -12px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(124, 58, 237, 0.3),
        0 0 100px rgba(124, 58, 237, 0.2);
      pointer-events: auto;
    }

    .modal-container.mobile {
      width: min(calc(100vw - 1.5rem), 540px);
      max-width: 540px;
      height: min(72vh, 520px);
      border-radius: 24px;
      box-shadow:
        0 20px 40px rgba(15, 23, 42, 0.35),
        0 0 0 1px rgba(124, 58, 237, 0.12);
      background: linear-gradient(180deg, rgba(12, 18, 34, 0.98), rgba(18, 28, 48, 0.98));
    }

    .modal-container.closing {
      opacity: 0;
      transform: scale(0.96) translateY(10px);
      transition: opacity 0.38s cubic-bezier(0.22, 1, 0.36, 1), transform 0.38s cubic-bezier(0.22, 1, 0.36, 1);
    }

    @keyframes modal-enter {
      from {
        opacity: 0;
        transform: scale(0.8) translateY(50px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .stage-3d {
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    }

    canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }

    .modal-content {
      position: relative;
      z-index: 10;
      height: 100%;
      display: flex;
      flex-direction: column;
      padding: 2rem;
    }

    .modal-container.mobile .modal-content {
      background:
        radial-gradient(circle at top right, rgba(124, 58, 237, 0.24), transparent 38%),
        linear-gradient(180deg, rgba(8, 14, 28, 0.86), rgba(18, 26, 44, 0.94));
      padding: 1.35rem 1rem 1rem;
    }

    .close-btn {
      position: absolute;
      top: 1rem;
      right: 1rem;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: rotate(90deg);
    }

    .close-icon {
      width: 20px;
      height: 20px;
      color: white;
    }

    .status-display {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .status-content {
      text-align: center;
      color: white;
      width: 100%;
      max-width: 420px;
    }

    .status-content h3 {
      font-size: 2rem;
      font-weight: 700;
      margin: 1rem 0 0.5rem;
      text-shadow: 0 2px 20px rgba(0, 0, 0, 0.5);
    }

    .status-content p {
      font-size: 1rem;
      opacity: 0.8;
      margin: 0;
    }

    .status-icon {
      width: 64px;
      height: 64px;
      color: #7c3aed;
    }

    .status-icon.pulse {
      animation: pulse-glow 2s ease-in-out infinite;
    }

    .status-icon.pulse-fast {
      animation: pulse-glow 0.5s ease-in-out infinite;
    }

    .status-icon.spin {
      animation: spin 1s linear infinite;
    }

    @keyframes pulse-glow {
      0%, 100% {
        transform: scale(1);
        filter: drop-shadow(0 0 20px rgba(124, 58, 237, 0.5));
      }
      50% {
        transform: scale(1.1);
        filter: drop-shadow(0 0 40px rgba(124, 58, 237, 0.8));
      }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .playing-animation {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      margin-bottom: 1rem;
    }

    .wave {
      width: 8px;
      height: 60px;
      background: linear-gradient(to top, #7c3aed, #a855f7);
      border-radius: 4px;
      animation: wave 1s ease-in-out infinite;
    }

    .wave:nth-child(2) { animation-delay: 0.1s; }
    .wave:nth-child(3) { animation-delay: 0.2s; }

    @keyframes wave {
      0%, 100% { transform: scaleY(0.3); }
      50% { transform: scaleY(1); }
    }

    .success-check {
      width: 80px;
      height: 80px;
      margin: 0 auto;
      border-radius: 50%;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      position: relative;
      animation: check-enter 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .success-check::after {
      content: '✓';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 40px;
      color: white;
      font-weight: bold;
    }

    @keyframes check-enter {
      from {
        transform: scale(0);
        opacity: 0;
      }
      to {
        transform: scale(1);
        opacity: 1;
      }
    }

    .test-btn {
      margin-top: 2rem;
      padding: 1rem 2.5rem;
      font-size: 1.1rem;
      font-weight: 600;
      color: white;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .test-btn.subtle {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: rgba(255, 255, 255, 0.92);
    }

    .test-btn.dramatic {
      background: transparent;
      border: 2px solid #7c3aed;
    }

    .btn-text {
      position: relative;
      z-index: 2;
    }

    .btn-glow {
      position: absolute;
      inset: -2px;
      background: linear-gradient(135deg, #7c3aed, #a855f7, #3b82f6);
      border-radius: 12px;
      opacity: 0;
      z-index: 1;
      transition: opacity 0.3s ease;
      filter: blur(10px);
    }

    .test-btn:hover .btn-glow {
      opacity: 0.5;
    }

    .test-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(124, 58, 237, 0.4);
    }

    .progress-container {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #7c3aed, #a855f7);
      transition: width 0.42s cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 0 0 20px rgba(124, 58, 237, 0.5);
    }

    .action-row {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
      margin-top: 1.5rem;
    }

    .status-content.error h3 {
      color: #ef4444;
    }

    @media (max-width: 768px) {
      .modal-container {
        width: min(calc(100vw - 1.5rem), 540px);
        height: min(72vh, 520px);
        max-width: 540px;
        border-radius: 24px;
      }

      .stage-3d {
        display: none;
      }

      .modal-content {
        padding: 1.35rem 1rem 1rem;
      }

      .close-btn {
        top: 0.85rem;
        right: 0.85rem;
      }

      .status-content h3 {
        font-size: 1.45rem;
      }

      .status-content p {
        font-size: 0.95rem;
      }

      .status-icon {
        width: 54px;
        height: 54px;
      }

      .success-check {
        width: 68px;
        height: 68px;
      }

      .success-check::after {
        font-size: 34px;
      }

      .test-btn {
        width: 100%;
        margin-top: 0;
        padding: 0.95rem 1rem;
        font-size: 1rem;
      }

      .action-row {
        flex-direction: column;
        gap: 0.65rem;
        margin-top: 1.25rem;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipTestModalComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly stage3d = viewChild<ElementRef>('stage3d');
  private readonly zone = inject(NgZone);
  private readonly clipsService = inject(ClipsService);
  readonly isMobile = typeof window !== 'undefined' ? window.innerWidth <= 768 : false;
  
  readonly channelID = input.required<string>();
  readonly streamer = input.required<string>();
  readonly design = input.required<ClipDesign>();
  readonly timeout = input<number>(30);
  readonly closed = output<void>();
  
  readonly testState = signal<TestState>('sending');
  readonly progress = signal<number>(12);
  readonly errorMessage = signal<string>('');
  readonly isClosing = signal(false);
  
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private particleSystem!: THREE.Points;
  private animationId!: number;
  private closeTimeoutId: number | null = null;
  private requestTimeoutId: number | null = null;
  private progressKickoffId: number | null = null;
  private readonly closeAnimationMs = 380;
  
  readonly closeIcon = X;
  readonly zapIcon = Zap;
  readonly loaderIcon = Loader2;

  ngOnInit(): void {
    queueMicrotask(() => this.startTest());
  }

  ngAfterViewInit(): void {
    if (!this.isMobile) {
      this.initThreeJS();
      if (this.scene && this.renderer) {
        this.createParticleSystem();
        this.animate();
      }
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
  }

  private initThreeJS(): void {
    const container = this.stage3d()?.nativeElement;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    this.camera.position.z = 30;

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
  }

  private createParticleSystem(): void {
    if (!this.scene) {
      return;
    }

    const particleCount = 200;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const color1 = new THREE.Color(0x7c3aed);
    const color2 = new THREE.Color(0xa855f7);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 50;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 50;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;

      const mixRatio = Math.random();
      const mixedColor = color1.clone().lerp(color2, mixRatio);
      colors[i * 3] = mixedColor.r;
      colors[i * 3 + 1] = mixedColor.g;
      colors[i * 3 + 2] = mixedColor.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });

    this.particleSystem = new THREE.Points(geometry, material);
    this.scene.add(this.particleSystem);
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    if (this.particleSystem) {
      this.particleSystem.rotation.y += 0.001;
      this.particleSystem.rotation.x += 0.0005;

      if (this.testState() === 'playing') {
        const pulse = 1 + Math.sin(Date.now() * 0.01) * 0.04;
        this.particleSystem.scale.setScalar(pulse);
      } else {
        this.particleSystem.scale.setScalar(1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  startTest(): void {
    this.clearTimers();
    this.isClosing.set(false);
    this.testState.set('sending');
    this.progress.set(14);
    this.errorMessage.set('');
    this.startProgressLeadIn();
    this.startRequestTimeout();
    
    try {
      const request: ClipTestRequest = {
        channelID: this.channelID(),
        streamer: this.streamer(),
        timeout: this.timeout()
      };

      this.clipsService.testClip(request).subscribe({
        next: (response: ClipTestResponse) => {
          if (response.error) {
            this.clearTimers();
            this.errorMessage.set(response.message);
            this.testState.set('error');
            this.progress.set(0);
          } else {
            this.finishSuccessSequence();
          }
        },
        error: (err: unknown) => {
          console.error('Test failed:', err);
          this.clearTimers();
          this.errorMessage.set('Failed to send test request');
          this.testState.set('error');
          this.progress.set(0);
        }
      });

    } catch (error) {
      console.error('Connection error:', error);
      this.clearTimers();
      this.errorMessage.set('Failed to connect to clip overlay');
      this.testState.set('error');
      this.progress.set(0);
    }
  }

  onBackdropClick(): void {
    this.requestClose();
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
          this.errorMessage.set('No response came back from the test request. Please try again.');
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
    this.scheduleCloseSequence(460);
  }

  private scheduleCloseSequence(waitBeforeClose = 320): void {
    this.clearCloseTimeout();
    this.closeTimeoutId = window.setTimeout(() => {
      this.requestClose();
    }, waitBeforeClose);
  }
}
