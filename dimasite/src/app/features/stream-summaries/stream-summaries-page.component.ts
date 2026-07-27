import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { StreamSummary } from '../../models/stream-summary.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { StreamSummaryApiService } from '../../services/stream-summary-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

const MOCK_SUMMARIES: StreamSummary[] = [
  {
    _id: 'mock-session-1',
    channelID: 'mock-channel',
    channel: 'streamer',
    stream_session_id: 'mock-session-id-1',
    stream_id: 'mock-stream-id-1',
    started_at: new Date(Date.now() - 24 * 60 * 60 * 1000 - 3 * 60 * 60 * 1000).toISOString(),
    ended_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    duration_minutes: 180,
    average_viewers: 128,
    peak_viewers: 245,
    follows: 15,
    subs: 8,
    bits: 1500,
    donations: 50.0,
    headline: 'Completed Minecraft in under 30 minutes!',
    recap:
      'The streamer spent the first 10 minutes gathering resources in the Nether, then successfully located the Stronghold at 20 minutes. After a tense fight with the Ender Dragon, they finished the run at 28:45, achieving a new speedrun personal best. Chat was extremely hype and cheered with bits.',
    highlights: [
      'Gathered 12 ender pearls in record time',
      'Defeated Ender Dragon with bed method',
      'New personal best speedrun achieved'
    ],
    chat_messages_sampled: 420,
    snapshot_count: 36,
    proposed_actions: [
      {
        action: 'create',
        type: 'fact',
        summary: 'Minecraft speedrun PB is 28 minutes and 45 seconds',
        reason: 'Streamer set a new speedrun personal best during the stream.',
        evidence: ['Defeated dragon at 28:45'],
        confidence: 0.95,
        risk: 'low'
      }
    ],
    applied_actions: [
      {
        action: 'create',
        status: 'applied',
        reason: 'Added to chatbot facts database'
      }
    ],
    totals: { proposed: 1, applied: 1, skipped: 0, failed: 0 },
    status: 'applied',
    error_message: '',
    source: 'stream_offline',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    _id: 'mock-session-2',
    channelID: 'mock-channel',
    channel: 'streamer',
    stream_session_id: 'mock-session-id-2',
    stream_id: 'mock-stream-id-2',
    started_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000).toISOString(),
    ended_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    duration_minutes: 120,
    average_viewers: 95,
    peak_viewers: 150,
    follows: 5,
    subs: 3,
    bits: 500,
    donations: 0.0,
    headline: 'Discussing AI bot upgrades and testing voice configurations',
    recap:
      'Streamer showed viewers the new glassmorphic UI designs. Chat was very active testing the new xAI rex voice commands. The streamer also talked about target plans for the next week and requested feedback on features.',
    highlights: [
      'Showcased new TTS page design',
      'Tested the Rex voice live in chat',
      'Discussed weekly sub goal targets'
    ],
    chat_messages_sampled: 250,
    snapshot_count: 24,
    proposed_actions: [
      {
        action: 'create',
        type: 'preference',
        summary: 'Streamer prefers using xAI Rex voice for alerts',
        reason: 'Streamer explicitly stated they like the Rex voice during testing.',
        evidence: ['Said "Rex voice is amazing, let\'s keep it"'],
        confidence: 0.92,
        risk: 'low'
      }
    ],
    applied_actions: [
      {
        action: 'create',
        status: 'applied',
        reason: 'Saved preference'
      }
    ],
    totals: { proposed: 1, applied: 1, skipped: 0, failed: 0 },
    status: 'applied',
    error_message: '',
    source: 'stream_offline',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    _id: 'mock-session-3',
    channelID: 'mock-channel',
    channel: 'streamer',
    stream_session_id: 'mock-session-id-3',
    stream_id: 'mock-stream-id-3',
    started_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 2.5 * 60 * 60 * 1000).toISOString(),
    ended_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    duration_minutes: 150,
    average_viewers: 82,
    peak_viewers: 110,
    follows: 2,
    subs: 1,
    bits: 200,
    donations: 5.0,
    headline: 'Playing classic Donkey Kong Country on SNES',
    recap:
      'A fun nostalgia trip playing SNES classics. Viewers redeemed several triggers causing custom overlay alerts. Streamer struggled a bit in the minecart levels but completed World 1 successfully.',
    highlights: [
      'Completed World 1 without losing a life',
      'Viewer triggers triggered the monkey screech alert multiple times',
      'Nostalgic game discussion in chat'
    ],
    chat_messages_sampled: 180,
    snapshot_count: 30,
    proposed_actions: [],
    applied_actions: [],
    totals: { proposed: 0, applied: 0, skipped: 0, failed: 0 },
    status: 'noop',
    error_message: '',
    source: 'stream_offline',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

@Component({
  selector: 'app-stream-summaries-page',
  imports: [RouterLink, DecimalPipe],
  templateUrl: './stream-summaries-page.component.html',
  styleUrl: './stream-summaries-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StreamSummariesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly summariesApi = inject(StreamSummaryApiService);

  readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({ streamer, channelID: null, status: 'idle' });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const })),
        startWith({ streamer, channelID: null, status: 'loading' as const })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });

  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });

  readonly channelID = computed(() => this.channelResolution().channelID);
  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });

  readonly planTier = computed(() => {
    const tier = this.sessionAuth.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') return tier;
    return 'free';
  });

  readonly summaries = signal<StreamSummary[]>([]);
  readonly totalCount = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = signal(10);
  readonly isLoading = signal(false);
  readonly selectedSummary = signal<StreamSummary | null>(null);
  readonly detailTab = signal<'recap' | 'memories'>('recap');
  readonly isUsingMockData = signal(false);
  readonly showDetailOnMobile = signal(false);

  readonly hasSummaries = computed(() => this.summaries().length > 0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalCount() / this.pageSize()) || 1));

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();
      const page = this.currentPage();
      const limit = this.pageSize();

      if (resolution.status === 'resolved' && resolution.channelID) {
        void this.loadSummaries(resolution.channelID, page, limit);
      }
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  formatDate(dateString: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  confidencePercent(value: number): number {
    return Math.trunc(value * 100);
  }

  selectSummary(summary: StreamSummary): void {
    this.selectedSummary.set(summary);
    this.detailTab.set('recap');
    this.showDetailOnMobile.set(true);
  }

  closeDetailMobile(): void {
    this.showDetailOnMobile.set(false);
  }

  changePage(newPage: number): void {
    if (newPage < 1 || newPage > this.totalPages()) return;
    this.currentPage.set(newPage);
  }

  private async loadSummaries(channelID: string, page: number, limit: number): Promise<void> {
    this.isLoading.set(true);
    const skip = (page - 1) * limit;

    try {
      const result = await firstValueFrom(this.summariesApi.getSummaries(channelID, limit, skip));
      if (result.items && result.items.length > 0) {
        this.summaries.set(result.items);
        this.totalCount.set(result.total);
        this.isUsingMockData.set(false);

        const selected = this.selectedSummary();
        const stillVisible = selected && result.items.some((item) => item._id === selected._id);
        if (!stillVisible) {
          this.selectedSummary.set(result.items[0] ?? null);
        }
      } else {
        this.loadMockData();
      }
    } catch {
      this.loadMockData();
    } finally {
      this.isLoading.set(false);
    }
  }

  private loadMockData(): void {
    this.summaries.set(MOCK_SUMMARIES);
    this.totalCount.set(MOCK_SUMMARIES.length);
    this.isUsingMockData.set(true);

    if (!this.selectedSummary() && MOCK_SUMMARIES[0]) {
      this.selectedSummary.set(MOCK_SUMMARIES[0]);
    }
  }
}
