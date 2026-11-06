import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';
import { LanguageService } from '../../services/language.service';
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
  private readonly language = inject(LanguageService);

  getClipUrl(channelID: string, designId: string, timeout: number): string {
    const baseUrl = this.linksService.getApiUrl();
    const designParam = designId !== '1' ? `?design=${designId}` : '';
    const separator = designParam ? '&' : '?';
    return `${baseUrl}/clip/${channelID}${designParam}${separator}timeout=${timeout}`;
  }

  testClip(request: ClipTestRequest): Observable<ClipTestResponse> {
    const url = `${this.linksService.getApiUrl()}/clip/test`;
    return this.http.post<ClipTestResponse>(url, request).pipe(
      catchError((error: HttpErrorResponse) => {
        return of({
          error: true,
          message: error.error?.message || this.language.translate('clips.test.errorFallback'),
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
        description: 'clips.designCopy.description1',
        previewUrl: `${baseUrl}/clip/${channelID}`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 1,
        variant: 'classic' as const,
        premium: false,
        premiumPlus: false,
        status: 'stable' as const,
        features: ['clips.designCopy.feature1', 'clips.designCopy.feature2', 'clips.designCopy.feature3', 'clips.designCopy.feature4'],
        accentColor: '#7c3aed'
      },
      {
        id: 'third',
        name: 'Third',
        description: 'clips.designCopy.description2',
        previewUrl: `${baseUrl}/clip/${channelID}?design=third`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 2,
        variant: 'third' as const,
        premium: false,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature5', 'clips.designCopy.feature6', 'clips.designCopy.feature7', 'clips.designCopy.feature8'],
        accentColor: '#7c3aed'
      },
      {
        id: 'tile',
        name: 'Tile',
        description: 'clips.designCopy.description3',
        previewUrl: `${baseUrl}/clip/${channelID}?design=tile`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 3,
        variant: 'tile' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature9', 'clips.designCopy.feature10', 'clips.designCopy.feature11', 'clips.designCopy.feature8'],
        accentColor: '#8b5cf6'
      },
      {
        id: 'cinema',
        name: 'Cinema',
        description: 'clips.designCopy.description4',
        previewUrl: `${baseUrl}/clip/${channelID}?design=cinema`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 4,
        variant: 'cinema' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature6', 'clips.designCopy.feature12', 'clips.designCopy.feature13', 'clips.designCopy.feature8'],
        accentColor: '#eab308'
      },
      {
        id: 'orbit',
        name: 'Orbit',
        description: 'clips.designCopy.description5',
        previewUrl: `${baseUrl}/clip/${channelID}?design=orbit`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 5,
        variant: 'orbit' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature14', 'clips.designCopy.feature15', 'clips.designCopy.feature16', 'clips.designCopy.feature8'],
        accentColor: '#22c55e'
      },
      {
        id: 'pill',
        name: 'Pill',
        description: 'clips.designCopy.description6',
        previewUrl: `${baseUrl}/clip/${channelID}?design=pill`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 6,
        variant: 'pill' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature17', 'clips.designCopy.feature18', 'clips.designCopy.feature19', 'clips.designCopy.feature8'],
        accentColor: '#22d3ee'
      },
      {
        id: 'hud',
        name: 'HUD',
        description: 'clips.designCopy.description7',
        previewUrl: `${baseUrl}/clip/${channelID}?design=hud`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 7,
        variant: 'hud' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature20', 'clips.designCopy.feature21', 'clips.designCopy.feature22', 'clips.designCopy.feature8'],
        accentColor: '#3b82f6'
      },
      {
        id: 'slash',
        name: 'Slash',
        description: 'clips.designCopy.description8',
        previewUrl: `${baseUrl}/clip/${channelID}?design=slash`,
        thumbnailUrl: '/assets/clips/design-1-thumb.jpg',
        designNumber: 8,
        variant: 'slash' as const,
        premium: true,
        premiumPlus: false,
        status: 'beta' as const,
        features: ['clips.designCopy.feature23', 'clips.designCopy.feature24', 'clips.designCopy.feature2', 'clips.designCopy.feature8'],
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
