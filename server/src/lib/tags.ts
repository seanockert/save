// Semantic tags (purpose/topic, not brand) via a small Workers AI model.
export const TAG_MODEL = '@cf/meta/llama-3.2-3b-instruct';

const MAX_TAGS = 2;
const MAX_TAG_LENGTH = 24;
// Only established, shared categories are shown to the model, so it reuses the
// vocabulary that already recurs rather than the long tail of one-off tags.
const MAX_EXISTING_SHOWN = 40;
// Notes can be long; the start is enough to categorise.
const MAX_DESCRIPTION_LENGTH = 1500;

// A curated set of broad, single-word browsing categories. These are trusted:
// the model is steered toward them, and they're exempt from the novelty gates
// in normaliseTags (so e.g. "design" survives even on a dribbble.com/design
// page). They also bootstrap the vocabulary on a fresh account. Keep these
// broad and reusable — a good seed applies to dozens of unrelated pages.
const SEED_CATEGORIES = [
  'design', 'tutorial', 'reference', 'tool', 'game', 'news', 'article',
  'research', 'video', 'audio', 'music', 'podcast', 'recipe', 'engineering',
  'science', 'business', 'finance', 'productivity', 'health', 'education',
  'art', 'communication', 'entertainment', 'reading', 'shopping', 'travel',
  'hardware', 'software',
];
const SEED_SET = new Set(SEED_CATEGORIES);

export interface TagInput {
  url: string;
  domain: string;
  title: string | null;
  description: string | null;
}

function brandFromDomain(domain: string): string {
  const host = domain.replace(/^www\./, '');
  const parts = host.split('.');
  return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) || '';
}

// True if `tag` appears as a whole word in `text`. Word boundaries avoid the
// substring trap (e.g. "ai" inside "domain"/"email") while still catching
// "github" in "github.com" (the dot is a boundary).
function mentionedIn(tag: string, text: string): boolean {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function buildPrompt(input: TagInput, establishedTags: string[]): { system: string; user: string } {
  const system = [
    'You file each saved bookmark under a broad CATEGORY, like a folder that groups many unrelated bookmarks together.',
    'A tag must be a general, reusable, single-word category — something dozens of unrelated pages could share.',
    'Good tags: "design", "tutorial", "reference", "tool", "game", "engineering", "music", "recipe".',
    'NEVER use: names of people, brands, companies, products, tools, technologies, or websites (e.g. "casio", "github", "julia donaldson"); anything already in the title, URL, or description (those are found by searching, not by browsing); or multi-word phrases describing one specific thing (e.g. "signal geometry", "cognitive debt", "mini golf").',
    'Examples: a GitHub repo for a JS game engine -> ["game","engineering"] (not "github", not the repo name). A blog post "Understanding HSV color" -> ["design"] or [] (not "hsv"). A specific product page -> [] unless a broad category clearly fits.',
    'Strongly prefer a category from the preferred list below; only invent a new one when none fit AND it is a broad single word that would apply to many future bookmarks.',
    `Choose 0, 1, or at most ${MAX_TAGS} tags. Prefer fewer. If no broad category clearly fits, return an empty array [].`,
    'Respond with ONLY a JSON array of lowercase strings, e.g. ["tutorial"] or []. No other text.',
  ].join(' ');

  // Established (recurring) categories first — they reflect how this user
  // actually groups things — then seed categories as fallback anchors.
  const preferred: string[] = [];
  const seen = new Set<string>();
  for (const t of [...establishedTags, ...SEED_CATEGORIES]) {
    const tag = t.toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    preferred.push(tag);
    if (preferred.length >= MAX_EXISTING_SHOWN) break;
  }
  const existing = `Preferred broad categories (reuse one of these when it fits):\n${preferred.join(', ')}`;

  const user = [
    existing,
    '',
    // Text notes have no url; their text goes in as the description.
    input.url ? 'Bookmark:' : 'Text note:',
    input.url ? `URL: ${input.url}` : null,
    input.domain ? `Site: ${input.domain}` : null,
    input.title ? `Title: ${input.title}` : null,
    input.description ? `Description: ${input.description.slice(0, MAX_DESCRIPTION_LENGTH)}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { system, user };
}

function parseTags(raw: unknown): string[] {
  let candidates: string[] = [];

  // Workers AI may return `response` as an object/array rather than a string
  // (e.g. structured output), so coerce to text before pattern matching.
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === 'string');
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');

  // Prefer a JSON array if the model returned one.
  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        candidates = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      // fall through
    }
  }

  // Fallback: split on commas/newlines, strip quote/bracket noise.
  if (candidates.length === 0) {
    candidates = text
      .replace(/[[\]"']/g, '')
      .split(/[,\n]/)
      .map((t) => t.trim());
  }

  return candidates;
}

function normaliseTags(candidates: string[], input: TagInput, establishedTags: string[]): string[] {
  const brand = brandFromDomain(input.domain);
  const established = new Set(establishedTags.map((t) => t.toLowerCase()));
  // Trusted vocabulary: seed categories + categories that already recur for
  // this user. Trusted tags bypass the novelty gates below, so broad browsing
  // categories survive even when the word also appears in the page text.
  const trusted = (tag: string) => SEED_SET.has(tag) || established.has(tag);
  // A tag that merely echoes searchable text (title/description/URL) is
  // redundant — the user can already find the page by searching — so a novel
  // tag that appears there is dropped.
  const searchable = `${input.title || ''} ${input.description || ''} ${input.url}`;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const tag = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;
    if (tag === brand || tag === input.domain) continue; // never brand/domain names

    // Strict gates apply only to novel tags the model invented. Trusted
    // categories are always allowed.
    if (!trusted(tag)) {
      if (tag.includes(' ')) continue; // no multi-word one-off phrases
      if (mentionedIn(tag, searchable)) continue; // redundant with search
    }

    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }

  return result;
}

// Returns the tags for a bookmark, or `null` when generation genuinely failed
// (AI error or empty response). An empty array is a valid result meaning "no
// broad category fits" — callers should apply it, clearing stale tags. `null`
// means "couldn't tell", so callers should leave existing tags untouched.
//
// `establishedTags` should be the categories that already recur (used by 2+
// bookmarks), NOT every existing tag — feeding the one-off long tail back in is
// what let low-quality tags reinforce themselves.
export async function generateTags(
  ai: Ai,
  input: TagInput,
  establishedTags: string[]
): Promise<string[] | null> {
  try {
    const { system, user } = buildPrompt(input, establishedTags);
    const res = (await ai.run(TAG_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 60,
      temperature: 0,
    })) as { response?: unknown };

    if (res.response === undefined || res.response === null || res.response === '') {
      console.error('generateTags: empty AI response', { url: input.url });
      return null;
    }
    return normaliseTags(parseTags(res.response), input, establishedTags);
  } catch (err) {
    // best-effort; never block a save — but log so failures aren't silent
    console.error('generateTags: AI call failed', { url: input.url, err: String(err) });
    return null;
  }
}
