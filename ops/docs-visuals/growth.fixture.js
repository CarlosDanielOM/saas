/*
 * Local-only visual fixtures for ops/docs-visuals/growth.mjs.
 * API response shapes and scenario values follow the feature browser checks:
 * ai-personality-browser, memories-browser, stream-summaries-browser,
 * clip-recommendations-browser, follow-defense-browser, and
 * semantic-moderation-browser. The :4206 gateway blocks external traffic and
 * reports any API route that this fixture does not explicitly handle.
 */
(() => {
  const capture = window.docsCapture;
  if (!capture) throw new Error('growth fixture needs the docsCapture gateway');

  const now = Date.now();
  const hour = (n) => new Date(now - n * 60 * 60 * 1000).toISOString();
  const day = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
  const id = capture.channelID;
  const name = capture.channel;
  const voice = { tone: 'Friendly and playful', cadence: 'Short and dynamic', style: 'Chat-native', catchphrases: ['GG chat'] };
  const profile = (profileID, title, personality) => ({ profileID, name: title, personality, personaMode: 'original', personaReference: '', tonePreset: 'balanced', voiceProfile: { ...voice } });
  const personality = {
    channelID: id, channel: name, enabled: true, streamSummariesEnabled: true, recommendationsEnabled: true,
    profiles: [
      profile('p1', 'Chill co-host', 'You are a chill co-host. Keep replies short and never spoil games.'),
      profile('p2', 'Horror night', 'Spooky narrator voice for horror streams.')
    ],
    activeProfileId: 'p1', personality: '', personaMode: 'original', personaReference: '', tonePreset: 'balanced',
    voiceProfile: { ...voice },
    learningConfig: {
      enabled: true, autoConfirmEnabled: true, autoConfirmThreshold: 0.82, minMessageLength: 12,
      maxPendingMemories: 250, maxConfirmedMemories: 2000, postStreamSummaryEnabled: true,
      weeklyMaintenanceEnabled: true, monthlyMaintenanceEnabled: true, autoApplyCreates: true,
      autoApplyEdits: true, autoApplyArchives: true, autoApplyPermanentDeletes: false,
      summaryMinDurationMinutes: 20, summaryMinChatMessages: 30, createMinConfidence: 0.72,
      editMinConfidence: 0.74, archiveMinConfidence: 0.8, deleteMinConfidence: 0.88,
      maxActionsPerRun: 20, maxDeletesPerRun: 5, minMemoryAgeDaysForDelete: 30, minUnusedDaysForDelete: 21
    },
    memoryPolicy: { prioritizeRecentChat: true, allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true },
    rules: ['No spoilers', 'Be kind to new chatters'],
    knownUsers: [{ username: 'pixelpal', relationship: 'Mod', description: 'Loves co-op games and community nights' }],
    contextWindow: 35, tier: { isPremiumPlus: true, isPremium: true, limits: { profiles: 3, rules: 'unlimited', knownUsers: 'unlimited', contextWindow: 35 } }
  };

  const memory = (key, status, type, summary, extra = {}) => ({
    _id: key, channelID: id, channel: name, type, status, risk: 'low', confidence: 0.91,
    subject: { scope: 'channel', username: '', userID: '' }, content: `${summary} (example details)`, summary,
    fingerprint: key, sourceEvidence: [], createdBy: { source: 'system', username: '', userID: '' },
    reviewReason: '', useCount: 0, createdAt: day(12), updatedAt: day(1), ...extra
  });
  const memories = [
    memory('m1', 'pending_review', 'running_joke', 'Chat calls every boss “Kevin”'),
    memory('m2', 'candidate', 'known_user_fact', 'pixelpal is learning Spanish', { subject: { scope: 'user', username: 'pixelpal', userID: '424243' }, risk: 'medium' }),
    memory('m3', 'confirmed', 'preference', 'Streamer prefers co-op games', { useCount: 5 }),
    memory('m4', 'confirmed', 'boundary', 'Avoid spoilers for story games', { risk: 'high', useCount: 1 }),
    memory('m5', 'archived', 'channel_lore', 'Friday streams start with a coffee toast')
  ];

  const summary = (key, age, extra = {}) => ({
    _id: key, channelID: id, channel: name, stream_session_id: `session-${key}`, stream_id: `vod-${key}`,
    started_at: day(age), ended_at: day(age), duration_minutes: 185, average_viewers: 128,
    peak_viewers: 245, follows: 15, subs: 8, bits: 1500, donations: 50,
    headline: 'Beat the final boss on stream', recap: 'A long boss run with a lively chat.',
    highlights: ['Final boss down on the third try', 'Chat ran a prediction'],
    chat_messages_sampled: 420, snapshot_count: 36, proposed_actions: [], applied_actions: [],
    totals: { proposed: 0, applied: 0, skipped: 0, failed: 0 }, status: 'noop', error_message: '',
    source: 'stream_offline', created_at: '', updated_at: '', ...extra
  });
  const summaries = [
    summary('s1', 1, {
      status: 'applied', totals: { proposed: 2, applied: 1, skipped: 1, failed: 0 },
      proposed_actions: [
        { action: 'create', type: 'fact', summary: 'Their speedrun personal best is 28:45', reason: 'Set a new PB during the stream.', evidence: ['PB at 28:45!', 'GG new record'], confidence: 0.95, risk: 'low' },
        { action: 'edit', summary: 'Prefers the Rex voice for alerts', reason: 'Mentioned it once.', confidence: 0.4, risk: 'low' }
      ],
      applied_actions: [{ action: 'create', status: 'applied', reason: 'created_memory' }, { action: 'edit', status: 'skipped', reason: 'edit_confidence_below_threshold' }]
    }),
    summary('s2', 3, { duration_minutes: 12, chat_messages_sampled: 9, headline: 'Stream summary', recap: 'Stream did not meet summary thresholds, so no memory actions were applied.', highlights: ['Duration: 12 minutes', 'Sampled chat messages: 9'] }),
    summary('s3', 7, { source: 'weekly_maintenance', headline: 'Weekly memory maintenance', recap: 'Reviewed memories; nothing to change.', highlights: [] })
  ];

  const candidate = (key, start, duration, reason, extra = {}) => ({
    _id: key, startSeconds: start, endSeconds: start + duration, reason, audioConfidence: 0.87,
    videoApproved: true, videoWhy: '', s3Key: '', previewUrl: '', status: 'pending',
    twitchClipID: '', created_at: hour(8), ...extra
  });
  const recommendations = [{
    _id: 'r1', channelID: id, channel: name, sessionID: '', streamID: '', vodID: '9001',
    vodUrl: 'https://www.twitch.tv/videos/9001', source: 'manual', status: 'completed',
    requestedBy: id, modelID: 'fixture-model', vodDurationMinutes: 193, costCredits: 9400,
    candidateCount: 4, approvedCount: 1, errorMessage: '', startedAt: hour(8), completedAt: hour(8),
    created_at: hour(8), updated_at: hour(8),
    candidates: [
      candidate('c0', 3725, 32, 'Clutches a 1v3 and the whole chat explodes'),
      candidate('c1', 812, 41, 'Streamer laughs with chat after a jumpscare'),
      candidate('c2', 6120, 25, 'Chat wins the poll and the streamer celebrates'),
      candidate('c3', 9000, 30, 'Cat walks across the keyboard mid-fight', { status: 'confirmed' })
    ]
  }];
  const vods = [
    { id: '9001', title: 'Ranked grind to Diamond', url: 'https://www.twitch.tv/videos/9001', duration: '3h12m5s', durationMinutes: 193, createdAt: hour(20), thumbnailUrl: '' },
    { id: '9002', title: 'Horror night with chat', url: 'https://www.twitch.tv/videos/9002', duration: '1h40m0s', durationMinutes: 100, createdAt: hour(48), thumbnailUrl: '' }
  ];

  const followSettings = {
    channelID: id, channel: name, enabled: true, silentModeEnabled: true, protectionModeEnabled: true,
    attackModeEnabled: true, resetAttackOnNewRaid: true, silentThresholdX: 10, silentWindowYSeconds: 5,
    protectionThresholdB: 100, attackThreshold: null, silentDurationSeconds: 60,
    baselineFollowsPerHour: null, language: capture.lang, settingsVersion: 1
  };
  const followStatus = {
    mode: 'normal', channelID: id, channelLogin: name, channelName: 'DemoStreamer',
    modeStartedAt: now - 125000, burstStartedAt: null, expiresAt: null, triggeredBy: 'none',
    lastTransitionReason: '', lastUpdatedAt: now, trackedCount: 0,
    dynamicBaseline: { calculatedAt: now, averageDaily: 18, averageStream: 24, sampleDays: 30, streamCount: 22, attackThreshold: 500 }, raid: null
  };

  const moderation = {
    channelID: id, channel: name, enabled: true, offenseWindowSeconds: 3600, settingsVersion: 2,
    rules: [{
      id: 'words', type: 'blacklist', enabled: true, terms: ['spoiler', 'backseat'], patterns: [],
      variations: { mode: 'off', entries: [] }, semantic: { enabled: false, policy: '', examples: [], onUncertain: 'allow_and_log' },
      firstOffense: { action: 'warn', timeoutSeconds: 60 }, secondOffense: { action: 'delete', timeoutSeconds: 60 },
      thirdOffense: { action: 'timeout', timeoutSeconds: 60 }, reason: 'Please follow channel rules',
      exemptUserLevel: 7, capsThresholdMode: 'count', minCapsCount: 8, maxCapsPercentage: 70,
      minMessageLength: 10, allowlistDomains: ['twitch.tv'], maxEmoteCount: 10
    }]
  };

  const referralStats = {
    planType: 'PRO', codeLimit: 15, codesUsed: 2, codesRemaining: 13,
    codes: [
      { _id: 'code1', code: 'demostreamer', owner: id, label: 'My channel', stats: { signups: 12, conversions: 4 }, active: true, createdAt: day(40), updatedAt: day(1) },
      { _id: 'code2', code: 'coopcrew', owner: id, label: 'Co-op community', stats: { signups: 6, conversions: 2 }, active: true, createdAt: day(21), updatedAt: day(2) }
    ],
    totalSignups: 18, totalConversions: 6, totalEarned: 1150, currentBalance: 500, channelID: id, role: 'owner'
  };

  const ledgerFollowers = {
    role: 'owner', channelID: id, channelName: 'DemoStreamer',
    filters: { status: 'active', mutual: 'all', order: 'desc', search: '' },
    rows: [
      { follower_id: '424243', follower_login: 'pixelpal', follower_name: 'PixelPal', mutual: true, status: 'active', followed_at: day(8), ended_at: null },
      { follower_id: '424244', follower_login: 'cozyquest', follower_name: 'CozyQuest', mutual: false, status: 'active', followed_at: day(3), ended_at: null },
      { follower_id: '424245', follower_login: 'nightowl', follower_name: 'NightOwl', mutual: false, status: 'active', followed_at: day(1), ended_at: null }
    ],
    pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
    summary: { activeCount: 3, mutualCount: 1, nonMutualCount: 2 }
  };

  capture.handlers.push(({ url, method, body }) => {
    const path = url.pathname;
    if (path === `/ai-personality/${id}`) return { data: personality };
    if (path === `/memories/${id}`) {
      const items = memories.filter((item) => {
        const status = url.searchParams.get('status')?.split(',');
        const type = url.searchParams.get('type')?.split(',');
        const risk = url.searchParams.get('risk')?.split(',');
        return (!status || status.includes(item.status)) && (!type || type.includes(item.type)) && (!risk || risk.includes(item.risk));
      });
      return { data: { items, total: items.length } };
    }
    if (path === `/stream-summaries/${id}`) return { data: { items: summaries, total: summaries.length } };
    if (path === `/clip-recommendations/${id}/config`) return { data: { autoAnalyzeEnabled: false, canAutoAnalyze: true, planTier: 'pro', lastAnalyzedAt: null, pricing: { baseCredits: 2750, baseMinutes: 60, extraCreditsPerMinute: 50 } } };
    if (path === `/clip-recommendations/${id}/vods`) return { data: { days: 7, vods } };
    if (path === `/clip-recommendations/${id}`) return { data: { items: recommendations, total: recommendations.length } };
    if (path === '/billing/ai-credits') return { data: { used: 0, limit: 800000, balance: 50000, meterId: 'fixture', updatedAt: new Date().toISOString(), available: true } };
    if (path === `/follow-defense/${id}/settings`) return { data: followSettings };
    if (path === `/follow-defense/${id}/status`) return { data: followStatus };
    if (path === `/follow-defense/${id}/attacks`) return { data: { entries: [], total: 0, page: 1, limit: 10 } };
    if (path === `/follow-defense/${id}/hate-raids`) return { data: { sources: [], total: 0, page: 1, limit: 10 } };
    if (path === `/follow-defense/${id}/raid-sessions`) return { data: { sessions: [], total: 0, page: 1, limit: 20, canBan: true, planTier: 'pro', canBanSession: true, canBanIndividual: true } };
    if (path === `/moderation/${id}/settings`) return { data: moderation };
    if (path === `/moderation/${id}/logs`) return { data: { logs: [], total: 0, limit: 20, skip: 0 } };
    if (path === `/moderation/${id}/decisions`) return { data: { total: 0, limit: 10, skip: 0, decisions: [] } };
    if (path === `/referrals/stats` && method === 'GET') return { data: referralStats };
    if (path === `/referrals/ledger` && method === 'GET') {
      const view = url.searchParams.get('view');
      const items = view === 'timeline'
        ? [{ id: 'event1', kind: 'reward', userId: '424243', name: 'PixelPal', code: 'demostreamer', at: day(1), credits: 50 }, { id: 'event2', kind: 'signup', userId: '424244', name: 'CozyQuest', code: 'coopcrew', at: day(3), credits: 0 }]
        : [{ id: '424243', name: 'PixelPal', code: 'demostreamer', signedUpAt: day(35), tier: 'premium', creditsEarned: 150 }, { id: '424244', name: 'CozyQuest', code: 'coopcrew', signedUpAt: day(20), tier: 'pro', creditsEarned: 100 }];
      return { data: { view, items, page: 1, hasMore: false } };
    }
    if (path.startsWith('/referrals/codes') && method === 'POST') return { data: {} };
    if (path.startsWith(`/analytics/follows/${id}`)) return { data: ledgerFollowers };
    return undefined;
  });
})();
