import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const sidebar = [
  {
    label: 'Start here',
    translations: { es: 'Empieza aquí' },
    items: [
      {
        label: 'Getting Started',
        translations: { es: 'Primeros pasos' },
        slug: 'getting-started',
      },
      {
        label: 'Dashboard',
        translations: { es: 'Panel de control' },
        slug: 'dashboard',
      },
    ],
  },
  {
    label: 'Features',
    translations: { es: 'Funciones' },
    items: [
      {
        label: 'Commands',
        translations: { es: 'Comandos' },
        slug: 'commands',
      },
      {
        label: 'Text to Speech',
        translations: { es: 'Texto a voz' },
        slug: 'tts',
      },
      {
        label: 'Channel Rewards',
        translations: { es: 'Recompensas del canal' },
        slug: 'rewards',
      },
      {
        label: 'Triggers & Media',
        translations: { es: 'Disparadores y medios' },
        slug: 'triggers',
      },
      {
        label: 'AI Personality',
        translations: { es: 'Personalidad IA' },
        slug: 'ai-personality',
      },
      {
        label: 'Follow Defense',
        translations: { es: 'Defensa de follows' },
        slug: 'follow-defense',
      },
    ],
  },
  {
    label: 'Commands guide',
    translations: { es: 'Guía de comandos' },
    items: [
      {
        label: 'Overview',
        translations: { es: 'Resumen' },
        slug: 'commands/overview',
      },
      {
        label: 'Advanced (AST)',
        translations: { es: 'Avanzado (AST)' },
        collapsed: true,
        items: [
          {
            label: 'Introduction',
            translations: { es: 'Introducción' },
            slug: 'commands/advanced',
          },
          {
            label: 'Syntax',
            translations: { es: 'Sintaxis' },
            slug: 'commands/advanced/syntax',
          },
          {
            label: 'Functions',
            translations: { es: 'Funciones' },
            slug: 'commands/advanced/functions',
          },
          {
            label: 'Execution',
            translations: { es: 'Ejecución' },
            slug: 'commands/advanced/execution',
          },
          {
            label: 'Recipes',
            translations: { es: 'Recetas' },
            slug: 'commands/advanced/recipes',
          },
        ],
      },
    ],
  },
];

export default defineConfig({
  site: 'https://docs.domdimabot.com',
  integrations: [
    starlight({
      title: 'DomDimaBot Docs',
      description:
        'Guides for DomDimaBot — Twitch commands, rewards, TTS, triggers, AI personality, and stream protection.',
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
