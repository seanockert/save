const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  'msclkid',
  'hsa_cam', 'hsa_grp', 'hsa_mt', 'hsa_src', 'hsa_ad', 'hsa_acc',
  'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol', 'hsa_kw',
  'mc_cid', 'mc_eid',
  '_ga', '_gl', 'yclid', 'twclid',
  '_hsenc', '_hsmi', 'vero_id',
  'ref', 'ref_src', 'ref_url',
]);

export function sanitizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) {
      url.searchParams.delete(key);
    }
  }

  url.hostname = url.hostname.toLowerCase();

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.hash = '';

  return url.toString();
}

export function extractDomain(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}
