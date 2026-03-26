import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, Observable, throwError } from 'rxjs';

import { LinksService } from '../../services/links.service';
import {
  ApiEnvelope,
  CreateTriggerRequest,
  LinkedRewardRecord,
  MediaAsset,
  MediaLibraryItem,
  MediaLibraryMutationResult,
  MediaLibraryMeta,
  MediaLibraryResponse,
  MediaType,
  TriggerRecord,
  TriggerTestPayload,
  UpdateTriggerRequest,
  UploadMediaRequest
} from './triggers.model';

@Injectable({
  providedIn: 'root'
})
export class TriggersService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getTriggers(channelId: string): Observable<TriggerRecord[]> {
    return this.http
      .get<ApiEnvelope<TriggerRecord[]>>(`${this.linksService.getApiUrl()}/triggers/${channelId}`)
      .pipe(map((response) => (response.data || []).map((item) => this.normalizeTrigger(item))));
  }

  createTrigger(channelId: string, payload: CreateTriggerRequest): Observable<TriggerRecord> {
    return this.http
      .post<ApiEnvelope<TriggerRecord>>(`${this.linksService.getApiUrl()}/triggers/${channelId}`, payload)
      .pipe(map((response) => this.requireData(response, (item) => this.normalizeTrigger(item), 'Failed to create trigger')));
  }

  updateTrigger(channelId: string, triggerId: string, payload: UpdateTriggerRequest): Observable<TriggerRecord> {
    return this.http
      .patch<ApiEnvelope<TriggerRecord>>(`${this.linksService.getApiUrl()}/triggers/${channelId}/${triggerId}`, payload)
      .pipe(map((response) => this.requireData(response, (item) => this.normalizeTrigger(item), 'Failed to update trigger')));
  }

  deleteTrigger(channelId: string, triggerId: string): Observable<void> {
    return this.http
      .delete<ApiEnvelope<TriggerRecord>>(`${this.linksService.getApiUrl()}/triggers/${channelId}/${triggerId}`)
      .pipe(map((response) => this.requireNoError(response, 'Failed to delete trigger')));
  }

  sendTrigger(channelId: string, payload: TriggerTestPayload): Observable<void> {
    return this.http
      .post<ApiEnvelope<Record<string, unknown>>>(`${this.linksService.getApiUrl()}/triggers/${channelId}/send`, payload)
      .pipe(map((response) => this.requireNoError(response, 'Failed to send trigger')));
  }

  getLibrary(channelId: string): Observable<MediaLibraryResponse> {
    return this.http
      .get<ApiEnvelope<MediaLibraryItem[]>>(`${this.linksService.getApiUrl()}/triggers/library/${channelId}`)
      .pipe(
        map((response) => ({
          items: (response.data || []).map((item) => this.normalizeLibraryItem(item)),
          total: Number(response.total || response.data?.length || 0),
          meta: this.normalizeLibraryMeta(response.meta)
        }))
      );
  }

  getPublicAssets(query?: { q?: string; mediaType?: MediaType | 'all' }): Observable<MediaAsset[]> {
    let params = new HttpParams();
    if (query?.q?.trim()) {
      params = params.set('q', query.q.trim());
    }
    if (query?.mediaType && query.mediaType !== 'all') {
      params = params.set('mediaType', query.mediaType);
    }

    return this.http
      .get<ApiEnvelope<MediaAsset[]>>(`${this.linksService.getApiUrl()}/triggers/assets/public`, { params })
      .pipe(map((response) => (response.data || []).map((item) => this.normalizeAsset(item))));
  }

  uploadMedia(channelId: string, request: UploadMediaRequest): Observable<MediaLibraryItem> {
    const formData = new FormData();
    formData.append('trigger', request.file);
    formData.append('name', request.name);
    formData.append('scope', request.scope);

    return this.http
      .post<ApiEnvelope<MediaLibraryItem>>(`${this.linksService.getApiUrl()}/triggers/library/${channelId}/upload`, formData)
      .pipe(map((response) => this.requireData(response, (item) => this.normalizeLibraryItem(item), 'Failed to upload media')));
  }

  addPublicAssetToLibrary(channelId: string, assetId: string): Observable<MediaLibraryMutationResult> {
    return this.http
      .post<ApiEnvelope<MediaLibraryItem>>(
        `${this.linksService.getApiUrl()}/triggers/library/${channelId}/add-public/${assetId}`,
        {}
      )
      .pipe(
        map((response) => ({
          item: this.requireData(response, (item) => this.normalizeLibraryItem(item), 'Failed to add public asset'),
          meta: this.normalizeLibraryMeta(response.meta)
        }))
      );
  }

  removeLibraryItem(channelId: string, libraryItemId: string): Observable<void> {
    return this.http
      .delete<ApiEnvelope<MediaLibraryItem>>(`${this.linksService.getApiUrl()}/triggers/library/${channelId}/${libraryItemId}`)
      .pipe(map((response) => this.requireNoError(response, 'Failed to remove media item')));
  }

  private requireData<TInput, TOutput>(
    response: ApiEnvelope<TInput>,
    normalize: (value: TInput) => TOutput,
    fallbackMessage: string
  ): TOutput {
    if (response.error || response.data === undefined) {
      throw new Error(response.message || fallbackMessage);
    }

    return normalize(response.data);
  }

  private requireNoError(response: ApiEnvelope<unknown>, fallbackMessage: string): void {
    if (response.error) {
      throw new Error(response.message || fallbackMessage);
    }
  }

  private normalizeTrigger(trigger: TriggerRecord): TriggerRecord {
    return {
      ...trigger,
      _id: String(trigger._id),
      rewardID: trigger.rewardID || '',
      prompt: trigger.prompt || '',
      fileID: trigger.fileID ? String(trigger.fileID) : null,
      assetID: trigger.assetID ? String(trigger.assetID) : null,
      libraryItemID: trigger.libraryItemID ? String(trigger.libraryItemID) : null,
      cost: Number(trigger.cost || 0),
      cooldown: Number(trigger.cooldown || 0),
      volume: Number(trigger.volume || 100),
      reward: trigger.reward ? this.normalizeReward(trigger.reward) : null
    };
  }

  private normalizeReward(reward: LinkedRewardRecord): LinkedRewardRecord {
    return {
      ...reward,
      _id: String(reward._id),
      rewardID: String(reward.rewardID),
      originalCost: Number(reward.originalCost || 0),
      cost: Number(reward.cost || 0),
      cooldown: Number(reward.cooldown || 0),
      costChange: Number(reward.costChange || 0),
      duration: Number(reward.duration || 0),
      message: reward.message || '',
      prompt: reward.prompt || ''
    };
  }

  private normalizeAsset(asset: MediaAsset): MediaAsset {
    return {
      ...asset,
      _id: String(asset._id),
      ownerChannelID: String(asset.ownerChannelID),
      bytes: Number(asset.bytes || 0),
      createdAt: asset.createdAt || new Date().toISOString(),
      updatedAt: asset.updatedAt || new Date().toISOString(),
      playbackUrl: asset.playbackUrl || asset.storageUrl
    };
  }

  private normalizeLibraryItem(item: MediaLibraryItem): MediaLibraryItem {
    return {
      ...item,
      _id: String(item._id),
      assetID: String(item.assetID),
      quotaBytesCharged: Number(item.quotaBytesCharged || 0),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString(),
      asset: item.asset ? this.normalizeAsset(item.asset) : null
    };
  }

  private normalizeLibraryMeta(meta: Record<string, unknown> | undefined): MediaLibraryMeta {
    return {
      planTier: (meta?.['planTier'] as MediaLibraryMeta['planTier']) || 'free',
      quotaBytesUsed: Number(meta?.['quotaBytesUsed'] || 0),
      quotaBytesLimit: Number(meta?.['quotaBytesLimit'] || 0)
    };
  }
}
