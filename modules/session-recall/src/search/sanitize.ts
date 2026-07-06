export const MAX_FTS5_QUERY_CHARS = 512;

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

export function sanitizeFts5Query(query: string): string {
  const trimmed = query.trim().slice(0, MAX_FTS5_QUERY_CHARS);
  if (!trimmed) {
    return "";
  }

  const tokens = tokenizeQuery(trimmed)
    .map((token) => sanitizeToken(token))
    .filter(Boolean)
    .filter((token) => !/^(AND|OR|NOT)$/i.test(token));

  return tokens.join(" ").trim();
}

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function countCjk(text: string): number {
  return [...text].filter((char) => CJK_RE.test(char)).length;
}

export function buildCjkFallbackTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter((term) => containsCjk(term) && term.length <= 8))];
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const char of query) {
    if (char === '"') {
      inQuote = !inQuote;
      if (!inQuote && current.trim()) {
        tokens.push(`"${current.trim()}"`);
        current = "";
      }
      continue;
    }
    if (!inQuote && /\s/.test(char)) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    tokens.push(inQuote ? current.trim() : current.trim());
  }
  return tokens;
}

function sanitizeToken(token: string): string {
  const raw = token.replace(/^\*+/, "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return quotePhrase(raw.slice(1, -1));
  }
  const cleaned = raw.replace(/[+{}():"^]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (/[-_.:/\\]/.test(cleaned) || cleaned.includes(" ")) {
    return quotePhrase(cleaned);
  }
  return cleaned.replace(/[^\p{L}\p{N}_*]/gu, "");
}

function quotePhrase(value: string): string {
  const cleaned = value.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? `"${cleaned}"` : "";
}
