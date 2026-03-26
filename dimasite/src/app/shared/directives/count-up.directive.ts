import {
  Directive,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  inject
} from '@angular/core';

@Directive({
  selector: '[countUp]'
})
export class CountUpDirective implements OnInit, OnChanges, OnDestroy {
  @Input() countUp = 0;
  @Input() duration = 2500;
  @Input() minDuration = 800;
  @Input() staggerDelay = 0;

  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private observer: IntersectionObserver | null = null;
  private frameId = 0;
  private hasEnteredViewport = false;
  private current = 0;
  private animationStartTime = 0;
  private animationStartValue = 0;
  private animationTarget = 0;

  ngOnInit(): void {
    this.elementRef.nativeElement.textContent = '0';
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || this.hasEnteredViewport) {
            return;
          }

          this.hasEnteredViewport = true;
          this.animateTo(this.countUp);
          this.observer?.disconnect();
        });
      },
      { threshold: 0.15 }
    );

    this.observer.observe(this.elementRef.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.hasEnteredViewport || !changes['countUp'] || changes['countUp'].firstChange) {
      return;
    }

    const newTarget = this.countUp;
    
    if (this.frameId) {
      const now = performance.now();
      const elapsed = now - this.animationStartTime;
      const originalProgress = Math.min(elapsed / this.duration, 1);
      
      if (originalProgress < 0.5) {
        this.animateTo(newTarget, this.current);
      } else {
        this.animateTo(newTarget);
      }
    } else {
      this.animateTo(newTarget);
    }
  }

  ngOnDestroy(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
    }
    this.observer?.disconnect();
  }

  private animateTo(target: number, fromValue?: number): void {
    this.animationStartValue = fromValue ?? this.current;
    this.animationTarget = target;
    
    const distance = Math.abs(target - this.animationStartValue);
    const adjustedDuration = Math.max(
      this.minDuration,
      Math.min(this.duration, this.duration * (distance / 100))
    );

    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
    }

    const startAnimation = () => {
      this.animationStartTime = performance.now();

      const animate = (now: number) => {
        const elapsed = now - this.animationStartTime;
        const progress = Math.min(elapsed / adjustedDuration, 1);
        // easeOutCubic for smoother, more cinematic feel
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = Math.floor(this.animationStartValue + (target - this.animationStartValue) * eased);

        if (value !== this.current) {
          this.current = value;
          this.elementRef.nativeElement.textContent = value.toLocaleString();
        }

        if (progress < 1) {
          this.frameId = requestAnimationFrame(animate);
        } else {
          this.frameId = 0;
          if (this.current !== target) {
            this.current = target;
            this.elementRef.nativeElement.textContent = target.toLocaleString();
          }
        }
      };

      this.frameId = requestAnimationFrame(animate);
    };

    // Apply stagger delay if specified
    if (this.staggerDelay > 0) {
      setTimeout(startAnimation, this.staggerDelay);
    } else {
      startAnimation();
    }
  }
}
