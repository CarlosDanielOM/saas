import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { CountUpDirective } from './count-up.directive';

class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];

  disconnect(): void {}
  observe(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}

@Component({
  imports: [CountUpDirective],
  template: '<span [countUp]="value">0</span>'
})
class CountUpHostComponent {
  value = 24;
}

describe('CountUpDirective', () => {
  beforeEach(() => {
    globalThis.IntersectionObserver = MockIntersectionObserver;
  });

  it('keeps a nonzero initial value visible before entering the viewport', async () => {
    await TestBed.configureTestingModule({
      imports: [CountUpHostComponent]
    }).compileComponents();

    const fixture = TestBed.createComponent(CountUpHostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('span')?.textContent).toBe('24');
  });
});
