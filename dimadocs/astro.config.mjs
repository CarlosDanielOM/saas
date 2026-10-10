import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const page = (slug, label, es, extra = {}) => ({ label, translations: { es }, slug, ...extra });
const alpha = { text: { en: 'Alpha', es: 'Alfa' }, variant: 'caution' };

// Grouped by what a streamer is trying to do, not by internal module names.
const sidebar = [
  {
    label: 'Start here',
    translations: { es: 'Empieza aquí' },
    items: [
      page('getting-started', 'Getting started', 'Primeros pasos'),
      page('dashboard', 'Dashboard tour', 'Recorrido por el panel'),
      page('modules', 'Modules', 'Módulos'),
      page('plans', 'Plans & credits', 'Planes y créditos'),
    ],
  },
  {
    label: 'Chat & commands',
    translations: { es: 'Chat y comandos' },
    items: [
      page('commands', 'Which command page?', '¿Qué página de comandos?'),
      page('commands/built-in', 'Built-in commands', 'Comandos integrados'),
      page('commands/overview', 'Custom commands & timers', 'Comandos personalizados y temporizadores'),
      {
        label: 'Advanced commands (AST)',
        translations: { es: 'Comandos avanzados (AST)' },
        collapsed: true,
        items: [
          page('commands/advanced', 'Introduction', 'Introducción'),
          page('commands/advanced/syntax', 'Syntax', 'Sintaxis'),
          page('commands/advanced/functions', 'Functions', 'Funciones'),
          page('commands/advanced/execution', 'How it runs', 'Cómo se ejecuta'),
          page('commands/advanced/recipes', 'Recipes', 'Recetas'),
        ],
      },
      page('chat-events', 'Chat events', 'Eventos del chat'),
    ],
  },
  {
    label: 'Alerts, sound & overlays',
    translations: { es: 'Alertas, sonido y overlays' },
    items: [
      page('triggers', 'Triggers & media', 'Disparadores y medios'),
      page('media-library', 'Media library', 'Biblioteca de medios'),
      page('tts', 'Text to speech', 'Texto a voz'),
      page('overlay-studio', 'Overlay Studio', 'Estudio de overlays', { badge: alpha }),
      page('roulette', 'Roulette', 'Ruleta', { badge: { text: { en: 'Alpha · Premium', es: 'Alfa · Premium' }, variant: 'caution' } }),
      page('dimafx', 'DimaFX extension', 'Extensión DimaFX'),
    ],
  },
  {
    label: 'Channel points',
    translations: { es: 'Puntos del canal' },
    items: [
      page('rewards', 'Channel rewards', 'Recompensas del canal'),
      page('redemptions', 'Redemptions', 'Canjes'),
    ],
  },
  {
    label: 'AI features',
    translations: { es: 'Funciones de IA' },
    items: [
      page('ai-personality', 'AI personality', 'Personalidad IA'),
      page('memories', 'Memories', 'Memorias'),
      page('stream-summaries', 'Stream summaries', 'Resúmenes de transmisiones'),
      page('clip-recommendations', 'Clip recommendations', 'Recomendaciones de clips'),
    ],
  },
  {
    label: 'Safety',
    translations: { es: 'Seguridad' },
    items: [
      page('follow-defense', 'Follow defense', 'Defensa de follows'),
      page('moderation', 'Chat moderation', 'Moderación del chat'),
    ],
  },
  {
    label: 'Growth & stats',
    translations: { es: 'Crecimiento y estadísticas' },
    items: [
      page('analytics', 'Analytics & follow ledger', 'Analíticas y registro de seguidores'),
      page('clips', 'Clips', 'Clips'),
      page('referrals', 'Referrals', 'Referidos'),
    ],
  },
  {
    label: 'Help',
    translations: { es: 'Ayuda' },
    items: [page('ai-assistants', 'Use with AI assistants', 'Usar con asistentes de IA')],
  },
];

export default defineConfig({
  site: 'https://docs.domdimabot.com',
  // The installed Starlight MDX integration reads this legacy flag directly.
  // Keep tables enabled in HTML as well as in the plain-text exports.
  markdown: { gfm: true },
  integrations: [
    starlight({
      title: 'DomDimaBot Docs',
      description:
        'Guides for DomDimaBot — Twitch commands, rewards, TTS, triggers, AI personality, stream protection, Premium Alpha Roulette, and Free Alpha Overlay Studio.',
      defaultLocale: 'root',
      locales: {
        root: {
          label: 'English',
          lang: 'en',
        },
        es: {
          label: 'Español',
          lang: 'es',
        },
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/DocsHead.astro',
        Footer: './src/components/DocsFooter.astro',
        PageFrame: './src/components/DocsPageFrame.astro',
        PageTitle: './src/components/DocsPageTitle.astro',
      },
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.googleapis.com',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: true,
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap',
          },
        },
      ],
      logo: {
        light: './src/assets/logo.png',
        dark: './src/assets/logo-dark.png',
        alt: 'DomDimaBot',
        replacesTitle: true,
      },
      favicon: '/favicon.png',
      social: [
        {
          icon: 'twitch',
          label: 'Twitch',
          href: 'https://twitch.tv/domdimabot',
        },
      ],
      sidebar,
      pagination: true,
      lastUpdated: false,
      expressiveCode: {
        themes: ['github-dark-dimmed', 'github-light'],
        styleOverrides: {
          borderRadius: '0.75rem',
          borderWidth: '1px',
          frames: {
            shadowColor: 'transparent',
          },
        },
      },
    }),
  ],
});
