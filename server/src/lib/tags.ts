import type { OGData } from './opengraph';

export function getAutoTags(url: string, ogData: OGData): string[] {
  if (ogData.siteName) {
    return [ogData.siteName.toLowerCase().trim()];
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^www\./, '');
  const parts = hostname.split('.');
  const brand = parts.length >= 2 ? parts[parts.length - 2] : parts[0];

  return brand ? [brand] : [];
}
