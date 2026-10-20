import { Injectable, inject } from '@angular/core';

import { LanguageService } from '../../../../services/language.service';

/**
 * Copy for the three landing proposals (/mocks/dev/landing-showcase, -switch, -start).
 * It lives in the lazy mock chunk instead of the shared en/es.json files so the
 * proposals don't grow the initial bundle; the chosen direction moves its strings
 * into en.json / es.json when it is productized.
 */
type Copy = { [key: string]: string | string[] | Copy };

const EN: Copy = {
  mock: {
    group: 'Mock preview',
    live: 'Someone live',
    real: 'Real live board'
  },
  nav: {
    see: 'What it does',
    switch: 'Why switch',
    start: 'How to start',
    plans: 'Plans',
    docs: 'Docs',
    login: 'Start free',
    loginLong: 'Start free with Twitch',
    theme: 'Switch to {{mode}} theme',
    dark: 'dark',
    light: 'light',
    language: 'Cambiar a español'
  },
  common: {
    free: 'Free',
    premium: 'Premium',
    pro: 'Pro',
    credits: 'Uses AI credits',
    alpha: 'Alpha',
    beta: 'Beta',
    guide: 'How it works',
    checkFree: 'Free plan, no card needed',
    checkTime: 'About 10 minutes to set up',
    checkLang: 'Replies in English and Spanish',
    messages: 'chat messages handled so far',
    commands: 'commands run',
    channels: 'channels with the bot on',
    liveNow: 'Live with DomDimaBot right now',
    liveCount: '{{channels}} live · {{viewers}} watching',
    viewers: '{{n}} viewers',
    footer: '© DomDimaBot',
    docs: 'Docs',
    gettingStarted: 'Getting started',
    commandsDoc: 'Commands',
    plansDoc: 'Plans',
    discord: 'Discord'
  },
  stage: {
    label: 'See it on a stream',
    pause: 'Pause the tour',
    play: 'Play the tour',
    replay: 'Replay',
    chatLabel: 'Stream chat',
    live: 'LIVE',
    watching: '1.2k',
    streamer: 'Dima',
    tabs: {
      alerts: 'Alerts',
      tts: 'Text to speech',
      dimafx: 'Bits shop',
      duel: 'Duels',
      roulette: 'Roulette',
      ai: 'AI co-host',
      moderation: 'Moderation',
      defense: 'Follow Defense'
    },
    caption: {
      alerts: 'Every follow, sub, raid and Bits cheer gets its own alert on stream and a thank-you in chat.',
      tts: 'Viewers’ messages are read aloud on stream, in the voice you pick.',
      dimafx: 'Viewers spend Bits in your Twitch extension to play sounds and videos on your stream.',
      duel: 'Chat challenges chat. The fight plays on your overlay and the loser can get a timeout.',
      roulette: 'Spin a wheel, reel or cards for giveaways, games and punishments.',
      ai: 'An AI co-host that answers chat in your style and remembers your regulars.',
      moderation: 'Spam, scam links and abuse are removed before you even see them.',
      defense: 'When a follow-bot wave hits, alerts pause so the flood never reaches your stream.'
    },
    alert: {
      who: 'NovaPlays',
      what: 'just followed!'
    },
    tts: {
      who: 'taco_fan · 100 Bits',
      text: 'Hola Dima! Greetings from Lima, chat is cooking today',
      voice: 'Voice: Dora (Spanish)'
    },
    fx: {
      panel: 'DimaFX shop',
      airhorn: 'Airhorn',
      confetti: 'Confetti',
      say: 'Say it on stream',
      onWay: 'On its way!',
      burst: 'AIRHORN!'
    },
    roulette: {
      name: 'What do we play next?',
      p1: 'Elden Ring',
      p2: 'Minecraft',
      p3: 'Horror game',
      p4: 'Just Chatting',
      p5: 'Viewer pick',
      p6: 'Valorant'
    },
    ai: {
      card: 'AI co-host',
      cardSub: 'Knows your schedule and your regulars'
    },
    mod: {
      toast: 'Removed a scam link · 10 min timeout'
    },
    defense: {
      count: '{{n}} follows in 20 s',
      paused: 'Follow-bot wave: alerts paused',
      safe: 'Wave over: 38 bot accounts banned'
    },
    chat: {
      alerts: {
        e1: 'NovaPlays followed',
        b1: 'Welcome to the crew, NovaPlays! Grab a seat.',
        v1: 'welcome nova!!',
        e2: 'lunatica_v subscribed for 6 months',
        b2: 'Six months, lunatica_v! Thank you for sticking around.'
      },
      tts: {
        e1: 'taco_fan cheered 100 Bits',
        v1: 'Hola Dima! Greetings from Lima, chat is cooking today',
        v2: 'LMAO the voice',
        b1: 'Reading taco_fan’s message on stream.'
      },
      dimafx: {
        v1: 'do it, buy the airhorn',
        e1: 'pixel_pancho played Airhorn for 50 Bits',
        v2: 'MY EARS',
        v3: 'again again'
      },
      duel: {
        v1: '!duel @lunatica_v',
        b1: '@lunatica_v, taco_fan has challenged you to a duel! To accept use "!duel accept" or decline with "!duel decline" within 30 seconds.',
        v2: '!duel accept',
        b2: 'Fight! Watch the stream.',
        win: '{{name}} wins the duel. Better luck next time, {{loser}}.'
      },
      roulette: {
        v1: '!spin',
        b1: 'Spinning: what do we play next?',
        v2: 'horror horror horror',
        win: 'The wheel says: {{prize}}.'
      },
      ai: {
        v1: '@DomDimaBot when is the next horror stream?',
        b1: 'Friday at 9pm, same as every week. You asked last Friday too, pancho. Bring the lights on this time.',
        v2: 'how does it remember that lol',
        b2: 'I remember what regulars tell me, and Dima can review it any time.'
      },
      moderation: {
        v1: 'cheap followers and viewers at b1t-boost.xyz',
        e1: 'Message removed: scam link from a first-time chatter. 10 minute timeout.',
        v2: 'thanks bot',
        v3: 'clean chat as always'
      },
      defense: {
        e1: '38 follows in 20 seconds from new accounts',
        e2: 'Follow alerts paused while the wave lasts',
        v1: 'are those bots?',
        e3: 'Wave over: 38 bot accounts banned, alerts back on'
      }
    }
  },
  plans: {
    kicker: 'Plans',
    title: 'Start free. Upgrade when your stream needs more.',
    subtitle: 'Every plan has every module that matters to most streamers, and every TTS voice.',
    perMonth: '/month',
    credits: '{{credits}} AI credits a month',
    cueFree: '{{n}} of {{total}} modules, no card',
    cuePaid: '{{times}}× Free’s credits · {{perDollar}}k credits per $1',
    best: 'Most AI credits per dollar',
    recommended: 'Fits what you picked',
    free1: '{{n}} of {{total}} modules: alerts, TTS, moderation, Bits shop, roulette…',
    free2: 'Every text-to-speech voice',
    free3: 'Commands with a 5 second minimum cooldown',
    premium1: 'Adds {{modules}}',
    premium2: '250 MB private storage, 25 MB uploads',
    premium3: '180 days of stream history',
    pro1: 'Everything in Premium',
    pro2: '1 GB private storage, 100 MB uploads',
    pro3: '1 second cooldowns, 365 days of history',
    ctaFree: 'Start free',
    ctaPremium: 'Start with Premium',
    ctaPro: 'Start with Pro',
    compare: 'Compare every limit',
    compareNote: 'Credits don’t roll over. You can buy extra credits on any plan.',
    capability: 'Feature',
    rows: {
      credits: 'AI credits a month',
      cooldown: 'Shortest command cooldown',
      storage: 'Private media storage',
      upload: 'Largest upload',
      bandwidth: 'Bandwidth',
      history: 'Stream analytics history',
      memory: 'Chat memory',
      none: 'None',
      unlimited: 'Unlimited (fair use)',
      days: '{{n}} days',
      sec: '{{n}} s'
    }
  },
  modules: {
    'chat-events': ['Chat events', 'Thank follows, subs, raids and Bits in chat'],
    moderation: ['Chat moderation', 'Filters and AI that remove spam and abuse'],
    clips: ['Clips', 'Viewers clip with !clip, shout-outs play a clip'],
    dimafx: ['DimaFX Bits shop', 'Viewers spend Bits to play sounds and videos'],
    redemptions: ['Redemptions', 'Channel point rewards that do things'],
    triggers: ['Triggers', 'Sounds and videos on OBS from commands or rewards'],
    tts: ['Text to speech', 'Messages read aloud, every voice on every plan'],
    referrals: ['Referrals', 'Invite streamers, earn credits'],
    'ai-personality': ['AI co-host', 'A chat personality you write'],
    memories: ['Memories', 'What the bot remembers, you approve'],
    'follow-defense': ['Follow Defense', 'Stops follow-bot floods and hate raids'],
    'stream-summaries': ['Stream recaps', 'Numbers and an AI recap after every stream'],
    library: ['Media library', 'Shared sounds, videos and images'],
    'clip-recommendations': ['Clip finder', 'AI points out moments worth clipping'],
    roulette: ['Roulette', 'Wheels, reels and cards on stream'],
    overlays: ['Overlay Studio', 'Design alerts and overlays in the browser'],
    analytics: ['Analytics', 'Who chats, who returns, what grew your channel'],
    'analytics.follows': ['Follow Ledger', 'Every follow and unfollow, with history'],
    widgets: ['Widgets', 'Duels and other games on your overlay'],
    pet: ['Stream pet', 'A companion with its own voice and personality']
  },
  showcase: {
    kicker: 'Twitch bot · alerts · AI co-host',
    title: 'Everything your stream needs,',
    titleAccent: 'in one bot.',
    copy: 'Commands, moderation, alerts, text to speech, a Bits shop, games and an AI co-host. Pick a feature below to see what your viewers will see.',
    secondary: 'See it on a stream',
    whyKicker: 'Why streamers switch',
    whyTitle: 'One login instead of a stack of tools',
    why1Title: 'Everything in one dashboard',
    why1Copy: 'Bot, alerts, TTS, tip page and Bits shop share one login, one chat and one set of OBS links.',
    why2Title: 'Things other bots don’t do',
    why2Copy: 'An AI co-host that remembers your regulars, follow-bot protection and a clip finder that watches your VODs.',
    why3Title: 'Your tips stay yours',
    why3Copy: 'Your tip page sends you 100% of every tip, minus PayPal’s fee. We take nothing.',
    startKicker: 'How to start',
    startTitle: 'On your stream in about 10 minutes',
    s1: 'Log in with Twitch',
    s1Copy: 'You start on Free. No card.',
    s2: 'Turn the bot on',
    s2Copy: 'Approve Twitch permissions, then tap "Turn the bot on".',
    s3: 'Turn on what you want',
    s3Copy: 'Alerts, TTS, moderation… everything else stays off.',
    ctaTitle: 'Ready when you are.',
    ctaCopy: 'Log in with Twitch and try everything on the Free plan.'
  },
  switch: {
    kicker: 'Already have a bot?',
    title: 'Your bot, alerts, TTS and Bits shop.',
    titleAccent: 'One login.',
    copy: 'DomDimaBot does what your current tools do, then adds an AI co-host, follow-bot protection and a clip finder. Try it next to your current bot: nothing changes on stream until you turn it on.',
    coverCommands: 'Unlimited commands & timers',
    coverTips: 'Tip page, 100% to you',
    pickTitle: 'What do you use today?',
    pickHint: 'Tap everything you have set up now.',
    coverAll: 'All {{n}} are covered here, {{free}} of them on the Free plan.',
    coverNone: 'Tap what you use today to see what moves over.',
    coveredTitle: 'Covered here',
    extraTitle: 'And you’d also get',
    uses: {
      commands: 'Chat commands & timers',
      moderation: 'Spam & link filters',
      alerts: 'On-stream alerts',
      tts: 'Text to speech',
      tips: 'A tip page',
      sounds: 'Sounds on channel points',
      games: 'Viewer games (duels, wheels)',
      bits: 'A Bits extension'
    },
    proofKicker: 'Already running',
    beyondKicker: 'Beyond the basics',
    beyondTitle: 'What you won’t find in most bots',
    b1Title: 'An AI co-host that remembers',
    b1Copy: 'It answers in the personality you write and remembers what your regulars told it. You approve what it keeps.',
    b2Title: 'Follow Defense',
    b2Copy: 'Detects follow-bot floods and hate raids, pauses alerts, and bans the bots once a wave becomes an attack.',
    b3Title: 'Clip finder',
    b3Copy: 'Looks through your recent streams and lists the moments worth clipping.',
    b4Title: 'A recap after every stream',
    b4Copy: 'Numbers, an AI summary and what the bot learned, without opening a spreadsheet.',
    b1Demo: 'You asked last Friday too, pancho.',
    b2Demo: '38 follows in 20 s',
    b3Demo: '3 moments worth clipping',
    b4Demo: '+18 followers · best Friday this month',
    moveKicker: 'Moving over',
    moveTitle: 'What switching looks like, honestly',
    m1Title: 'Keep your current bot while you try',
    m1Copy: 'Both bots can sit in the same chat. If a command exists in both, turn it off in one so it doesn’t answer twice.',
    m2Title: 'Re-create your commands',
    m2Copy: 'There’s no importer yet. Start with your 5 most used commands; each one takes about a minute.',
    m3Title: 'Paste new links into OBS',
    m3Copy: 'Alerts, TTS and sounds each have a Browser Source link you copy once. Remove the old ones when you’re happy.',
    m4Title: 'Bring your mods',
    m4Copy: 'Give helpers access to only the pages they need. Only you can turn the bot on or off.',
    freeKicker: 'What Free covers',
    freeTitle: '{{n}} of {{total}} modules are on the Free plan',
    freeCopy: 'Paid plans add analytics, duels and the stream pet, more AI credits and more storage.',
    faqTitle: 'Questions before switching',
    q1: 'Is the Free plan really free?',
    a1: 'Yes. No card and no trial that ends. It includes 25,000 AI credits a month for AI features and text to speech.',
    q2: 'What uses AI credits?',
    a2: 'AI chat, memories, text-to-speech voices and the clip finder. The basic Piper voice keeps working even when credits run out.',
    q3: 'Does it speak Spanish?',
    a3: 'Yes. The dashboard, the bot and its voices work in English and Spanish.',
    ctaTitle: 'Try it next to your current bot.',
    ctaCopy: 'Nothing changes on your stream until you turn something on.'
  },
  start: {
    kicker: 'Get set up',
    title: 'Live with your new bot',
    titleAccent: 'in about 10 minutes.',
    copy: 'Tell us what you want first. We’ll show you the exact steps and what your viewers will see.',
    goalTitle: 'What do you want first?',
    goals: {
      safe: ['Keep chat safe', 'Spam, links and follow-bots'],
      tts: ['Read messages aloud', 'Text to speech on stream'],
      alerts: ['Thank new followers', 'Alerts on stream and in chat'],
      fun: ['Games for chat', 'Roulette and duels'],
      earn: ['Earn from viewers', 'Bits shop and tip page'],
      ai: ['An AI co-host', 'Answers chat in your style']
    },
    planTitle: 'Your setup, step by step',
    planTotal: 'About {{min}} minutes · all on the Free plan',
    planTotalPaid: 'About {{min}} minutes · duels need Premium',
    s1: 'Log in with Twitch',
    s1Copy: 'Use the account that owns the channel. You start on Free.',
    s2: 'Approve the Twitch permissions',
    s2Copy: 'Tap "Activate Bot" in the top bar and approve. Twitch lists what the bot needs to read and moderate chat.',
    s3: 'Turn the bot on',
    s3Copy: 'On the dashboard tap "Turn the bot on". It joins your chat right away.',
    min: '{{n}} min',
    sec: '{{n}} s',
    step: {
      safe: ['Turn on Chat moderation', 'Pick the filters (links, caps, spam). Follow Defense watches for follow-bot waves.'],
      tts: ['Add the speech link to OBS', 'Open Text to speech, copy the speech link and add it to OBS as a Browser Source.'],
      alerts: ['Choose your chat thank-yous', 'Open Chat events and switch on follows, subs and raids. Edit the messages if you like.'],
      fun: ['Create your first roulette', 'Add a few prizes and copy the overlay link into OBS as a Browser Source.'],
      earn: ['Install the DimaFX extension', 'Add DimaFX on Twitch, open the overlay link in OBS and put a few sounds on sale.'],
      ai: ['Write your co-host’s personality', 'Open AI co-host, describe how it talks and what it should never say.']
    },
    test: {
      safe: ['Try it', 'Post a link from a second account. It’s removed.'],
      tts: ['Try it', 'Type !s hello chat. You’ll hear it on stream.'],
      alerts: ['Try it', 'Ask a friend to follow, or wait for your next follower.'],
      fun: ['Try it', 'Press Start draw on the dashboard and watch the wheel.'],
      earn: ['Try it', 'Play a free test item from the extension.'],
      ai: ['Try it', 'Ask @DomDimaBot something in chat.']
    },
    cta: 'Start free and set this up',
    preview: 'What your viewers will see',
    finderKicker: 'Which plan do I need?',
    finderTitle: 'Answer three questions',
    q1: 'Do you want duels or a stream pet?',
    q2: 'Do you want analytics on who returns and who follows?',
    q3: 'How much will the AI talk or read AI voices?',
    q3a: 'A little',
    q3b: 'Every stream',
    q3c: 'All the time',
    yes: 'Yes',
    no: 'No',
    resultFree: 'Free covers everything you picked.',
    resultPremium: 'Premium fits: {{why}}.',
    resultPro: 'Pro fits: {{why}}.',
    whyGames: 'duels and the pet',
    whyAnalytics: 'analytics',
    whyAi: '200,000 AI credits a month',
    whyAiPro: '800,000 AI credits a month',
    resultNote: 'You can start on Free and upgrade later; nothing is lost.',
    laterKicker: 'Later',
    laterTitle: 'Everything else you can turn on',
    laterCopy: 'Every module, its plan and how finished it is. Alpha means new and still changing.',
    modulesCount: '{{n}} modules',
    groups: {
      engagement: 'Make chat fun',
      automation: 'Keep it running',
      content: 'Clips and recaps'
    },
    ctaTitle: 'Your bot is 10 minutes away.',
    ctaCopy: 'Log in with Twitch. You can change everything later.'
  }
};

const ES: Copy = {
  mock: {
    group: 'Vista previa del mock',
    live: 'Alguien en directo',
    real: 'Tablero real'
  },
  nav: {
    see: 'Qué hace',
    switch: 'Por qué cambiar',
    start: 'Cómo empezar',
    plans: 'Planes',
    docs: 'Docs',
    login: 'Empieza gratis',
    loginLong: 'Empieza gratis con Twitch',
    theme: 'Cambiar a tema {{mode}}',
    dark: 'oscuro',
    light: 'claro',
    language: 'Switch to English'
  },
  common: {
    free: 'Free',
    premium: 'Premium',
    pro: 'Pro',
    credits: 'Usa créditos de IA',
    alpha: 'Alpha',
    beta: 'Beta',
    guide: 'Cómo funciona',
    checkFree: 'Plan Free, sin tarjeta',
    checkTime: 'Unos 10 minutos de configuración',
    checkLang: 'Responde en español e inglés',
    messages: 'mensajes de chat atendidos',
    commands: 'comandos ejecutados',
    channels: 'canales con el bot activo',
    liveNow: 'En directo con DomDimaBot ahora',
    liveCount: '{{channels}} en directo · {{viewers}} viendo',
    viewers: '{{n}} espectadores',
    footer: '© DomDimaBot',
    docs: 'Docs',
    gettingStarted: 'Primeros pasos',
    commandsDoc: 'Comandos',
    plansDoc: 'Planes',
    discord: 'Discord'
  },
  stage: {
    label: 'Míralo en un directo',
    pause: 'Pausar el recorrido',
    play: 'Reproducir el recorrido',
    replay: 'Repetir',
    chatLabel: 'Chat del directo',
    live: 'EN VIVO',
    watching: '1.2k',
    streamer: 'Dima',
    tabs: {
      alerts: 'Alertas',
      tts: 'Texto a voz',
      dimafx: 'Tienda de Bits',
      duel: 'Duelos',
      roulette: 'Ruleta',
      ai: 'Copiloto IA',
      moderation: 'Moderación',
      defense: 'Follow Defense'
    },
    caption: {
      alerts: 'Cada follow, sub, raid y donación de Bits tiene su alerta en pantalla y un agradecimiento en el chat.',
      tts: 'Los mensajes de tus espectadores se leen en voz alta en el directo, con la voz que elijas.',
      dimafx: 'Tus espectadores gastan Bits en tu extensión de Twitch para poner sonidos y videos en tu directo.',
      duel: 'El chat reta al chat. La pelea sale en tu overlay y quien pierde puede llevarse un timeout.',
      roulette: 'Gira una ruleta, un carrete o cartas para sorteos, juegos y castigos.',
      ai: 'Un copiloto con IA que responde al chat con tu estilo y recuerda a tus habituales.',
      moderation: 'El spam, los enlaces de estafa y los insultos desaparecen antes de que los veas.',
      defense: 'Cuando llega una ola de bots de follows, las alertas se pausan y la avalancha nunca llega a tu directo.'
    },
    alert: {
      who: 'NovaPlays',
      what: '¡te sigue!'
    },
    tts: {
      who: 'taco_fan · 100 Bits',
      text: '¡Hola Dima! Saludos desde Lima, el chat está on fire hoy',
      voice: 'Voz: Dora (español)'
    },
    fx: {
      panel: 'Tienda DimaFX',
      airhorn: 'Bocina',
      confetti: 'Confeti',
      say: 'Dilo en el directo',
      onWay: '¡En camino!',
      burst: '¡BOCINA!'
    },
    roulette: {
      name: '¿A qué jugamos ahora?',
      p1: 'Elden Ring',
      p2: 'Minecraft',
      p3: 'Juego de terror',
      p4: 'Charlando',
      p5: 'Elige el chat',
      p6: 'Valorant'
    },
    ai: {
      card: 'Copiloto IA',
      cardSub: 'Conoce tu horario y a tus habituales'
    },
    mod: {
      toast: 'Enlace de estafa eliminado · timeout de 10 min'
    },
    defense: {
      count: '{{n}} follows en 20 s',
      paused: 'Ola de bots: alertas en pausa',
      safe: 'Ola terminada: 38 cuentas bot baneadas'
    },
    chat: {
      alerts: {
        e1: 'NovaPlays te sigue',
        b1: '¡Bienvenida al grupo, NovaPlays! Ponte cómoda.',
        v1: 'bienvenida nova!!',
        e2: 'lunatica_v lleva 6 meses suscrita',
        b2: '¡Seis meses, lunatica_v! Gracias por seguir aquí.'
      },
      tts: {
        e1: 'taco_fan donó 100 Bits',
        v1: '¡Hola Dima! Saludos desde Lima, el chat está on fire hoy',
        v2: 'JAJAJA la voz',
        b1: 'Leyendo el mensaje de taco_fan en el directo.'
      },
      dimafx: {
        v1: 'hazlo, compra la bocina',
        e1: 'pixel_pancho puso Bocina por 50 Bits',
        v2: 'MIS OÍDOS',
        v3: 'otra otra'
      },
      duel: {
        v1: '!duel @lunatica_v',
        b1: '@lunatica_v, ¡taco_fan te ha retado a un duelo! Para aceptar usa "!duel accept" o rechaza con "!duel decline" en 30 segundos.',
        v2: '!duel accept',
        b2: '¡A pelear! Mira el directo.',
        win: '{{name}} gana el duelo. Suerte la próxima, {{loser}}.'
      },
      roulette: {
        v1: '!spin',
        b1: 'Girando: ¿a qué jugamos ahora?',
        v2: 'terror terror terror',
        win: 'La ruleta dice: {{prize}}.'
      },
      ai: {
        v1: '@DomDimaBot ¿cuándo es el próximo directo de terror?',
        b1: 'El viernes a las 9pm, como cada semana. También lo preguntaste el viernes pasado, pancho. Esta vez deja la luz encendida.',
        v2: 'cómo se acuerda de eso jaja',
        b2: 'Recuerdo lo que me cuentan los habituales, y Dima puede revisarlo cuando quiera.'
      },
      moderation: {
        v1: 'followers y viewers baratos en b1t-boost.xyz',
        e1: 'Mensaje eliminado: enlace de estafa de alguien nuevo. Timeout de 10 minutos.',
        v2: 'gracias bot',
        v3: 'chat limpio como siempre'
      },
      defense: {
        e1: '38 follows en 20 segundos de cuentas nuevas',
        e2: 'Alertas de follow en pausa mientras dure la ola',
        v1: '¿son bots?',
        e3: 'Ola terminada: 38 cuentas bot baneadas, alertas activas otra vez'
      }
    }
  },
  plans: {
    kicker: 'Planes',
    title: 'Empieza gratis. Mejora cuando tu directo lo pida.',
    subtitle: 'Todos los planes tienen los módulos que usa la mayoría y todas las voces de texto a voz.',
    perMonth: '/mes',
    credits: '{{credits}} créditos de IA al mes',
    cueFree: '{{n}} de {{total}} módulos, sin tarjeta',
    cuePaid: '{{times}}× los créditos de Free · {{perDollar}}k créditos por $1',
    best: 'Más créditos de IA por dólar',
    recommended: 'Encaja con lo que elegiste',
    free1: '{{n}} de {{total}} módulos: alertas, texto a voz, moderación, tienda de Bits, ruleta…',
    free2: 'Todas las voces de texto a voz',
    free3: 'Comandos con 5 segundos de cooldown mínimo',
    premium1: 'Añade {{modules}}',
    premium2: '250 MB de almacenamiento privado, subidas de 25 MB',
    premium3: '180 días de historial de directos',
    pro1: 'Todo lo de Premium',
    pro2: '1 GB de almacenamiento privado, subidas de 100 MB',
    pro3: 'Cooldowns de 1 segundo, 365 días de historial',
    ctaFree: 'Empieza gratis',
    ctaPremium: 'Empieza con Premium',
    ctaPro: 'Empieza con Pro',
    compare: 'Comparar todos los límites',
    compareNote: 'Los créditos no se acumulan. Puedes comprar créditos extra en cualquier plan.',
    capability: 'Función',
    rows: {
      credits: 'Créditos de IA al mes',
      cooldown: 'Cooldown mínimo de comandos',
      storage: 'Almacenamiento privado',
      upload: 'Subida más grande',
      bandwidth: 'Ancho de banda',
      history: 'Historial de analíticas',
      memory: 'Memoria del chat',
      none: 'Ninguno',
      unlimited: 'Ilimitado (uso justo)',
      days: '{{n}} días',
      sec: '{{n}} s'
    }
  },
  modules: {
    'chat-events': ['Eventos de chat', 'Agradece follows, subs, raids y Bits en el chat'],
    moderation: ['Moderación del chat', 'Filtros e IA que quitan spam e insultos'],
    clips: ['Clips', 'El chat clipea con !clip, los shout-outs ponen un clip'],
    dimafx: ['Tienda de Bits DimaFX', 'El chat gasta Bits para poner sonidos y videos'],
    redemptions: ['Canjes', 'Recompensas de puntos de canal que hacen cosas'],
    triggers: ['Triggers', 'Sonidos y videos en OBS desde comandos o recompensas'],
    tts: ['Texto a voz', 'Mensajes en voz alta, todas las voces en todos los planes'],
    referrals: ['Referidos', 'Invita streamers y gana créditos'],
    'ai-personality': ['Copiloto IA', 'Una personalidad de chat que escribes tú'],
    memories: ['Recuerdos', 'Lo que el bot recuerda, lo apruebas tú'],
    'follow-defense': ['Follow Defense', 'Frena avalanchas de bots de follows y hate raids'],
    'stream-summaries': ['Resúmenes', 'Números y un resumen con IA tras cada directo'],
    library: ['Biblioteca', 'Sonidos, videos e imágenes compartidos'],
    'clip-recommendations': ['Buscador de clips', 'La IA te señala momentos para clipear'],
    roulette: ['Ruleta', 'Ruletas, carretes y cartas en el directo'],
    overlays: ['Overlay Studio', 'Diseña alertas y overlays en el navegador'],
    analytics: ['Analíticas', 'Quién chatea, quién vuelve, qué hizo crecer tu canal'],
    'analytics.follows': ['Registro de follows', 'Cada follow y unfollow, con historial'],
    widgets: ['Widgets', 'Duelos y otros juegos en tu overlay'],
    pet: ['Mascota', 'Un compañero con voz y personalidad propias']
  },
  showcase: {
    kicker: 'Bot de Twitch · alertas · copiloto IA',
    title: 'Todo lo que tu directo necesita,',
    titleAccent: 'en un solo bot.',
    copy: 'Comandos, moderación, alertas, texto a voz, tienda de Bits, juegos y un copiloto con IA. Elige una función y mira lo que verán tus espectadores.',
    secondary: 'Míralo en un directo',
    whyKicker: 'Por qué se cambian',
    whyTitle: 'Un solo login en vez de un montón de herramientas',
    why1Title: 'Todo en un panel',
    why1Copy: 'Bot, alertas, texto a voz, página de propinas y tienda de Bits comparten login, chat y enlaces de OBS.',
    why2Title: 'Cosas que otros bots no hacen',
    why2Copy: 'Un copiloto IA que recuerda a tus habituales, protección contra bots de follows y un buscador de clips que revisa tus VODs.',
    why3Title: 'Tus propinas son tuyas',
    why3Copy: 'Tu página de propinas te envía el 100% de cada propina, menos la comisión de PayPal. No nos quedamos nada.',
    startKicker: 'Cómo empezar',
    startTitle: 'En tu directo en unos 10 minutos',
    s1: 'Entra con Twitch',
    s1Copy: 'Empiezas en Free. Sin tarjeta.',
    s2: 'Activa el bot',
    s2Copy: 'Aprueba los permisos de Twitch y toca "Encender el bot".',
    s3: 'Activa lo que quieras',
    s3Copy: 'Alertas, texto a voz, moderación… lo demás queda apagado.',
    ctaTitle: 'Listo cuando tú lo estés.',
    ctaCopy: 'Entra con Twitch y prueba todo en el plan Free.'
  },
  switch: {
    kicker: '¿Ya tienes un bot?',
    title: 'Tu bot, alertas, texto a voz y tienda de Bits.',
    titleAccent: 'Un solo login.',
    copy: 'DomDimaBot hace lo que hacen tus herramientas actuales y añade un copiloto IA, protección contra bots de follows y un buscador de clips. Pruébalo junto a tu bot actual: nada cambia en el directo hasta que lo actives.',
    coverCommands: 'Comandos ilimitados y timers',
    coverTips: 'Página de propinas, 100% para ti',
    pickTitle: '¿Qué usas hoy?',
    pickHint: 'Toca todo lo que tienes configurado ahora.',
    coverAll: 'Los {{n}} están cubiertos aquí, {{free}} en el plan Free.',
    coverNone: 'Toca lo que usas hoy para ver qué se puede mover.',
    coveredTitle: 'Cubierto aquí',
    extraTitle: 'Y además tendrías',
    uses: {
      commands: 'Comandos y timers',
      moderation: 'Filtros de spam y enlaces',
      alerts: 'Alertas en pantalla',
      tts: 'Texto a voz',
      tips: 'Una página de propinas',
      sounds: 'Sonidos con puntos de canal',
      games: 'Juegos para el chat (duelos, ruletas)',
      bits: 'Una extensión de Bits'
    },
    proofKicker: 'Ya funcionando',
    beyondKicker: 'Más allá de lo básico',
    beyondTitle: 'Lo que no encontrarás en la mayoría de bots',
    b1Title: 'Un copiloto IA que recuerda',
    b1Copy: 'Responde con la personalidad que escribas y recuerda lo que le cuentan tus habituales. Tú apruebas lo que guarda.',
    b2Title: 'Follow Defense',
    b2Copy: 'Detecta avalanchas de bots de follows y hate raids, pausa las alertas y banea a los bots cuando la ola se vuelve un ataque.',
    b3Title: 'Buscador de clips',
    b3Copy: 'Revisa tus directos recientes y te lista los momentos que vale la pena clipear.',
    b4Title: 'Un resumen tras cada directo',
    b4Copy: 'Números, un resumen con IA y lo que aprendió el bot, sin abrir una hoja de cálculo.',
    b1Demo: 'También lo preguntaste el viernes, pancho.',
    b2Demo: '38 follows en 20 s',
    b3Demo: '3 momentos para clipear',
    b4Demo: '+18 seguidores · mejor viernes del mes',
    moveKicker: 'Cambiarse',
    moveTitle: 'Cómo es cambiarse, sin rodeos',
    m1Title: 'Mantén tu bot actual mientras pruebas',
    m1Copy: 'Los dos bots pueden estar en el mismo chat. Si un comando existe en ambos, apágalo en uno para que no responda dos veces.',
    m2Title: 'Vuelve a crear tus comandos',
    m2Copy: 'Aún no hay importador. Empieza por tus 5 comandos más usados; cada uno toma más o menos un minuto.',
    m3Title: 'Pega los enlaces nuevos en OBS',
    m3Copy: 'Alertas, texto a voz y sonidos tienen cada uno un enlace de Browser Source que copias una vez. Quita los viejos cuando estés conforme.',
    m4Title: 'Trae a tus mods',
    m4Copy: 'Da a tus ayudantes acceso solo a las páginas que necesitan. Solo tú puedes encender o apagar el bot.',
    freeKicker: 'Lo que cubre Free',
    freeTitle: '{{n}} de {{total}} módulos están en el plan Free',
    freeCopy: 'Los planes de pago añaden analíticas, duelos y la mascota, más créditos de IA y más almacenamiento.',
    faqTitle: 'Preguntas antes de cambiarte',
    q1: '¿El plan Free es gratis de verdad?',
    a1: 'Sí. Sin tarjeta y sin una prueba que se acabe. Incluye 25.000 créditos de IA al mes para las funciones con IA y el texto a voz.',
    q2: '¿Qué usa créditos de IA?',
    a2: 'El chat con IA, los recuerdos, las voces de texto a voz y el buscador de clips. La voz básica Piper sigue funcionando aunque se acaben los créditos.',
    q3: '¿Habla español?',
    a3: 'Sí. El panel, el bot y sus voces funcionan en español e inglés.',
    ctaTitle: 'Pruébalo junto a tu bot actual.',
    ctaCopy: 'Nada cambia en tu directo hasta que actives algo.'
  },
  start: {
    kicker: 'Configúralo',
    title: 'En directo con tu nuevo bot',
    titleAccent: 'en unos 10 minutos.',
    copy: 'Dinos qué quieres primero. Te mostramos los pasos exactos y lo que verán tus espectadores.',
    goalTitle: '¿Qué quieres primero?',
    goals: {
      safe: ['Un chat seguro', 'Spam, enlaces y bots de follows'],
      tts: ['Leer mensajes en voz alta', 'Texto a voz en el directo'],
      alerts: ['Agradecer follows', 'Alertas en pantalla y en el chat'],
      fun: ['Juegos para el chat', 'Ruleta y duelos'],
      earn: ['Ganar con tu audiencia', 'Tienda de Bits y propinas'],
      ai: ['Un copiloto IA', 'Responde al chat con tu estilo']
    },
    planTitle: 'Tu configuración, paso a paso',
    planTotal: 'Unos {{min}} minutos · todo en el plan Free',
    planTotalPaid: 'Unos {{min}} minutos · los duelos necesitan Premium',
    s1: 'Entra con Twitch',
    s1Copy: 'Usa la cuenta dueña del canal. Empiezas en Free.',
    s2: 'Aprueba los permisos de Twitch',
    s2Copy: 'Toca "Activar Bot" arriba y aprueba. Twitch lista lo que el bot necesita para leer y moderar el chat.',
    s3: 'Enciende el bot',
    s3Copy: 'En el panel toca "Encender el bot". Entra a tu chat al momento.',
    min: '{{n}} min',
    sec: '{{n}} s',
    step: {
      safe: ['Activa la moderación', 'Elige los filtros (enlaces, mayúsculas, spam). Follow Defense vigila las olas de bots de follows.'],
      tts: ['Añade el enlace de voz a OBS', 'Abre Texto a voz, copia el enlace de voz y añádelo a OBS como Browser Source.'],
      alerts: ['Elige tus agradecimientos', 'Abre Eventos de chat y activa follows, subs y raids. Edita los mensajes si quieres.'],
      fun: ['Crea tu primera ruleta', 'Añade unos premios y copia el enlace del overlay en OBS como Browser Source.'],
      earn: ['Instala la extensión DimaFX', 'Añade DimaFX en Twitch, abre el enlace del overlay en OBS y pon unos sonidos a la venta.'],
      ai: ['Escribe la personalidad', 'Abre Copiloto IA, describe cómo habla y lo que nunca debe decir.']
    },
    test: {
      safe: ['Pruébalo', 'Publica un enlace desde otra cuenta. Desaparece.'],
      tts: ['Pruébalo', 'Escribe !s hola chat. Lo oirás en el directo.'],
      alerts: ['Pruébalo', 'Pide a alguien que te siga o espera a tu próximo seguidor.'],
      fun: ['Pruébalo', 'Pulsa Iniciar sorteo en el panel y mira la ruleta.'],
      earn: ['Pruébalo', 'Reproduce un artículo de prueba gratis desde la extensión.'],
      ai: ['Pruébalo', 'Pregúntale algo a @DomDimaBot en el chat.']
    },
    cta: 'Empieza gratis y configúralo',
    preview: 'Lo que verán tus espectadores',
    finderKicker: '¿Qué plan necesito?',
    finderTitle: 'Responde tres preguntas',
    q1: '¿Quieres duelos o una mascota en el directo?',
    q2: '¿Quieres analíticas de quién vuelve y quién te sigue?',
    q3: '¿Cuánto hablará la IA o leerá voces con IA?',
    q3a: 'Poco',
    q3b: 'Cada directo',
    q3c: 'Todo el tiempo',
    yes: 'Sí',
    no: 'No',
    resultFree: 'Free cubre todo lo que elegiste.',
    resultPremium: 'Te encaja Premium: {{why}}.',
    resultPro: 'Te encaja Pro: {{why}}.',
    whyGames: 'duelos y mascota',
    whyAnalytics: 'analíticas',
    whyAi: '200.000 créditos de IA al mes',
    whyAiPro: '800.000 créditos de IA al mes',
    resultNote: 'Puedes empezar en Free y mejorar después; no pierdes nada.',
    laterKicker: 'Después',
    laterTitle: 'Todo lo demás que puedes activar',
    laterCopy: 'Cada módulo, su plan y qué tan terminado está. Alpha significa nuevo y todavía cambiando.',
    modulesCount: '{{n}} módulos',
    groups: {
      engagement: 'Diversión para el chat',
      automation: 'Que todo funcione',
      content: 'Clips y resúmenes'
    },
    ctaTitle: 'Tu bot está a 10 minutos.',
    ctaCopy: 'Entra con Twitch. Puedes cambiarlo todo después.'
  }
};

const COPY: Record<'en' | 'es', Copy> = { en: EN, es: ES };

/** Walks dotted keys; a leaf whose own name has a dot (module id "analytics.follows") still resolves. */
function resolve(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Copy;
  if (key in obj) return obj[key];
  const dot = key.indexOf('.');
  return dot < 0 ? undefined : resolve(obj[key.slice(0, dot)], key.slice(dot + 1));
}

@Injectable({ providedIn: 'root' })
export class LpCopy {
  private readonly language = inject(LanguageService);

  readonly lang = this.language.currentLanguage;

  t(key: string, params?: Record<string, string | number>): string {
    const lang = this.language.currentLanguage() === 'es' ? 'es' : 'en';
    const raw = resolve(COPY[lang], key) ?? resolve(EN, key);
    let text = typeof raw === 'string' ? raw : key;
    for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{{${k}}}`, String(v));
    return text;
  }

  /** Two-part entries such as module [name, one-liner]. */
  pair(key: string): [string, string] {
    const lang = this.language.currentLanguage() === 'es' ? 'es' : 'en';
    const raw = resolve(COPY[lang], key) ?? resolve(EN, key);
    return Array.isArray(raw) ? [raw[0], raw[1]] : [key, ''];
  }

  number(n: number): string {
    return n.toLocaleString(this.language.currentLanguage() === 'es' ? 'es-ES' : 'en-US');
  }
}
