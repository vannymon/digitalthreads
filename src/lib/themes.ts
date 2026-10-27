import type { Analysis, Link, Shot, Theme } from "./types";

/**
 * Local theme extraction. No network, no API key.
 *
 * The idea: a theme is a phrase that shows up across several screenshots but
 * isn't so common it says nothing. That's tf-idf with the document set being
 * the batch itself, which works because a batch of saved inspiration is
 * already a narrow slice of the world.
 */

const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been
  before being below between both but by can cannot could couldn't did didn't do does
  doesn't doing don't down during each few for from further had hadn't has hasn't have
  haven't having he her here hers herself him himself his how i if in into is isn't it
  its itself just let's me more most mustn't my myself no nor not of off on once only or
  other ought our ours ourselves out over own same shan't she should shouldn't so some
  such than that the their theirs them themselves then there these they this those
  through to too under until up very was wasn't we were weren't what when where which
  while who whom why with won't would wouldn't you your yours yourself yourselves
  get got also like new now one two get make made via see new said says will can
  am pm ago min mins hour hours day days week weeks month months year years
  likes comments shares share save saved follow following followers reply replies
  view views post posts photo photos video videos story stories link bio app
  https http www com net org amp don isn doesn didn couldn shouldn wouldn`
    .split(/\s+/)
    .filter(Boolean),
);

const MIN_DOC_FREQ = 2;

/** A themes list longer than the batch is noise, not insight. */
function themeBudget(batchSize: number) {
  return Math.min(18, Math.max(6, Math.round(batchSize * 1.4)));
}

/** True when `inner` appears inside `outer` as a whole word run. */
function isSubphrase(inner: string, outer: string) {
  return inner !== outer && ` ${outer} `.includes(` ${inner} `);
}

/** Share of words two phrases have in common, 0-1. */
function wordOverlap(a: string, b: string) {
  const wa = new Set(a.split(" "));
  const wb = new Set(b.split(" "));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 2 && w.length < 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Word runs plus 2- and 3-word phrases, so "cold brew" survives as one idea. */
function candidates(tokens: string[]): string[] {
  const out: string[] = [...tokens];
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      out.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return out;
}

/**
 * Capitalised runs in the raw text — brands, people, product names. These are
 * the most useful nodes in an inspiration batch, so they get a boost later.
 */
function properNouns(text: string): Set<string> {
  const found = new Set<string>();
  const re = /\b([A-Z][\p{L}&.'-]+(?:\s+[A-Z][\p{L}&.'-]+){0,2})\b/gu;
  for (const m of text.matchAll(re)) {
    const phrase = m[1].trim().toLowerCase();
    const words = phrase.split(/\s+/);
    if (words.every((w) => STOPWORDS.has(w))) continue;
    if (phrase.length < 3) continue;
    found.add(phrase);
  }
  return found;
}

/**
 * Warm and muted, leaning towards the red of the threads. Saturated colour is
 * reserved for the connections themselves, so these stay quiet enough that a
 * node ring never competes with a line.
 */
export const PALETTE = [
  "#b2435a", "#8c7a6b", "#a96a53", "#7d8b87", "#c08552",
  "#9c5c6e", "#6f7d94", "#ae8f6f", "#84616b", "#95a08c",
  "#bf6f5c", "#77707f", "#a8847a", "#8a9aa4", "#b58b6a",
  "#6e6a63", "#c2918c", "#97745e",
];

function slug(label: string) {
  return label.replace(/\s+/g, "-");
}

export function analyseLocally(shots: Shot[]): Analysis {
  const usable = shots.filter((s) => s.status === "done" && s.text.trim().length > 0);
  if (usable.length < 2) return { themes: [], links: [], summary: null, source: "local" };

  // Per-shot candidate phrase counts, plus the proper nouns we saw in each.
  const perShot = usable.map((shot) => {
    const counts = new Map<string, number>();
    for (const c of candidates(tokenize(shot.text))) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const nouns = properNouns(shot.text);
    const nounWords = new Set([...nouns].flatMap((p) => p.split(/\s+/)));
    return { shot, counts, nounWords };
  });

  // Document frequency across the batch.
  const docFreq = new Map<string, number>();
  for (const { counts } of perShot) {
    for (const phrase of counts.keys()) {
      docFreq.set(phrase, (docFreq.get(phrase) ?? 0) + 1);
    }
  }

  const n = usable.length;
  const scored: { phrase: string; score: number; df: number; shotIds: string[] }[] = [];

  for (const [phrase, df] of docFreq) {
    if (df < MIN_DOC_FREQ) continue;
    // A phrase in nearly everything is the batch's wallpaper, not a theme.
    if (df > Math.max(2, n * 0.8)) continue;

    const holders = perShot.filter((p) => p.counts.has(phrase));
    const avgTf = holders.reduce((a, p) => a + (p.counts.get(phrase) ?? 0), 0) / holders.length;
    const idf = Math.log(n / df) + 1;
    const words = phrase.split(" ");
    const lengthBonus = 1 + (words.length - 1) * 0.45;

    // Scored per word, so "japanese joinery" isn't beaten by bare "japanese"
    // just because only the first word is capitalised.
    const nounFraction =
      words.filter((w) => holders.some((p) => p.nounWords.has(w))).length / words.length;
    const nounBonus = 1 + 0.6 * nounFraction;

    scored.push({
      phrase,
      score: df * Math.log(1 + avgTf) * idf * lengthBonus * nounBonus,
      df,
      shotIds: holders.map((p) => p.shot.id),
    });
  }

  // Phrases covering exactly the same screenshots describe one idea, so keep
  // only the fullest wording of it — "japanese joinery" over "japanese".
  const bySignature = new Map<string, typeof scored>();
  for (const cand of scored) {
    const key = [...cand.shotIds].sort().join("|");
    const group = bySignature.get(key) ?? [];
    group.push(cand);
    bySignature.set(key, group);
  }

  const maximal = [...bySignature.values()].flatMap((group) =>
    group.filter(
      (cand) => !group.some((other) => isSubphrase(cand.phrase, other.phrase)),
    ),
  );

  maximal.sort((a, b) => b.score - a.score);

  // Drop a phrase that is just a fragment of a stronger one covering the same
  // screenshots — "brew" dies so "cold brew" can live.
  const budget = themeBudget(n);
  const kept: typeof scored = [];
  for (const cand of maximal) {
    const redundant = kept.some((k) => {
      const shotOverlap =
        cand.shotIds.filter((id) => k.shotIds.includes(id)).length /
        Math.min(cand.shotIds.length, k.shotIds.length);
      if (shotOverlap <= 0.7) return false;
      // Either one wording wraps the other, or they're sliding windows over
      // the same sentence ("coarse grind ratio" / "grind ratio ethiopian").
      return (
        isSubphrase(cand.phrase, k.phrase) ||
        isSubphrase(k.phrase, cand.phrase) ||
        wordOverlap(cand.phrase, k.phrase) >= 0.5
      );
    });
    if (!redundant) kept.push(cand);
    if (kept.length >= budget) break;
  }

  const top = kept[0]?.score ?? 1;
  const themes: Theme[] = kept.map((k, i) => ({
    id: slug(k.phrase),
    // The keyword pass can only return phrases it found, never a category —
    // that needs a model. Sentence case at least makes it sit beside one.
    label: k.phrase.charAt(0).toUpperCase() + k.phrase.slice(1),
    weight: Math.min(1, k.score / top),
    shotIds: k.shotIds,
    color: PALETTE[i % PALETTE.length],
  }));

  return { themes, links: buildLinks(usable, themes), summary: null, source: "local" };
}

/**
 * Two screenshots are linked when they share themes. Weight is the combined
 * strength of what they share, so a shared rare theme counts for more than a
 * shared obvious one.
 */
export function buildLinks(shots: Shot[], themes: Theme[]): Link[] {
  const byShot = new Map<string, Theme[]>();
  for (const theme of themes) {
    for (const id of theme.shotIds) {
      const list = byShot.get(id) ?? [];
      list.push(theme);
      byShot.set(id, list);
    }
  }

  const raw: Link[] = [];
  const ids = shots.map((s) => s.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byShot.get(ids[i]) ?? [];
      const b = byShot.get(ids[j]) ?? [];
      const shared = a.filter((t) => b.some((o) => o.id === t.id));
      if (!shared.length) continue;
      raw.push({
        source: ids[i],
        target: ids[j],
        weight: shared.reduce((acc, t) => acc + t.weight, 0),
        sharedThemeIds: shared.map((t) => t.id),
      });
    }
  }

  if (!raw.length) return [];

  // At 50 nodes everything-connects-to-everything is a hairball. Keep each
  // node's three best links and throw away the rest.
  const perNode = new Map<string, Link[]>();
  for (const link of raw) {
    for (const end of [link.source, link.target]) {
      const list = perNode.get(end) ?? [];
      list.push(link);
      perNode.set(end, list);
    }
  }

  const survivors = new Set<Link>();
  for (const list of perNode.values()) {
    list.sort((a, b) => b.weight - a.weight);
    for (const link of list.slice(0, 3)) survivors.add(link);
  }

  const max = Math.max(...raw.map((l) => l.weight));
  return [...survivors].map((l) => ({ ...l, weight: l.weight / max }));
}
