import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface GrokMockCard {
  id: string;
  title: string;
  description: string;
  vibe: string;
  accent: string;
}

@Component({
  selector: 'app-grok-mock-index',
  imports: [RouterLink],
  templateUrl: './grok-mock-index.component.html',
  styleUrl: './grok-mock-index.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokMockIndexComponent {
  readonly mocks: GrokMockCard[] = [
    {
      id: '1',
      title: 'Split Studio',
      description:
        'Asymmetric product layout. Hero copy on the left, a live ops panel on the right. Clean light surfaces with violet brand energy.',
      vibe: 'Product',
      accent: 'violet'
    },
    {
      id: '2',
      title: 'Night Signal',
      description:
        'Cinematic dark stage. Oversized type, neon accents, marquee platform stats, and an on-air live strip.',
      vibe: 'Cinematic',
      accent: 'cyan'
    },
    {
      id: '3',
      title: 'Warm Desk',
      description:
        'Soft creator-friendly SaaS. Paper tones, rounded cards, gentle motion, and approachable pricing.',
      vibe: 'Friendly',
      accent: 'coral'
    }
  ];
}
