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
        name: 'Classic Design',
        description: 'Split-screen elegance with streamer info displayed alongside your clips. Perfect for showcasing both content and personality.',
        previewUrl: `${baseUrl}/clip/${channelID}`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 1,
        premium: false,
        premiumPlus: false,
        status: 'stable' as const,
        features: ['Split-screen layout', 'Streamer profile integration', 'Dynamic color theming', 'Smooth slide animations'],
        accentColor: '#7c3aed'
      },
      {
        id: '2',
        name: 'Simple Design',
        description: 'Clean and minimal. Full-screen clips with subtle overlay information for an immersive viewing experience.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=2`,
        thumbnailUrl: '/assets/clips/design-2-thumb.jpg',
        designNumber: 2,
        premium: false,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['Full-screen video', 'Minimal overlay', 'Bottom info bar', 'Cinematic feel'],
        accentColor: '#3b82f6'
      },
      {
        id: '3',
        name: 'Cinematic Design',
        description: 'Premium fullscreen experience with glassmorphism effects and dramatic transitions. For streamers who want to impress.',
        previewUrl: `${baseUrl}/clip/${channelID}?design=3`,
        thumbnailUrl: '/assets/clips/design-3-thumb.jpg',
        designNumber: 3,
        premium: true,
        premiumPlus: false,
        status: 'stable' as const,
        features: ['Glassmorphism overlays', 'Backdrop blur effects', 'Premium animations', 'Dark aesthetic'],
        accentColor: '#eab308'
      }
    ];

    return designs.map(design => ({
      ...design,
      isLocked: this.isDesignLocked(design, planTier)
    }));
  }

  private isDesignLocked(design: ClipDesign, userPlanTier: PlanTier): boolean {
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
