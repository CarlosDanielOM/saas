import { createGiftRequestId, normalizeChannelLogin, readApiError } from './gift.util';

describe('normalizeChannelLogin', () => {
  it('accepts plain, @-prefixed and mixed-case logins', () => {
    expect(normalizeChannelLogin('dima_fx')).toBe('dima_fx');
    expect(normalizeChannelLogin('  @DimaFX ')).toBe('dimafx');
  });

  it('extracts the login from Twitch links', () => {
    expect(normalizeChannelLogin('twitch.tv/dima')).toBe('dima');
    expect(normalizeChannelLogin('https://www.twitch.tv/Dima/videos?filter=all')).toBe('dima');
    expect(normalizeChannelLogin('https://m.twitch.tv/dima#chat')).toBe('dima');
  });

  it('rejects anything that cannot be a Twitch login', () => {
    expect(normalizeChannelLogin('')).toBeNull();
    expect(normalizeChannelLogin('@')).toBeNull();
    expect(normalizeChannelLogin('dima fx')).toBeNull();
    expect(normalizeChannelLogin('someone@example.com')).toBeNull();
    expect(normalizeChannelLogin('a'.repeat(26))).toBeNull();
    expect(normalizeChannelLogin('https://youtube.com/dima')).toBeNull();
  });
});

describe('createGiftRequestId', () => {
  it('returns distinct v4 UUIDs', () => {
    const first = createGiftRequestId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createGiftRequestId()).not.toBe(first);
  });
});

describe('readApiError', () => {
  it('reads status and envelope message from an HTTP error', () => {
    expect(readApiError({ status: 404, error: { error: true, message: 'Not found' } }))
      .toEqual({ status: 404, message: 'Not found' });
  });

  it('copes with network errors and junk', () => {
    expect(readApiError({ status: 0, error: new ProgressEvent('error') }))
      .toEqual({ status: null, message: null });
    expect(readApiError(null)).toEqual({ status: null, message: null });
  });
});
