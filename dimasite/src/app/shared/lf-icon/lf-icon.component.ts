import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Eye,
  FlaskConical,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Lock,
  LucideAngularModule,
  Music,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Star,
  Timer,
  Users,
  Wrench,
  X,
  Zap,
  type LucideIconData
} from 'lucide-angular';

export type LfIconName =
  | 'close'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'preview'
  | 'grid'
  | 'list'
  | 'lock'
  | 'star'
  | 'audio'
  | 'image'
  | 'video'
  | 'zap'
  | 'check'
  | 'timer'
  | 'settings'
  | 'plus'
  | 'wrench'
  | 'flask'
  | 'users'
  | 'sort-asc'
  | 'sort-desc'
  | 'sort';

const ICONS: Record<LfIconName, LucideIconData> = {
  close: X,
  back: ArrowLeft,
  forward: ArrowRight,
  refresh: RefreshCw,
  preview: Eye,
  grid: LayoutGrid,
  list: List,
  lock: Lock,
  star: Star,
  audio: Music,
  image: ImageIcon,
  video: Play,
  zap: Zap,
  check: Check,
  timer: Timer,
  settings: Settings,
  plus: Plus,
  wrench: Wrench,
  flask: FlaskConical,
  users: Users,
  'sort-asc': ArrowUp,
  'sort-desc': ArrowDown,
  sort: ChevronsUpDown
};

/** Shared inline Lucide icon with a stable, centered pixel box. */
@Component({
  selector: 'app-lf-icon',
  imports: [LucideAngularModule],
  template: `<lucide-icon class="lf-icon" [name]="icon()" [size]="size()"></lucide-icon>`,
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()'
  },
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        line-height: 0;
        vertical-align: middle;
      }

      lucide-icon {
        display: flex;
        width: 100%;
        height: 100%;
        line-height: 0;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LfIconComponent {
  readonly name = input.required<LfIconName>();
  readonly size = input(16);
  readonly icon = computed(() => ICONS[this.name()] ?? X);
}
