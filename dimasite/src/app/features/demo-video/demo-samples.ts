import type { DemoLang, RawScene } from './demo-scene';

const SPAM_REASON = { file: 'dimabot/src/utils/moderation/spam.ts', quote: 'Selected unwanted chat behavior' };

/**
 * Built-in scenes for the browser preview and the site check. Videos themselves come from
 * marketing/video/scenes/*.json, handed to the player by the recorder (never through the URL).
 */
export const DEMO_SAMPLES: readonly { id: string; label: Record<DemoLang, string>; scene: RawScene }[] = [
  {
    id: 'tour',
    label: { en: 'Feature tour', es: 'Recorrido' },
    scene: {
      id: 'tour', v: 1, seed: 11,
      channel: { name: 'lunatica_v', title: { en: 'Cozy builds and chat games', es: 'Construcciones tranquilas y juegos con el chat' }, game: 'Minecraft', viewers: 87 },
      beats: [
        { do: 'intro', at: 0, dur: 1500, title: { en: 'Your stream, *upgraded*', es: 'Tu stream, *mejorado*' } },
        { do: 'chat', id: 'c1', at: '+200', user: 'taco_fan', badges: ['sub'], text: { en: 'hii chat', es: 'holaaa chat' } },
        { do: 'alert', id: 'a1', at: '+300', event: 'follow', user: 'NovaPlays', sound: 'kit:chime' },
        { do: 'camera', with: 'a1', at: '+0', focus: 'alert' },
        { do: 'caption', with: 'a1', at: '+200', dur: 2800, text: { en: '*Alerts* designed in Overlay Studio', es: '*Alertas* diseñadas en Overlay Studio' } },
        { do: 'event', with: 'a1', at: '+0', icon: 'follow', text: { en: 'NovaPlays followed', es: 'NovaPlays te sigue' } },
        { do: 'camera', after: 'a1', at: '+0', focus: 'full' },
        { do: 'tts', id: 't1', at: '+200', user: 'pixel_pancho', text: { en: 'say hi to my cat Mochi!', es: '¡saluda a mi gato Mochi!' } },
        { do: 'camera', with: 't1', at: '+0', focus: 'tts' },
        { do: 'caption', with: 't1', at: '+200', dur: 2400, text: { en: 'Viewers *talk on stream*', es: 'Tus viewers *hablan en el stream*' } },
        { do: 'camera', after: 't1', at: '+0', focus: 'full' },
        { do: 'roulette', id: 'r1', at: '+200', title: { en: 'Next game', es: 'Siguiente juego' }, items: ['Valorant', 'Fortnite', 'Minecraft', 'Among Us'], winner: 2 },
        { do: 'camera', with: 'r1', at: '+0', focus: 'roulette', zoom: 1.6 },
        { do: 'bot', with: 'r1', at: '+5900', text: { en: 'The roulette picked: Minecraft', es: 'La ruleta eligió: Minecraft' } },
        { do: 'camera', after: 'r1', at: '+0', focus: 'full' },
        { do: 'chat', id: 'spam', at: '+400', user: 'xx_promo_77', first: true, text: 'free followers at b00st-views.example' },
        { do: 'highlight', id: 'hl', with: 'spam', at: '+300', dur: 1400, target: 'spam', label: { en: 'First message', es: 'Primer mensaje' } },
        { do: 'ban', id: 'ban', after: 'hl', at: '+0', target: 'spam' },
        { do: 'bot', with: 'ban', at: '+350', text: '@xx_promo_77 Selected unwanted chat behavior', refs: [SPAM_REASON] },
        { do: 'highlight', with: 'ban', at: '+0', dur: 1600, target: 'chat' },
        { do: 'duel', id: 'd1', at: '+1200', left: 'taco_fan', right: 'NovaPlays' },
        { do: 'caption', with: 'd1', at: '+600', dur: 2600, text: { en: 'Chat *duels*, live', es: '*Duelos* del chat, en vivo' } },
        { do: 'outro', after: 'd1', at: '+200', dur: 2400, title: { en: 'Try it *free*', es: 'Pruébalo *gratis*' } }
      ]
    }
  }
];
