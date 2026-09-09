/**
 * Matching eBay listings to the app's SKUs.
 *
 * eBay custom labels follow their own scheme (`M-YakCheese-3ct`) rather than
 * the app's (`GLS-15CM-BP1`), and some listings carry no label at all, so an
 * exact join covers only part of the catalogue. Everything else has to be
 * reconciled by hand — the point of `suggestMatch` is to turn that from
 * "search 173 SKUs" into "confirm or reject one proposal".
 *
 * Suggestions are advisory and never applied automatically. Writing a
 * quantity to the wrong product is worse than leaving it unmatched, and a
 * name-similarity score is not evidence enough to move stock on.
 */

export type SkuCandidate = {
  sku: string;
  productName: string | null;
  variantLabel: string | null;
};

export type MatchInput = {
  /** eBay's custom label, possibly empty. */
  sku: string;
  title: string;
  variationLabel: string;
};

/** Lower-case alphanumeric tokens, with size/count units kept intact. */
export function tokenize(text: string): string[] {
  return (text || '')
    // Split camel/pascal runs BEFORE lowercasing — afterwards there is no
    // case boundary left to split on and "YakCheese" stays one token.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 1);
}

/**
 * Words that appear on nearly every listing and so carry no signal. Left in,
 * they make every product look ~40% similar to every other one.
 */
const STOP_WORDS = new Set([
  'dog', 'dogs', 'chew', 'chews', 'treat', 'treats', 'natural', 'gls',
  'for', 'and', 'the', 'with', 'free', 'grain', 'long', 'lasting', 'dental',
  'puppy', 'air', 'dried', 'high', 'protein', 'rawhide', 'sticks', 'stick',
]);

function meaningful(tokens: string[]): Set<string> {
  return new Set(tokens.filter(t => !STOP_WORDS.has(t)));
}

/** Jaccard overlap of the meaningful tokens of two strings. */
export function similarity(a: string, b: string): number {
  const setA = meaningful(tokenize(a));
  const setB = meaningful(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / (setA.size + setB.size - shared);
}

export type Suggestion = {
  sku: string;
  score: number;
  /** How the runner-up scored, so a coin-toss can be told from a clear win. */
  runnerUp: number;
};

/** Minimum overlap before a proposal is worth showing at all. */
export const SUGGEST_MIN_SCORE = 0.25;
/**
 * How far ahead of the runner-up the winner must be.
 *
 * Real listings routinely produce exact ties — several SKUs of the same
 * product differ only by a pack size the title never mentions. A tie means
 * the score is not discriminating, so presenting either one as "the match"
 * invites a confident wrong answer.
 */
export const SUGGEST_MIN_MARGIN = 0.05;

/**
 * Best guess at which app SKU an unmatched eBay listing refers to.
 *
 * Returns null rather than a weak guess: a wrong suggestion that looks
 * confident costs more than no suggestion, because it invites a careless
 * confirmation.
 */
export function suggestMatch(listing: MatchInput, candidates: SkuCandidate[]): Suggestion | null {
  const needle = `${listing.title} ${listing.variationLabel} ${listing.sku}`;

  let best: { sku: string; score: number } | null = null;
  let second = 0;

  for (const candidate of candidates) {
    const hay = `${candidate.productName ?? ''} ${candidate.variantLabel ?? ''} ${candidate.sku}`;
    const score = similarity(needle, hay);
    if (!best || score > best.score) {
      if (best) second = Math.max(second, best.score);
      best = { sku: candidate.sku, score };
    } else if (score > second) {
      second = score;
    }
  }

  if (!best || best.score < SUGGEST_MIN_SCORE) return null;
  if (best.score - second < SUGGEST_MIN_MARGIN) return null;
  return { sku: best.sku, score: Number(best.score.toFixed(3)), runnerUp: Number(second.toFixed(3)) };
}

/** Case-insensitive exact match on the SKU, which is the only match we trust. */
export function buildSkuIndex(skus: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const sku of skus) index.set(sku.trim().toUpperCase(), sku);
  return index;
}
