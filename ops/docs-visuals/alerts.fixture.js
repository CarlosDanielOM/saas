// Deterministic synthetic fixture data for alert-related documentation captures.
// Loaded by the isolated preview gateway after its request-blocking core and
// before Angular starts. Keep every example visibly fictional.
(() => {
  const capture = window.docsCapture;
  const channelID = '424242';
  const channel = 'demostreamer';
  const user = { id: channelID, login: channel, display_name: 'DemoStreamer', profile_image_url: '' };
  const app = {
    name: 'DemoStreamer', email: 'demo@example.invalid', language: capture.lang || 'en',
    plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: channelID,
    has_permissions: true, up_to_date_permissions: true, administrating: []
  };
  Object.assign(capture, { channelID, channel, user, app });

  const now = '2026-10-15T18:30:00.000Z';
  const media = (id, name, mediaType, scope = 'private') => ({
    _id: id, ownerChannelID: channelID, ownerChannelName: 'DemoStreamer', displayName: name,
    fileName: `${name.toLowerCase().replaceAll(' ', '-')}.${mediaType === 'audio' ? 'mp3' : 'mp4'}`,
    extension: mediaType === 'audio' ? 'mp3' : 'mp4', mimeType: mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4',
    mediaType, bytes: mediaType === 'audio' ? 420_000 : 2_400_000, storageUrl: '', playbackUrl: '',
    scope, marketplaceStatus: 'not_listed', createdAt: now, updatedAt: now
  });
  const art = media('media-demo-01', 'Victory Fanfare', 'audio');
  const clip = media('media-demo-02', 'Stream Intro', 'video');
  const library = [art, clip].map((asset, i) => ({
    _id: `library-demo-0${i + 1}`, assetID: asset._id, relationType: 'owner_upload', localAlias: null,
    quotaBytesCharged: asset.bytes, assetScope: asset.scope, mediaType: asset.mediaType, isActive: true,
    createdAt: now, updatedAt: now, asset
  }));
  const trigger = {
    _id: 'trigger-demo-01', name: 'Victory', channel, channelID, rewardID: '', file: '', fileID: null,
    assetID: art._id, libraryItemID: library[0]._id, type: 'media', mediaType: 'audio', isEnabled: true,
    cost: 0, cooldown: 0, prompt: '', volume: 80, reward: null
  };

  const item = (id, name, category, bitsPrice, extra = {}) => ({
    _id: id, id, channelID, channelName: 'DemoStreamer', assetID: null, name, description: '', category,
    mediaType: category === 'tts' ? 'audio' : category, thumbnailUrl: '', durationMs: category === 'image' ? 7000 : 3400,
    bitsPrice, sku: id, volume: 80, isEnabled: true, sortOrder: 0, tts: null, mediaUrl: null,
    asset: null, createdAt: now, updatedAt: now, ...extra
  });
  const shop = [
    item('fx-demo-01', 'Victory Fanfare', 'audio', 25),
    item('fx-demo-02', 'Say hello', 'tts', 10, { tts: { mode: 'fixed', text: 'Welcome to DemoStreamer!', voice: '', language: 'en' } })
  ];

  const rewardRows = [
    { id: 'reward-demo-01', rewardID: 'reward-demo-01', eventsubID: 'event-demo-01', channelID, channel, title: 'Hydrate', type: 'custom', prompt: 'Take a sip of water', cost: 500, originalCost: 500, costChange: 0, returnToOriginalCost: false, isEnabled: true, message: '$(user) takes a hydration break.', duration: 0, cooldown: 300 },
    { id: 'reward-demo-02', rewardID: 'reward-demo-02', eventsubID: 'event-demo-02', channelID, channel, title: 'Play a sound', type: 'custom', prompt: '', cost: 1000, originalCost: 1000, costChange: 0, returnToOriginalCost: false, isEnabled: true, message: '$(trigger.send Victory)', duration: 0, cooldown: 0 }
  ];
  const twitchRewards = rewardRows.map((r, i) => ({
    id: r.rewardID, broadcaster_id: channelID, broadcaster_login: channel, title: r.title, prompt: r.prompt,
    cost: r.cost, is_enabled: r.isEnabled, is_paused: false, background_color: i ? '#7c3aed' : '#00c7ac',
    is_user_input_required: i === 0, should_redemptions_skip_request_queue: false, image: null, default_image: null,
    global_cooldown_setting: { is_enabled: r.cooldown > 0, global_cooldown_seconds: r.cooldown }
  }));

  const prize = (id, label, multiplier, weight) => ({
    id, label, multiplier, weight, action: '', copies: Array.from({ length: multiplier }, (_, i) => `${id}-copy-${i + 1}`)
  });
  const prizes = [prize('prize-demo-01', 'Choose the next game', 1, 2), prize('prize-demo-02', 'VIP for one day', 3, 1), prize('prize-demo-03', 'Mystery prize', 1, 1)];
  const roulette = {
    id: 'roulette-demo-01', alias: 'giveaways', name: 'Friday giveaways', design: 'reel', cardSize: 'large',
    colors: ['#cbbaff', '#f4c968', '#ec9baf', '#a5d5c2'], durationSeconds: 8, items: prizes,
    order: prizes.flatMap(p => p.copies), settings: {
      insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true,
      hideAfterSeconds: null, winnerAction: 'keep'
    }
  };
  const rouletteState = {
    revision: 1, serverTime: Date.now(), roulettes: [roulette], activeId: roulette.id, visible: false,
    draw: null, history: [], hideAt: null, actionRuns: []
  };

  const layer = (id, kind, x, y, width, height) => ({ id, kind, x, y, width, height, visible: true, locked: false });
  const design = {
    id: 'design-demo-01', name: 'Demo alerts', revision: 1, width: 800, height: 240,
    events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, {
      duration: 5, widgets: [{ ...layer(`${kind}-label`, 'text', 24, 20, 420, 80), text: '$(user)' }]
    }]))
  };
  const overlayState = {
    schemaVersion: 1, revision: 1,
    scenes: [{ id: 'scene-demo-01', name: 'Main overlay', width: 1920, height: 1080, revision: 1,
      publicId: '', widgets: [layer('tts-demo-01', 'tts', 80, 70, 600, 150),
        { ...layer('alert-demo-01', 'alert', 100, 300, 800, 260), designId: design.id, events: ['follow', 'bits', 'sub', 'raid'] }], waitFor: ['tts'] }],
    designs: [design]
  };

  const tags = ['happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'scared', 'worried', 'disappointed', 'curious', 'sarcastic', 'satisfied', 'delighted', 'upset', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful', 'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain', 'doubtful', 'confused', 'regretful', 'guilty', 'ashamed', 'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored', 'contemptuous', 'sympathetic', 'compassionate', 'determined', 'resigned', 'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast', 'emphasis', 'screaming', 'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp', 'inhale', 'exhale', 'sobbing', 'groaning', 'panting', 'yawning', 'snoring', 'clear throat', 'pause', 'long-pause', 'audience laughing', 'background laughter'];
  const ttsSettings = {
    channelID, channel, enabled: true, provider: 'kokoro', defaultLanguage: 'en',
    voices: { en: 'af_heart', es: 'ef_dora', cloneDefault: 'gojo', kokoroDefault: 'af_heart' },
    filters: { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 300,
      expressiveTags: Object.fromEntries(tags.map(tag => [tag, true])) }, queue: { maxItems: 20 }
  };

  capture.handlers.push(({ url, method, body }) => {
    const p = url.pathname;
    // The blocked analytics SDK posts here; return inert fixture acknowledgments.
    if (p.startsWith('/array/') || p.startsWith('/flags/') || p === '/e/') return { data: {} };
    if (p === `/commands/${channelID}`) return { data: { commands: [{
      _id: 'speech-demo-01', channelID, channel, name: 'Text to speech', cmd: 's', func: 'speech',
      enabled: true, reserved: true, cooldown: 10, userLevel: 1, userLevelName: 'everyone',
      message: '$(tts &t)', createdAt: now
    }] } };
    if (p === '/speech/settings/' + channelID) return { data: { role: 'owner', settings: ttsSettings, kokoroVoices: ['af_heart', 'af_bella', 'ef_dora'] } };
    if (p === '/speech/favorites/' + channelID) return { data: [{ id: 'favorite-demo-01', name: 'Gojo voice', alias: 'gojo_fan' }] };
    if (p === '/speech/voices/' + channelID) return { data: { items: [], page: 1, hasMore: false } };
    if (p === '/triggers/' + channelID) return { data: [trigger] };
    if (p === '/triggers/assets/public') return { data: [] };
    if (p === '/triggers/library/' + channelID) return { raw: { error: false, status: 200, data: library, total: library.length,
      meta: { planTier: 'pro', quotaBytesUsed: art.bytes + clip.bytes, quotaBytesLimit: 1_000_000_000 } } };
    if (p === `/extensions/dimafx/${channelID}/items`) return { raw: { error: false, status: 200, data: shop,
      meta: { allowedBitPrices: [5, 10, 25, 50, 100] } } };
    if (p === `/extensions/dimafx/${channelID}/overlay-status`) return { data: { connected: false, overlayUrl: 'https://example.invalid/dimafx/DemoStreamer' } };
    if (p === `/rewards/${channelID}` && method === 'GET') return { data: rewardRows };
    if (p === `/rewards/twitch/${channelID}`) return { data: twitchRewards };
    if (p.startsWith('/roulettes/' + channelID)) return { data: rouletteState };
    if (p === `/overlay-studio/${channelID}/connections`) return { data: {
      checkedAt: Date.now(), pollingFailed: false, scenes: [{ id: 'scene-demo-01', published: false, revision: 1, width: 1920, height: 1080, receives: [], sources: [] }]
    } };
    if (p === `/overlay-studio/${channelID}`) return { data: overlayState };
    if (p === `/overlay-studio/${channelID}/twitch-events`) return { data: {
      poll: { state: 'missing', events: [] }, prediction: { state: 'missing', events: [] }
    } };
    if (p === `/overlay-studio/${channelID}/queue`) return { data: {
      state: { revision: 1, all: false, platforms: {} }, connected: 0, needsRefresh: 0, events: []
    } };
    if (p === `/overlay-studio/${channelID}/preview`) {
      return { data: Array.isArray(body?.texts) ? body.texts.map(text => String(text)
        .replaceAll('$(user)', body.user || 'Luna').replaceAll('$(cheer.amount)', body.amount || '100')) : [] };
    }
    if (p === `/bits-rules/${channelID}`) return { data: [] };
    if (p.startsWith('/asset-library/')) return { data: { assets: [], usedBytes: 0, quotaBytes: 5_000_000_000, maxFileBytes: 50_000_000, planTier: 'pro' } };
    return undefined;
  });
})();
