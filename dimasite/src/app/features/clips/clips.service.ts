import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';
import { LinksService } from '../../services/links.service';
import type { 
  ClipDesign, 
  ClipTestRequest, 
  ClipTestResponse,
  UserClipSettings,
  PlanTier
} from './clips.model';

@Injectable({
  providedIn: 'root'
})
export class ClipsService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getClipUrl(channelID: string, designId: string, timeout: number): string {
    const baseUrl = this.linksService.getApiUrl();
    const designParam = designId !== '1' ? `?design=${designId}` : '';
    const separator = designParam ? '&' : '?';
    return `${baseUrl}/clip/${channelID}${designParam}${separator}timeout=${timeout}`;
  }

  testClip(request: ClipTestRequest): Observable<ClipTestResponse> {
    const url = `${this.linksService.getApiUrl()}/clip/test`;
    return this.http.post<ClipTestResponse>(url, request).pipe(
      catchError((error) => {
        console.error('Error testing clip:', error);
        return of({
          error: true,
          message: error.error?.message || 'Failed to test clip',
          status: error.status || 500
        });
      })
    );
  }

  getDesigns(userSettings: UserClipSettings): ClipDesign[] {
    const { channelID, planTier } = userSettings;
    const baseUrl = this.linksService.getApiUrl();

    const designs: ClipDesign[] = [
      {
        id: '1',
        name: 'Classic',
        description: 'Split 400/400 with seam avatar and streamer-color panel. The original Design 1, now with a clean exit.',
        previewUrl: `${baseUrl}/clip/${channelID}`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 1,
        premium: false,
        premiumPlus: false,
        status: 'stable' as const,
        features: ['Split-screen layout', 'Seam avatar', 'Streamer color panel', '1.5s ease in/out'],
        accentColor: '#7c3aed'
      },
      {
        id: 'third',
        name: 'Third',
        description: 'Broadcast lower-third. Video fades up, then a bar slides in with game, name, and line.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=third`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 2,
        premium: false,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Lower-third bar', 'Full-bleed video', 'Accent top edge', 'Beta v1'],
        accentColor: '#7c3aed'
      },
      {
        id: 'tile',
        name: 'Tile',
        description: 'Live First card. Video tile plus a readable info card. Streamer color is an accent bar only.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=tile`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 3,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Bento card', 'Accent bar', 'Staggered enter', 'Beta v1'],
        accentColor: '#8b5cf6'
      },
      {
        id: 'cinema',
        name: 'Cinema',
        description: 'Full-bleed clip with a rising glass strip for name and line.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=cinema`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 4,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Full-bleed video', 'Bottom scrim', 'Compact meta', 'Beta v1'],
        accentColor: '#eab308'
      },
      {
        id: 'orbit',
        name: 'Orbit',
        description: 'Avatar-forward. Pulse ring scales in, then video and type follow.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=orbit`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 5,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Pulse avatar', 'Compact video', 'Stacked type', 'Beta v1'],
        accentColor: '#22c55e'
      },
      {
        id: 'pill',
        name: 'Pill',
        description: 'Floating capsule over full video. Capsule slides in after the picture.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=pill`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 6,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Full video', 'Capsule chip', 'Minimal chrome', 'Beta v1'],
        accentColor: '#22d3ee'
      },
      {
        id: 'hud',
        name: 'HUD',
        description: 'Corner chips only. Game, name, and title stagger in around the clip.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=hud`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 7,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Corner chips', 'Staggered HUD', 'Low clutter', 'Beta v1'],
        accentColor: '#3b82f6'
      },
      {
        id: 'slash',
        name: 'Slash',
        description: 'Diagonal reveal. Video wipes open, type sits in the cut, avatar on the seam.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=slash`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 8,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Diagonal wipe', 'Accent panel', 'Seam avatar', 'Beta v1'],
        accentColor: '#ec4899'
      }
    ];

    return designs.map(design => ({
      ...design,
      isLocked: this.isDesignLocked(design, planTier)
    }));
  }

  isDesignLocked(design: ClipDesign, userPlanTier: PlanTier): boolean {
    if (!design.premium && !design.premiumPlus) return false;
    if (design.premiumPlus && userPlanTier !== 'pro') return true;
    if (design.premium && userPlanTier === 'free') return true;
    return false;
  }

  getWebSocketUrl(channelID: string): string {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = this.linksService.getApiUrl().replace(/^https?:\/\//, '');
    return `${wsProtocol}//${wsHost}/clip/${channelID}`;
  }
}
