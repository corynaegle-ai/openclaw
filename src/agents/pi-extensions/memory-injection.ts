/**
 * Memory Injection Extension
 *
 * After compaction, queries the swarm memory API to retrieve relevant
 * memories and appends them to the compaction summary.
 *
 * This hooks into session_before_compact to enrich the summary with
 * relevant memories from the database.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";

// Memory API endpoint - configurable via env
const MEMORY_API_URL = process.env.MEMORY_API_URL || "http://134.199.235.140:8000";

interface MemoryResult {
  id: string;
  content: string;
  similarity: number;
  agent_id: string;
  created_at: string;
  tags?: string[];
}

interface MemoryQueryResponse {
  results: MemoryResult[];
}

/**
 * Query the memory API for relevant memories
 */
async function queryMemories(
  query: string,
  agentId: string,
  limit: number = 3,
): Promise<MemoryResult[]> {
  try {
    const response = await fetch(`${MEMORY_API_URL}/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        agent_id: agentId,
        limit,
        min_similarity: 0.7,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(`[memory-injection] Memory API returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as MemoryQueryResponse;
    return data.results || [];
  } catch (error) {
    console.warn(
      `[memory-injection] Failed to query memories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * Format memories into a section to append to compaction summary
 */
function formatMemoriesSection(memories: MemoryResult[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const date = new Date(m.created_at).toISOString().split("T")[0];
    const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
    return `- (${date}${tags}) ${m.content.slice(0, 300)}${m.content.length > 300 ? "..." : ""}`;
  });

  return `\n\n## Retrieved Memories\n${lines.join("\n")}`;
}

/**
 * Extract search query from compaction preparation messages
 */
function extractQueryFromPreparation(
  preparation: SessionBeforeCompactEvent["preparation"],
): string | null {
  const messages = [...preparation.messagesToSummarize, ...(preparation.turnPrefixMessages || [])];

  const textParts: string[] = [];
  for (const msg of messages.slice(-10)) {
    // Look at recent messages
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    const content = (msg as { content?: unknown }).content;

    if (role === "user" || role === "assistant") {
      if (typeof content === "string") {
        textParts.push(content.slice(0, 200));
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
            const text = (block as { text?: unknown }).text;
            if (typeof text === "string") {
              textParts.push(text.slice(0, 200));
            }
          }
        }
      }
    }
  }

  if (textParts.length === 0) return null;
  return textParts.join(" ").slice(0, 500);
}

export default function memoryInjectionExtension(api: ExtensionAPI): void {
  // We can't modify the default compaction-safeguard, but we can hook into
  // session_compact (after compaction) or provide our own session_before_compact.
  //
  // For now, we'll use a simpler approach: register for session_compact and
  // log that we could inject memories. Full integration would require modifying
  // the compaction-safeguard extension.

  api.on("session_compact", (event, _ctx: ExtensionContext) => {
    const summary = event.compactionEntry?.summary ?? "";
    if (!summary) return;

    // Extract query from summary
    const query = summary.slice(0, 500);
    if (!query) return;

    // Query memories (fire and forget for logging)
    void queryMemories(query, "default", 3).then((memories) => {
      if (memories.length > 0) {
        console.log(
          `[memory-injection] Found ${memories.length} relevant memories after compaction`,
        );
        // In a full implementation, we would inject these into the next turn
        // For now, just log them
        for (const m of memories) {
          console.log(`[memory-injection]   - ${m.content.slice(0, 100)}...`);
        }
      }
    });
  });
}
