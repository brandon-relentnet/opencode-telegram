/**
 * Detect when an assistant text part is essentially restating the user's
 * prompt back at them.
 *
 * opencode's agent sometimes leads its turn with a paraphrase of the user's
 * request ("You want me to fix the navbar..." or just verbatim quoting).
 * In Telegram this reads as the bot echoing your own message back, which
 * was the #1 friction point in the transparent-mode redesign. Filtering
 * these "echo" parts at the bridge gives the user a clean reading
 * experience without changing the agent's behavior.
 *
 * Heuristic (intentionally simple — false negatives are fine, false
 * positives are bad):
 *
 *   1. If `prompt` is too short (< 8 chars) we don't have enough signal;
 *      return false.
 *   2. If the assistant text CONTAINS the prompt as a contiguous substring
 *      (after lowercasing + whitespace-collapse), it's a verbatim echo.
 *   3. Otherwise, compute Jaccard similarity over word sets. If ≥ 0.7
 *      (i.e. 70%+ of words overlap), treat as paraphrase echo.
 *   4. Cap by length: only filter if the assistant text is at most 3x the
 *      prompt length. Long answers that happen to contain the prompt
 *      wording aren't echoes.
 */

const MIN_PROMPT_CHARS = 8;
const JACCARD_THRESHOLD = 0.7;
const MAX_LENGTH_RATIO = 3;

export function isPromptEcho(assistantText: string, prompt: string | null | undefined): boolean {
  if (!prompt) return false;
  const p = normalize(prompt);
  const a = normalize(assistantText);
  if (p.length < MIN_PROMPT_CHARS) return false;
  if (a.length === 0) return false;
  if (a.length > p.length * MAX_LENGTH_RATIO) return false;

  if (a.includes(p)) return true;

  const sim = jaccard(words(a), words(p));
  return sim >= JACCARD_THRESHOLD;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function words(s: string): Set<string> {
  return new Set(
    s
      .split(/[^a-z0-9]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  return intersect / union;
}
