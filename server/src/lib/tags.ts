// Semantic tags (purpose/topic, not brand) via a small Workers AI model.
export const TAG_MODEL = '@cf/meta/llama-3.2-3b-instruct';

const MAX_TAGS = 2;
const MAX_TAG_LENGTH = 30;

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

function buildPrompt(input: TagInput, existingTags: string[]): { system: string; user: string } {
  const system = [
    'You label saved bookmarks with 1 or 2 short tags describing the PURPOSE or TOPIC of the page.',
    'Good tags: "design", "recipe", "items for sale", "tutorial", "news", "research", "tool", "video".',
    'NEVER use the website, brand, company, or product name as a tag (e.g. not "twitter", "youtube", "amazon", "github").',
    'Strongly prefer reusing a tag from the existing tag list when one fits; only invent a new tag if none apply.',
    `Return at most ${MAX_TAGS} tags. Respond with ONLY a JSON array of lowercase strings, e.g. ["design","tutorial"]. No other text.`,
  ].join(' ');

  const existing = existingTags.length
    ? `Existing tags to reuse when appropriate:\n${existingTags.join(', ')}`
    : 'Existing tags to reuse when appropriate: (none yet)';

  const user = [
    existing,
    '',
    'Bookmark:',
    `URL: ${input.url}`,
    `Site: ${input.domain}`,
    input.title ? `Title: ${input.title}` : null,
    input.description ? `Description: ${input.description}` : null,
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

function normaliseTags(candidates: string[], input: TagInput): string[] {
  const brand = brandFromDomain(input.domain);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const tag = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;
    if (tag === brand || tag === input.domain) continue; // drop brand/domain names

    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }

  return result;
}

export async function generateTags(
  ai: Ai,
  input: TagInput,
  existingTags: string[]
): Promise<string[]> {
  try {
    const { system, user } = buildPrompt(input, existingTags);
    const res = (await ai.run(TAG_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 60,
      temperature: 0.2,
    })) as { response?: unknown };

    if (res.response === undefined || res.response === null || res.response === '') {
      console.error('generateTags: empty AI response', { url: input.url });
      return [];
    }
    return normaliseTags(parseTags(res.response), input);
  } catch (err) {
    // best-effort; never block a save — but log so failures aren't silent
    console.error('generateTags: AI call failed', { url: input.url, err: String(err) });
    return [];
  }
}
