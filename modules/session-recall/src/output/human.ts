import type { AroundPayload, ReadPayload, SearchResultPayload, ShapedMessage, SyncResult } from "../types.js";

export function formatSyncResult(result: SyncResult): string {
  const lines = [
    `Indexed ${result.files.indexed} files, updated ${result.files.updated}, unchanged ${result.files.unchanged}`,
    `Sessions: +${result.sessions.inserted} / updated ${result.sessions.updated}`,
    `Messages: +${result.messages.inserted} / updated ${result.messages.updated}`,
    `State: ${result.stateDir}`,
  ];
  if (result.dryRun) {
    lines.unshift("Dry run");
  }
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

export function formatSearchResult(result: SearchResultPayload): string {
  if (result.results.length === 0) {
    const warnings = result.warnings.length ? `\n${result.warnings.map((warning) => `warning: ${warning}`).join("\n")}` : "";
    return `No results for ${JSON.stringify(result.query)}.${warnings}`;
  }
  const lines: string[] = [];
  result.results.forEach((entry, index) => {
    lines.push(
      `${index + 1}. ${entry.updated_at ?? entry.started_at ?? "unknown time"}  ${entry.originator ?? "Codex"}  ${entry.cwd ?? ""}`,
      `   session: ${entry.session_id}   match: #${entry.match_message_ref}   role: ${entry.matched_role}`,
    );
    if (entry.title) {
      lines.push(`   title: ${entry.title}`);
    }
    if (entry.snippet) {
      lines.push(`   snippet: ${entry.snippet}`);
    }
    appendSection(lines, "start", entry.bookend_start);
    appendSection(lines, `around #${entry.match_message_ref}`, entry.messages);
    appendSection(lines, "end", entry.bookend_end);
    lines.push("");
  });
  if (result.warnings.length > 0) {
    lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n").trimEnd();
}

export function formatReadResult(result: ReadPayload): string {
  const lines = [`session: ${result.session_id}`, `messages: ${result.messages.length}/${result.message_count}`];
  if (result.truncated) {
    lines.push(`omitted: ${result.omitted_count}`);
  }
  lines.push("");
  appendMessages(lines, result.messages);
  if (result.warnings.length > 0) {
    lines.push("", ...result.warnings.map((warning) => `warning: ${warning}`));
  }
  return lines.join("\n");
}

export function formatAroundResult(result: AroundPayload): string {
  const lines = [
    `session: ${result.session_id}`,
    `anchor: #${result.anchor_ref}   before: ${result.messages_before}   after: ${result.messages_after}`,
    "",
  ];
  appendMessages(lines, result.messages);
  if (result.warnings.length > 0) {
    lines.push("", ...result.warnings.map((warning) => `warning: ${warning}`));
  }
  return lines.join("\n");
}

function appendSection(lines: string[], label: string, messages: ShapedMessage[]): void {
  if (messages.length === 0) {
    return;
  }
  lines.push("", `   ${label}:`);
  appendMessages(lines, messages, "     ");
}

function appendMessages(lines: string[], messages: ShapedMessage[], indent = ""): void {
  for (const message of messages) {
    const marker = message.anchor ? ">" : " ";
    const role = message.role.padEnd(9, " ");
    const tool = message.tool_name ? ` ${message.tool_name}:` : "";
    const content = oneLine(message.content);
    lines.push(`${indent}${marker} #${String(message.seq).padEnd(4, " ")} ${role}${tool} ${content}`);
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
