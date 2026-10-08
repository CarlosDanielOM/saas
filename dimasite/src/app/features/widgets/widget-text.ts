import en from '../../../assets/i18n/en.json';
import es from '../../../assets/i18n/es.json';

/** OBS follows the broadcaster's saved overlay language, independent of the browser's language. */
export function widgetText(language: 'en' | 'es', key: string, params?: Record<string, string | number>): string {
  let value: unknown = (language === 'es' ? es : en).widgets;
  for (const part of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  const text = typeof value === 'string' ? value : key;
  return Object.entries(params ?? {}).reduce((result, [name, content]) => result.replaceAll(`{{${name}}}`, String(content)), text);
}
