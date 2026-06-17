import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, Observable } from 'rxjs';

import { LinksService } from '../../services/links.service';
import {
  ApiEnvelope,
  ChannelExtensionItem,
  CreateChannelExtensionItemRequest,
  DimafxItemsResponse,
  UpdateChannelExtensionItemRequest
} from './dimafx.model';

@Injectable({ providedIn: 'root' })
export class DimafxService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getItems(channelId: string): Observable<DimafxItemsResponse> {
    return this.http
      .get<ApiEnvelope<ChannelExtensionItem[]>>(`${this.linksService.getApiUrl()}/extensions/dimafx/${channelId}/items`)
      .pipe(
        map((response) => ({
          items: (response.data || []).map((item) => this.normalizeItem(item)),
          allowedBitPrices: (response.meta?.['allowedBitPrices'] as number[] | undefined) || [5, 10, 25, 50, 100]
        }))
      );
  }

  createItem(channelId: string, request: CreateChannelExtensionItemRequest): Observable<ChannelExtensionItem> {
    return this.http
      .post<ApiEnvelope<ChannelExtensionItem>>(`${this.linksService.getApiUrl()}/extensions/dimafx/${channelId}/items`, request)
      .pipe(map((response) => this.requireItem(response, 'Failed to create DimaFX item')));
  }

  updateItem(channelId: string, itemId: string, request: UpdateChannelExtensionItemRequest): Observable<ChannelExtensionItem> {
    return this.http
      .patch<ApiEnvelope<ChannelExtensionItem>>(`${this.linksService.getApiUrl()}/extensions/dimafx/${channelId}/items/${itemId}`, request)
      .pipe(map((response) => this.requireItem(response, 'Failed to update DimaFX item')));
  }

  deleteItem(channelId: string, itemId: string, refundSaved = false): Observable<void> {
    return this.http
      .delete<ApiEnvelope<{ id: string }>>(`${this.linksService.getApiUrl()}/extensions/dimafx/${channelId}/items/${itemId}`, {
        params: refundSaved ? { refundSaved: 'true' } : undefined
      })
      .pipe(
        map((response) => {
          if (response.error) throw new Error(response.message || 'Failed to delete DimaFX item');
        })
      );
  }

  private requireItem(response: ApiEnvelope<ChannelExtensionItem>, fallbackMessage: string): ChannelExtensionItem {
    if (response.error || !response.data) {
      throw new Error(response.message || fallbackMessage);
    }
    return this.normalizeItem(response.data);
  }

  private normalizeItem(item: ChannelExtensionItem): ChannelExtensionItem {
    return {
      ...item,
      _id: String(item._id || item.id),
      id: String(item.id || item._id),
      assetID: String(item.assetID),
      bitsPrice: Number(item.bitsPrice || 0),
      durationMs: Number(item.durationMs || 0),
      volume: Number(item.volume || 100),
      sortOrder: Number(item.sortOrder || 0),
      thumbnailUrl: item.thumbnailUrl || item.asset?.playbackUrl || '',
      mediaUrl: item.mediaUrl || item.asset?.playbackUrl || null
    };
  }
}
