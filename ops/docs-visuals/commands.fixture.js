// Commands API fixtures for the shared offline docs capture gateway.
// Command shapes and sample interactions mirror ops/checks/commands-browser.mjs.
(() => {
  const { channelID, channel, handlers, lang } = window.docsCapture;
  const userID = channelID;
  const command = (over) => ({ func: 'custom', cooldown: 10, userLevel: 1, userLevelName: 'everyone', enabled: true, reserved: false,
    description: 'No description provided.', channel, channelID, createdAt: '2026-01-01T00:00:00Z', message: '', ...over });
  const commands = [
    command({ _id: 'discord', name: 'Discord', cmd: 'discord', message: 'Join us: discord.gg/example' }),
    command({ _id: 'speech', name: 'Speech Chat', cmd: 's', message: '$(tts $(user) says: &t)', cooldown: 0 }),
    command({ _id: 'socials', name: 'Socials', cmd: 'socials', message: 'Follow me everywhere!' }),
    command({ _id: 'hug', name: 'Hug', cmd: 'hug', message: '$(user) hugs &p1', userLevel: 5, userLevelName: 'vip' }),
    command({ _id: 'secret', name: 'Secret', cmd: 'secret', message: 'shh', enabled: false }),
    command({ _id: 'kw', name: 'Hello keyword', cmd: 'hola', message: 'Hola $(user)!', activation: 'keyword', keywordSettings: { matchMode: 'start' } }),
    command({ _id: 'b-so', name: 'shoutout', cmd: 'so', func: 'shoutout', reserved: true, userLevel: 7 }),
    command({ _id: 'b-poll', name: 'Create Poll', cmd: 'poll', func: 'poll', reserved: true, userLevel: 7 }),
    command({ _id: 'b-endpoll', name: 'End Poll', cmd: 'endpoll', func: 'endpoll', reserved: true, userLevel: 7 }),
    command({ _id: 'b-follow', name: 'Follow Age', cmd: 'followage', func: 'followage', reserved: true }),
    command({ _id: 'b-amor', name: 'amor', cmd: 'amor', reserved: true }),
    command({ _id: 'b-clear', name: 'Clear Chat', cmd: 'clearchat', func: 'clearChat', reserved: true, userLevel: 7, enabled: false }),
    command({ _id: 'b-odd', name: 'Mystery Tool', cmd: 'mystery', func: 'someNewFunc', reserved: true, description: 'Does a new thing.' }),
  ];

  const eventTypes = [
    ['channel.subscribe', 'New subscriptions', 'Nuevas suscripciones', 'Star',
      'Welcome new subscribers, including viewers who receive a gift subscription.',
      'Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada.', 'Thanks $(user) for subscribing at $(sub.tier)!', '¡Gracias $(user) por suscribirte en nivel $(sub.tier)!'],
    ['channel.subscription.gift', 'Gifted subscriptions', 'Suscripciones regaladas', 'Heart',
      'Thank subscription gifts with one message per gift batch, including anonymous gifts.',
      'Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos.', 'Thank you for the gifted $(sub.tier) subscriptions!', '¡Gracias por las suscripciones regaladas de nivel $(sub.tier)!'],
    ['channel.subscription.message', 'Resubscription messages', 'Mensajes de resuscripción', 'MessageCircle',
      'Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.',
      'Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje.', 'Thanks $(user) for $(sub.months) months of support at $(sub.tier)!', '¡Gracias $(user) por apoyar durante $(sub.months) meses con una suscripción de nivel $(sub.tier)!'],
    ['channel.subscription.end', 'Subscription endings', 'Suscripciones finalizadas', 'Clock',
      'Post a message when a subscription expires. Leave the message empty to stay silent.',
      'Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo.', '', ''],
  ];
  const eventCatalog = eventTypes.map(([type, nameEn, nameEs, icon, en, es, messageEn, messageEs]) => ({
    name: nameEn, type, icon, version: '1', condition: { broadcaster_user_id: 'user' },
    releaseStage: 'stable', enabled: false, plan_tier: 'free', description: { EN: en, ES: es },
    config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: lang === 'es' ? messageEs : messageEn, canDisable: true }],
  }));
  const eventSubs = eventCatalog.map((event, index) => ({ _id: `fixture-${index}`, id: `twitch-${index}`, type: event.type,
    version: '1', enabled: true, status: 'enabled', message: event.config[0].value || `Existing ${event.type}` }));

  handlers.push(({ url, method }) => {
    if (url.pathname.startsWith(`/dashboard/${userID}/`)) {
      const section = url.pathname.split('/').at(-1);
      const now = Date.now();
      const day = (n) => new Date(now - n * 86_400_000).toISOString();
      if (section === 'access') return { data: { allowed: true, role: 'owner', channelID: userID, channelName: 'DemoStreamer', planTier: 'pro' } };
      if (section === 'bootstrap') return { data: {
        role: 'owner', channel: { id: userID, name: 'DemoStreamer', chatEnabled: true }, isLive: false,
        liveStream: null, liveSession: null,
        kpis: { activeViewers: 0, averageViewers: 46, monthlyAverageViewers: 42, averageHoursPerStream: 3.2,
          totalBits: 3200, totalStreams: 8, totalDonations: 45, activeFollows: 540, activeSubs: 18,
          monthlyGoalSubs: 25, subsProgressPct: 72 }, trend: [],
        streamHistory: [0, 1, 2, 3, 5, 8].map((n, i) => ({ date: day(n), viewers: 34 + i * 4, hours: 2.8, bits: 120 + i * 50, donations: 5, follows: 8 + i, subs: i % 3 })),
        totalFollowers: 5400, totalSubs: 320, monthlyGoals: { followersGoal: 6000, followersCurrent: 5400, subsGoal: 500, subsCurrent: 320 },
      } };
      if (section === 'insights') return { data: { summary: {
        days: 30, timeZone: 'UTC', streams: 8, excludedStreams: 1,
        weekdays: Array.from({ length: 7 }, (_, i) => ({ weekday: (i + 1) % 7, streams: i % 3 === 0 ? 0 : 3,
          hours: i % 3 === 0 ? 0 : 6, follows: i * 3, followsPerStream: i % 3 === 0 ? null : 4 + i,
          followsPerHour: i % 3 === 0 ? null : 1.5, averageViewers: i % 3 === 0 ? null : 30, coverage: 0.9, eligible: true })),
        games: [{ game: 'Celeste', streams: 4, hours: 8, viewerHours: 160, averageViewers: 20, follows: 18, followsPerHour: 2.25, eligible: true },
          { game: 'Stardew Valley', streams: 3, hours: 6, viewerHours: 120, averageViewers: 20, follows: 9, followsPerHour: 1.5, eligible: true }],
        gameCount: 2, bestDay: 2, bestGrowthGame: 'Celeste', limited: false, sampledHours: 28, hours: 32,
      }, pending: false, stale: false, updatedAt: new Date().toISOString() } };
      if (section === 'raids') return { data: { summary: { days: 7, from: day(7), to: new Date().toISOString(),
        totals: [{ _id: 'incoming', raids: 4, viewers: 106, biggest: 40, followsAfter: 64, evaluatedRaids: 4 },
          { _id: 'outgoing', raids: 2, viewers: 25, biggest: 25, followsAfter: 0, evaluatedRaids: 0 }],
        incoming: [{ peerID: 'p1', peerName: 'PixelPancho', peerLogin: 'pixelpancho', viewers: 40, occurredAt: day(1), followsAfter: 24 }],
        outgoing: [{ peerID: 'p2', peerName: 'StarGarden', peerLogin: 'stargarden', viewers: 25, occurredAt: day(2), followsAfter: null }],
        topIncoming: [{ _id: 'p1', name: 'PixelPancho', login: 'pixelpancho', count: 1, viewers: 40, lastAt: day(1) }],
        topOutgoing: [{ _id: 'p2', name: 'StarGarden', login: 'stargarden', count: 1, viewers: 25, lastAt: day(2) }],
      }, tracking: { incoming: true, outgoing: true }, updatedAt: new Date().toISOString(), pending: false, stale: false } };
      if (section === 'activity') return { data: { summary: { days: 7, commands: [{ key: 'hello', label: '!hello', count: 60 }, { key: 'uptime', label: '!uptime', count: 40 }],
        emotes: [{ key: 'twitch:owner_1', label: 'DemoHype', count: 30 }], emoteScope: 'streamer', emoteCatalog: { status: 'ready', checkedAt: new Date().toISOString() },
        commandRuns: 100, emoteUses: 30, coverageStartedAt: day(7), pending: false }, updatedAt: new Date().toISOString(), pending: false, stale: false } };
      return { data: {} };
    }
    if (url.pathname === `/billing/ai-credits`) return { data: { used: 600, limit: 1000, balance: 400, meterId: 'demo-meter', updatedAt: new Date().toISOString(), available: true } };
    if (url.pathname === '/billing/ai-usage/summary') return { data: { planTier: 'pro', credits: { used: 600, limit: 1000, balance: 400, available: true }, analytics: null } };
    if (url.pathname.startsWith('/moderation/')) return { data: url.pathname.endsWith('/logs') ? { logs: [], total: 0, limit: 100, skip: 0 } : { enabled: true, rules: [] } };
    if (url.pathname.startsWith('/goals/')) return { data: { plan: 'pro', limit: 4, metrics: ['follows', 'subs', 'bits'], revision: 1, goals: [], canManage: true } };
    if (url.pathname.startsWith('/rewards/')) return { data: [] };
    if (url.pathname.startsWith('/eventsubs/')) return { data: eventSubs };
    if (url.pathname === '/site/events') return { data: eventCatalog };
    if (url.pathname.startsWith('/commands/')) {
      if (method === 'GET') {
        const activation = url.searchParams.get('activation');
        return { data: { commands: commands.filter(item => activation === 'all' || item.activation !== 'keyword') } };
      }
      return { data: {} };
    }
    if (url.pathname === `/timers/${channelID}`) return { data: [{ name: 'socials', frequency: 15, message: 'Follow me everywhere!', active: true }] };
    // Telemetry SDK config calls are intentionally empty in the isolated capture.
    if (url.pathname === '/flags/' || url.pathname === '/flags' || url.pathname.startsWith('/array/')) return { data: {} };
    return undefined;
  });
})();
