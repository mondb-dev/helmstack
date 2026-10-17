/**
 * Recall: the few passages of a routine's reference library that best match a question.
 *
 * Deterministic keyword ranking (BM25 over overlapping chunks): no network, no embeddings, no
 * model. The same documents and query always give the same passages in the same order. Only the
 * documents handed in are searched; the caller passes ACTIVE documents, so a document an agent
 * proposed and the human has not approved is never seen here.
 */
export const CHUNK_CHARS = 600;
export const CHUNK_OVERLAP = 100;
/** Total characters of passage text handed to a model for one judgment. */
export const RECALL_TOTAL_CHARS = 4_000;
/** Characters of the query (question plus `uses` text) that are looked at. */
export const RECALL_QUERY_CHARS = 2_000;
/** A passage clipped to fit the total must keep at least this much to be worth including. */
const MIN_CLIPPED_CHARS = 80;

const K1 = 1.2;
const B = 0.75;

export type RecallDoc = { id: string; title: string; text: string };
export type Passage = { docId: string; title: string; text: string; score: number };

const STOPWORDS = new Set(
  (
    "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your"
  ).split(" ")
);

/** Lower-case word tokens, stopwords out, a trailing plural "s" trimmed (so "players" matches "player"). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Overlapping windows of about {@link CHUNK_CHARS}, cut at whitespace where one is near. */
export function chunkText(text: string): string[] {
  const clean = text.trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_CHARS);
    if (end < clean.length) {
      const space = clean.lastIndexOf(" ", end);
      const newline = clean.lastIndexOf("\n", end);
      const cut = Math.max(space, newline);
      if (cut > start + CHUNK_CHARS * 0.6) end = cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    let next = end - CHUNK_OVERLAP;
    if (next <= start) next = end;
    // Begin on a word boundary rather than in the middle of a word.
    const boundary = clean.indexOf(" ", next);
    start = boundary >= 0 && boundary < end ? boundary + 1 : next;
  }
  return chunks;
}

type Chunk = { docId: string; title: string; text: string; index: number; terms: Map<string, number>; length: number };

/**
 * The best `topK` passages of `docs` for `query`, best first, at most `maxChars` of passage text in
 * total. Ties break on document order, then position in the document. Passages that share no
 * keyword with the query are never returned.
 */
export function recall(docs: readonly RecallDoc[], query: string, opts: { topK: number; maxChars?: number }): Passage[] {
  const topK = Math.max(1, Math.min(5, Math.floor(opts.topK) || 1));
  const maxChars = Math.max(0, opts.maxChars ?? RECALL_TOTAL_CHARS);
  const queryTerms = [...new Set(tokenize(query.slice(0, RECALL_QUERY_CHARS)))];
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const chunks: Chunk[] = [];
  for (const doc of docs) {
    // The title counts as text of every chunk it heads, so a rule named in the title is findable.
    const titleTerms = tokenize(doc.title);
    chunkText(doc.text).forEach((text, index) => {
      const terms = new Map<string, number>();
      let length = 0;
      for (const t of [...titleTerms, ...tokenize(text)]) {
        terms.set(t, (terms.get(t) ?? 0) + 1);
        length += 1;
      }
      chunks.push({ docId: doc.id, title: doc.title, text, index, terms, length });
    });
  }
  if (chunks.length === 0) return [];

  const avgLength = chunks.reduce((n, c) => n + c.length, 0) / chunks.length || 1;
  const df = new Map<string, number>();
  for (const term of queryTerms) df.set(term, chunks.filter((c) => c.terms.has(term)).length);

  const scored = chunks.map((chunk, order) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.terms.get(term) ?? 0;
      if (tf === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / avgLength)));
    }
    return { chunk, order, score: Math.round(score * 1e6) / 1e6 };
  });

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const out: Passage[] = [];
  let used = 0;
  for (const { chunk, score } of ranked) {
    if (out.length >= topK) break;
    let text = chunk.text;
    const room = maxChars - used;
    if (text.length > room) {
      if (room < MIN_CLIPPED_CHARS) break;
      text = text.slice(0, room).trimEnd();
    }
    used += text.length;
    out.push({ docId: chunk.docId, title: chunk.title, text, score });
  }
  return out;
}
