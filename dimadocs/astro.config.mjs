import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.domdimabot.com',
  integrations: [
    starlight({
      title: 'DomDimaBot Docs',
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
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
      },
      social: [
        {
          icon: 'twitch',
          label: 'Twitch',
          href: 'https://twitch.tv/domdimabot',
        },
      ],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
      },
    }),
  ],
});
