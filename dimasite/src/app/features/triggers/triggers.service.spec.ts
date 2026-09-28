// @vitest-environment jsdom

import '@angular/compiler';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LinksService } from '../../services/links.service';
import { TriggersService } from './triggers.service';

describe('TriggersService public assets', () => {
  it('loads every page so later assets are available to triggers and DimaFX', async () => {
    const get = vi.fn((_url: string, options: { params: HttpParams }) => {
      const skip = Number(options.params.get('skip'));
      const count = skip === 0 ? 100 : 2;
      return of({ data: Array.from({ length: count }, (_, index) => ({
        _id: `asset-${skip + index}`,
        displayName: `Asset_${skip + index}`,
        mediaType: 'audio',
        scope: 'public',
        marketplaceStatus: 'published'
      })) });
    });
    const injector = Injector.create({ providers: [
      { provide: HttpClient, useValue: { get } },
      { provide: LinksService, useValue: { getApiUrl: () => 'http://api.test' } }
    ] });
    const service = runInInjectionContext(injector, () => new TriggersService());

    const assets = await firstValueFrom(service.getPublicAssets({ q: ' Chile ', mediaType: 'audio' }));

    expect(assets).toHaveLength(102);
    expect(assets.at(-1)?._id).toBe('asset-101');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map(([, options]) => options.params.toString())).toEqual([
      'q=Chile&mediaType=audio&limit=100&skip=0',
      'q=Chile&mediaType=audio&limit=100&skip=100'
    ]);
  });
});
