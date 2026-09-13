import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ChannelApiService, type ChannelUser } from './channel-api.service';
import { LinksService } from './links.service';

describe('ChannelApiService', () => {
  let service: ChannelApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: LinksService,
          useValue: { getApiUrl: () => 'https://api.example.test' }
        }
      ]
    });

    service = TestBed.inject(ChannelApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it('searches for the requested channel ID instead of loading only the first users page', () => {
    const channel = { channelID: '987654321', channel: 'outside-first-page' } as ChannelUser;
    let result: ChannelUser | null | undefined;

    service.getChannel(channel.channelID).subscribe(value => result = value);

    const request = httpTesting.expectOne(
      'https://api.example.test/admin-site/users?page=1&limit=100&search=987654321'
    );
    request.flush({ data: { rows: [channel] } });

    expect(result).toBe(channel);
  });

  it('surfaces API failures instead of reporting the channel as missing', () => {
    let receivedError: unknown;

    service.getChannel('987654321').subscribe({
      error: error => receivedError = error
    });

    const request = httpTesting.expectOne(
      'https://api.example.test/admin-site/users?page=1&limit=100&search=987654321'
    );
    request.flush(
      { message: 'Internal server error' },
      { status: 500, statusText: 'Internal Server Error' }
    );

    expect(receivedError).toBeTruthy();
  });
});
