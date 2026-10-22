import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MEMORY_UPDATE_PROMPT = `Please review durable memory in light of this conversation and update it only where needed. This is an incremental memory reminder, not a request to overhaul or rewrite the memory collection.

- Use the available conversation context (including any compaction summary) to identify durable knowledge that will help in future sessions: established decisions, preferences, hard-won lessons, and confirmed project/server setup or operational details. Save important knowledge you have not already saved.
- Read the current memory with memory_read and use memory_search for relevant topics; read related notes as needed before changing anything. The injected snapshot may be incomplete. Avoid duplicates and preserve unrelated or still-correct information. Do not scan or rewrite every note just for completeness.
- Correct or remove information only when this conversation provides evidence that it is outdated or wrong; age alone or not mentioning it is not evidence. Make the smallest targeted changes. Use memory_forget with a specific identifying string for obsolete facts or notes (deletions are recoverable), memory_write for one-line facts, and memory_store for new detailed notes. For memos with IDs, read by ID and use memory_update to edit the relevant file in place instead of forgetting/recreating facts or creating redundant replacement notes; preserve identity, description and unrelated content. Notes carry their own frontmatter; supply only the revised Markdown body, including any body heading worth keeping. Store migration is automatic; do not manually recreate an index.
- Default to local memory in the current workdir, including server-specific knowledge when working in a context directory such as ~/ctx/server-ABC. When the user requests memory in another workspace, use its root on each tool call, including reads and recovery; root is the workspace directory, not its .pi directory. Use memory_status to inspect a store before initialization, and memory_init only when you intend to create local memory in that existing directory; do not initialize a workspace merely to make a search succeed. Global memory is only for user/machine-wide facts, not particular servers, software, repos, or configs. Keep MEMORY.md for one-line facts only; put detailed knowledge in standalone notes with concise descriptions and chosen filename slugs. The date is prepended automatically; descriptions are injected from frontmatter, not duplicated in MEMORY.md.
- Do not store secrets, credentials, temporary task state, todos, or a transcript/session recap. Work from already available evidence; this command does not authorize remote access or imply that past remote-access permission carries into future sessions.
- If nothing useful needs changing, leave memory untouched. Briefly report what you added, corrected, or removed, or say that no updates were needed.`;

export function registerMemoryCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">,
  buildStatusText: () => Promise<string>,
): void {
  pi.registerCommand("memory", {
    description: "Show memory status, or /memory update to review and incrementally update memory",
    getArgumentCompletions: (prefix) =>
      "update".startsWith(prefix)
        ? [{ value: "update", label: "update", description: "Review this conversation and update memory only if needed" }]
        : null,
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      if (subcommand === "update") {
        // Start a normal turn when idle; otherwise wait for the ongoing work.
        pi.sendUserMessage(MEMORY_UPDATE_PROMPT, { deliverAs: "followUp" });
        return;
      }
      if (subcommand) {
        ctx.ui.notify("Usage: /memory (status) or /memory update", "warning");
        return;
      }
      ctx.ui.notify(await buildStatusText(), "info");
    },
  });
}
