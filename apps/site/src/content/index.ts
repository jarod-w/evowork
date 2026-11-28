import type { Locale, SiteContent } from '../types.js';
import { EN_CONTENT } from './en.js';
import { ZH_CONTENT } from './zh.js';

export function getSiteContent(locale: Locale): SiteContent {
  return locale === 'en' ? EN_CONTENT : ZH_CONTENT;
}
