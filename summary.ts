// Pure helpers for the opt-in exit summary. No pi imports, so they are
// unit-testable with plain node.

interface ContentBlock {
  type?: string;
  text?: string;
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** Flatten the session tail into `User:` / `Assistant:` lines, capped. */
export function gatherConversationText(entries: SessionEntry[], maxChars = 20_000): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry || entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(entry.message.content).trim();
    if (text.length === 0) continue;
    parts.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export function buildSummaryPrompt(conversationText: string): string {
  return [
    "Extract durable facts from this coding session that are worth remembering in future sessions.",
    "Capture only knowledge that was expensive to obtain: user preferences, decisions, lessons learned, environment quirks, research findings.",
    "Skip trivial or session-specific details, todos, and in-progress work. If nothing is worth remembering, output exactly: NONE",
    "Output at most 6 lines. Each line is ONE concise fact (max ~30 words, one line, max 300 chars) starting with a #tag (#preference, #decision, #lesson, or #fact).",
    "",
    "<session>",
    conversationText,
    "</session>",
  ].join("\n");
}

/** Turn the model's reply into clean fact lines. Overlong lines are dropped. */
export function parseFacts(summaryText: string): string[] {
  const trimmed = summaryText.trim();
  if (trimmed.length === 0 || trimmed.toUpperCase() === "NONE") return [];
  return trimmed
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*[-*]\s*/, "").trim())
    .filter(
      (s) =>
        s.length >= 8 &&
        s.length <= 300 &&
        !s.startsWith("```") &&
        !s.startsWith("# ") &&
        !/^none$/i.test(s) &&
        !/^here are/i.test(s),
    );
}
