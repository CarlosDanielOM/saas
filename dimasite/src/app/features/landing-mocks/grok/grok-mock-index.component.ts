import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface GrokMockCard {
  id: string;
  title: string;
  description: string;
  vibe: string;
  accent: string;
}

interface GrokMockSection {
  title: string;
  note: string;
  mocks: GrokMockCard[];
}

@Component({
  selector: 'app-grok-mock-index',
  imports: [RouterLink],
  templateUrl: './grok-mock-index.component.html',
  styleUrl: './grok-mock-index.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokMockIndexComponent {
  readonly originals: GrokMockCard[] = [
    {
      id: '1',
      title: 'Split Studio',
      description:
        'Asymmetric product layout. Hero copy on the left, a live ops panel on the right.',
      vibe: 'Product',
      accent: 'violet'
    },
    {
      id: '2',
      title: 'Night Signal',
      description:
        'Cinematic dark stage. Oversized type, neon accents, marquee platform stats.',
      vibe: 'Cinematic',
      accent: 'cyan'
    },
    {
      id: '3',
      title: 'Warm Desk',
      description:
        'Soft creator-friendly SaaS. Paper tones, rounded cards, approachable pricing.',
      vibe: 'Friendly',
      accent: 'coral'
    }
  ];

  readonly opencodeMocks: GrokMockCard[] = [
    {
      id: 'oc1',
      title: 'Broadcast Brutal',
      description:
        'Kinetic brutalism. Acid yellow marquee, hard borders, flood-on-hover feature slabs.',
      vibe: 'Brutal',
      accent: 'cyan'
    },
    {
      id: 'oc2',
      title: 'Editorial Void',
      description:
        'Exaggerated minimal OLED. Giant serif display type, single violet accent, quiet metrics.',
      vibe: 'Editorial',
      accent: 'violet'
    },
    {
      id: 'oc3',
      title: 'Command Bento',
      description:
        'Apple-style modular bento. Hero + live KPI tiles, soft surfaces, plan cards in grid.',
      vibe: 'Bento',
      accent: 'coral'
    }
  ];

  readonly sections: GrokMockSection[] = [
    {
      title: 'From Mock 18 · Global Metrics',
      note: 'Calm dark product DNA with platform KPIs. Three creative riffs — board, ledger, focus strip.',
      mocks: [
        {
          id: '18a',
          title: 'Pulse Board',
          description:
            'KPI board as the hero. Amber live pulse, dense metric cells, same quiet product chrome.',
          vibe: 'Board',
          accent: 'violet'
        },
        {
          id: '18b',
          title: 'Quiet Ledger',
          description:
            'Accounting-grade light surface. Monospace books, ledger panel, open entries table.',
          vibe: 'Ledger',
          accent: 'coral'
        },
        {
          id: '18c',
          title: 'Focus Strip',
          description:
            'Centered calm headline with a full-width metrics strip. Horizontal feature list.',
          vibe: 'Focus',
          accent: 'cyan'
        }
      ]
    },
    {
      title: 'From Mock 20 · Aurora Stream',
      note: 'Glass + aurora mesh DNA. Three riffs — dusk tide, horizon band, warm bloom panels.',
      mocks: [
        {
          id: '20a',
          title: 'Tide Glass',
          description:
            'Aurora inverted to night. Deep dusk glass cards, cyan/magenta mesh, after-dark calm.',
          vibe: 'Dusk',
          accent: 'cyan'
        },
        {
          id: '20b',
          title: 'Soft Horizon',
          description:
            'Centered hero under a horizontal aurora band. Floating metric chips, soft pills.',
          vibe: 'Horizon',
          accent: 'violet'
        },
        {
          id: '20c',
          title: 'Bloom Panel',
          description:
            'Peach/rose floral aurora. Stacked glass panels, warm creator energy.',
          vibe: 'Bloom',
          accent: 'coral'
        }
      ]
    },
    {
      title: 'From Mock 23 · Constellation',
      note: 'Space network DNA. Three riffs — orbital rings, observatory catalog, nebula core.',
      mocks: [
        {
          id: '23a',
          title: 'Orbit Rings',
          description:
            'Concentric orbital rings and satellites instead of a mesh graph. Caption card intact.',
          vibe: 'Orbit',
          accent: 'violet'
        },
        {
          id: '23b',
          title: 'Deep Catalog',
          description:
            'Observatory ledger. Star log is the hero; platform metrics as a catalog header.',
          vibe: 'Catalog',
          accent: 'cyan'
        },
        {
          id: '23c',
          title: 'Nebula Core',
          description:
            'Dense glowing core with radial nodes. Pink nebula clouds and shell pricing.',
          vibe: 'Nebula',
          accent: 'coral'
        }
      ]
    }
  ];
}
