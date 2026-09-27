import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Error with an HTTP status, thrown by route handlers. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, message);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  times: '×', deg: '°', yen: '¥', euro: '€',
};

/** Decodes the HTML entities WordPress puts in rendered titles, term names, etc. */
export function decodeEntities(str) {
  if (str == null) return '';
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent) => {
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const code = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

/** Strips tags and decodes entities: "<b>A &amp; B</b>" -> "A & B". */
export function htmlToText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits "a, b，c\nd" (or an array) into a de-duplicated list of trimmed names. */
export function parseList(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(/[,，、\n]/);
  return [...new Set(parts.map((s) => String(s).trim()).filter(Boolean))];
}

/** Runs worker over items with at most `concurrency` in flight. Worker errors propagate. */
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
