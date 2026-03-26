# Loading Indicator Component

A beautiful, adaptive loading component with Three.js animations and automatic device capability detection.

## Features

- **Three Unique Animations**: Neural Lattice, Floating Crystals, and Geometric Fractals (randomly selected)
- **Smart Fallback**: Automatically uses CSS animations on low-end devices
- **Device Adaptive**: Detects WebGL support, battery status, and motion preferences
- **Size Variants**: `sm`, `md`, `lg`, `fullscreen`
- **Progress Support**: Optional progress bar (0-100%)
- **No Jitter**: Optimized animation loops with frame rate limiting
- **i18n Ready**: Automatic translation of loading messages

## Installation

The component is already available in the codebase. Import it where needed:

```typescript
import { LoadingIndicatorComponent } from '../components/loading';

@Component({
  imports: [LoadingIndicatorComponent, ...],
  ...
})
```

## Basic Usage

### Fullscreen Page Loading (Dashboard)
```html
<loading-indicator
  [loading]="isLoading()"
  size="fullscreen"
  message="common.loading_dashboard"
  [showProgress]="true"
  [progress]="loadingProgress()" />
```

### Inline Component Loading (Commands Table)
```html
<div class="commands-table-container">
  @if (isLoading()) {
    <loading-indicator
      [loading]="true"
      size="md"
      message="common.loading_commands" />
  } @else {
    <table>...your table...</table>
  }
</div>
```

### Card-Level Loading (Module Card)
```html
<div class="module-card">
  @if (moduleLoading()) {
    <loading-indicator
      [loading]="true"
      size="sm"
      centered="true" />
  } @else {
    <div class="module-content">...content...</div>
  }
</div>
```

### Force Specific Animation Type
```html
<!-- Always show crystals animation -->
<loading-indicator
  [loading]="isLoading()"
  animationType="crystals"
  size="lg" />

<!-- Random animation each time (default) -->
<loading-indicator
  [loading]="isLoading()"
  animationType="random"
  size="fullscreen" />
```

## Props Reference

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `loading` | `boolean` | **required** | Controls visibility |
| `variant` | `'auto' \| 'css' \| 'three'` | `'auto'` | Animation type |
| `size` | `'sm' \| 'md' \| 'lg' \| 'fullscreen'` | `'md'` | Component size |
| `message` | `string` | `''` | Translation key for message |
| `showProgress` | `boolean` | `false` | Show progress bar |
| `progress` | `number` | `0` | Progress 0-100 |
| `centered` | `boolean` | `true` | Center in container |
| `animationType` | `'lattice' \| 'crystals' \| 'fractals' \| 'random'` | `'random'` | Force specific animation |

## Animation Types

The component randomly selects from three unique Three.js animations:

1. **Neural Lattice**: Network of connected nodes with energy pulses
2. **Floating Crystals**: Rotating translucent crystals with color shifts
3. **Geometric Fractals**: Recursive branching structures with glowing joints

## Device Adaptation

The component automatically adapts based on device capabilities:

### High Tier (WebGL2, 8+ cores, 8GB+ RAM)
- Full Three.js animation
- 60fps animation loop
- Maximum particles/effects
- Antialiasing enabled

### Medium Tier (WebGL, 4-8 cores)
- Reduced particle count
- 30fps animation loop
- Simplified geometry
- No post-processing

### Low Tier / Battery Saving / Reduced Motion
- Pure CSS animations
- No WebGL overhead
- GPU-accelerated transforms
- Single rotating ring

## Examples by Use Case

### Dashboard Initial Load
```typescript
// In dashboard.component.ts
readonly isLoading = signal(true);
readonly loadingProgress = signal(0);

ngOnInit() {
  this.loadDashboardData();
}

private async loadDashboardData() {
  this.isLoading.set(true);
  
  // Simulate progress
  const progressInterval = setInterval(() => {
    this.loadingProgress.update(p => Math.min(90, p + 10));
  }, 200);
  
  await this.fetchData();
  
  clearInterval(progressInterval);
  this.loadingProgress.set(100);
  
  setTimeout(() => {
    this.isLoading.set(false);
  }, 300);
}
```

```html
<!-- In dashboard.component.html -->
@if (isLoading()) {
  <loading-indicator
    [loading]="true"
    size="fullscreen"
    message="dashboard.loading"
    [showProgress]="true"
    [progress]="loadingProgress()" />
} @else {
  <dashboard-content />
}
```

### Commands Page with Table Refresh
```typescript
// In commands-page.component.ts
readonly isRefreshing = signal(false);

async refreshCommands() {
  this.isRefreshing.set(true);
  await this.loadCommands();
  this.isRefreshing.set(false);
}
```

```html
<!-- Inline over the table -->
<div class="table-wrapper">
  @if (isRefreshing()) {
    <div class="table-overlay">
      <loading-indicator
        [loading]="true"
        size="lg"
        message="commands.refreshing" />
    </div>
  }
  
  <table class="commands-table">...</table>
</div>
```

### Module Toggle Loading
```html
<button (click)="toggleModule()" [disabled]="moduleLoading()">
  @if (moduleLoading()) {
    <loading-indicator
      [loading]="true"
      size="sm"
      variant="css" />
  } @else {
    Toggle Module
  }
</button>
```

## CSS Customization

The component uses BEM-style CSS classes:

```css
/* Fullscreen overlay background */
.loading-indicator--fullscreen {
  background: rgba(0, 0, 0, 0.8);
}

/* Custom progress bar colors */
.loading-indicator__progress-bar {
  background: linear-gradient(90deg, #your-color-1, #your-color-2);
}

/* Size overrides */
.loading-indicator[data-size="lg"] .loading-indicator__content {
  width: 300px;
  height: 300px;
}
```

## Performance Tips

1. **Use `variant="css"`** for buttons and small UI elements
2. **Always cleanup**: Component auto-cleans on destroy, but set `[loading]="false"` when done
3. **Prefer signals**: Use Angular signals for loading state (better change detection)
4. **Fullscreen only when needed**: Use inline loaders for partial content updates
5. **Progress accuracy**: Update progress smoothly to prevent jarring jumps

## Accessibility

- Respects `prefers-reduced-motion` media query
- Loading message is announced to screen readers
- Focus is managed when fullscreen overlay appears
- Color contrast meets WCAG AA standards
