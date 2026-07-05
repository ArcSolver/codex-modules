// Adapted from opencodex src/reasoning-effort.ts
export const CODEX_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extended reasoning for the hardest problems" },
];

const CODEX_REASONING_ORDER = CODEX_REASONING_LEVELS.map(level => level.effort);
const CODEX_REASONING_SET = new Set(CODEX_REASONING_ORDER);

export function sanitizeCodexReasoningEfforts(efforts: readonly string[] | undefined): string[] | undefined {
  if (efforts === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const effort of efforts) {
    if (!CODEX_REASONING_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.sort((a, b) => CODEX_REASONING_ORDER.indexOf(a) - CODEX_REASONING_ORDER.indexOf(b));
}

