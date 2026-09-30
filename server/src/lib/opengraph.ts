export interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const CONTENT = `(?:"([^"]*)"|'([^']*)')`;

function extractMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]*(?:property|name)=["']${escaped}["'][^>]*content=${CONTENT}`, 'i'),
    new RegExp(`<meta[^>]*content=${CONTENT}[^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const content = match?.[1] ?? match?.[2];
    if (content) return decodeEntities(content);
  }
  return null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
  '&laquo;': '«', '&raquo;': '»',
  '&reg;': '®', '&trade;': '™', '&copy;': '©', '&hellip;': '…',
  '&bull;': '•', '&middot;': '·',
  '&lsquo;': '‘', '&rsquo;': '’',
  '&ldquo;': '“', '&rdquo;': '”',
  '&times;': '×', '&divide;': '÷',
};

function decodeEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;/g, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity);
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

const SEARCH_ENGINES = new Set([
  'google.com', 'www.google.com', 'google.co.uk', 'www.google.co.uk',
  'google.com.au', 'www.google.com.au',
  'bing.com', 'www.bing.com',
  'duckduckgo.com', 'www.duckduckgo.com',
  'search.yahoo.com',
]);

const GENERIC_TITLES = new Set([
  'google', 'google search', 'bing', 'yahoo search', 'duckduckgo',
  'search results', 'google images',
]);

function extractSearchQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!SEARCH_ENGINES.has(parsed.hostname)) return null;
    return parsed.searchParams.get('q') || parsed.searchParams.get('query') || null;
  } catch {
    return null;
  }
}

const USELESS_TITLES = new Set([
  'error', 'page not found', 'not found', '404', '403', 'forbidden',
  'access denied', 'log in', 'sign in', 'login', 'sorry',
]);

const MAX_HTML_CHARS = 200_000;

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const BOT_UA_DOMAINS = new Set([
  'x.com', 'twitter.com',
  'facebook.com', 'fb.com',
  'instagram.com',
]);

function pickUserAgent(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return BOT_UA_DOMAINS.has(host) ? UA_BOT : UA_BROWSER;
  } catch {
    return UA_BROWSER;
  }
}

function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id || null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      const match = parsed.pathname.match(/^\/(embed|shorts|live)\/([^/?]+)/);
      if (match) return match[2];
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchYouTubeOEmbed(url: string): Promise<OGData | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  try {
    const canonical = `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    return {
      title: (data.title as string) || null,
      description: data.author_name ? `Video by ${data.author_name}` : null,
      image: (data.thumbnail_url as string) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      siteName: 'YouTube',
    };
  } catch {
    return null;
  }
}

async function fetchGenericOG(url: string): Promise<OGData> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: {
      'User-Agent': pickUserAgent(url),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  const reader = res.body?.getReader();
  if (!res.ok || !reader || !res.headers.get('content-type')?.includes('text/html')) {
    reader?.cancel();
    return { title: null, description: null, image: null, siteName: null };
  }

  let html = '';
  const decoder = new TextDecoder();

  while (html.length < MAX_HTML_CHARS && !/<\/head>/i.test(html)) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  reader.cancel();

  let title =
    extractMetaContent(html, 'og:title') ??
    extractMetaContent(html, 'twitter:title') ??
    extractTitle(html);

  if (title && USELESS_TITLES.has(title.trim().toLowerCase())) {
    title = null;
  }

  const searchQuery = extractSearchQuery(url);
  if (searchQuery && (!title || GENERIC_TITLES.has(title.trim().toLowerCase()))) {
    title = `Search: ${searchQuery}`;
  }

  const description =
    extractMetaContent(html, 'og:description') ??
    extractMetaContent(html, 'twitter:description') ??
    extractMetaContent(html, 'description');

  const rawImage =
    extractMetaContent(html, 'og:image') ??
    extractMetaContent(html, 'twitter:image');
  const image = rawImage && resolveUrl(rawImage, url);

  const siteName = extractMetaContent(html, 'og:site_name');

  return { title, description, image, siteName };
}

export function fallbackFromUrl(url: string): OGData {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const segments = parsed.pathname.split('/').filter(Boolean);

    const meaningful = segments.filter(
      (s) => s.length > 1 && !/^[0-9a-f]{10,}$/i.test(s) && !/^\d+$/.test(s)
    );

    let title: string;
    if (meaningful.length) {
      const humanized = meaningful
        .map((s) =>
          s
            .replace(/[-_]+/g, ' ')
            .replace(/\.[^.]+$/, '')
            .replace(/\b\w/g, (c) => c.toUpperCase())
        )
        .join(' / ');
      title = `${humanized} — ${host}`;
    } else {
      title = host;
    }

    return { title, description: null, image: null, siteName: null };
  } catch {
    return { title: url, description: null, image: null, siteName: null };
  }
}

export async function fetchOpenGraph(url: string): Promise<OGData> {
  try {
    const platform = await fetchYouTubeOEmbed(url);
    if (platform?.title && platform.description) return platform;

    const result = await fetchGenericOG(url);
    if (platform) {
      for (const key of Object.keys(platform) as (keyof OGData)[]) {
        result[key] = platform[key] ?? result[key];
      }
    }
    result.title ??= fallbackFromUrl(url).title;
    return result;
  } catch {
    return fallbackFromUrl(url);
  }
}
