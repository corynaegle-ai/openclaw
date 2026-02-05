import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";

// =============================================================================
// MEMORY SYSTEM - Store and retrieve memories during compaction
// =============================================================================

const MEMORY_API_URL = process.env.MEMORY_API_URL || "http://134.199.235.140:8000";
const MEMORY_API_KEY = process.env.MEMORY_API_KEY || "3af7aebc2f1714f378580d68eb569a12";
const MEMORY_ENABLED = process.env.MEMORY_RETRIEVAL_ENABLED !== "false";

interface MemoryResult {
  id: string;
  content: string;
  similarity: number;
  created_at: string;
  tags?: string[];
}

interface MemoryQueryResponse {
  results: MemoryResult[];
}

interface WorkInProgress {
  task: string;
  progress: string[];
  pending: string[];
  context: Record<string, string>;
  // Granular fields for rich memory storage
  files_modified: string[];
  commands_run: string[];
  decisions: string[];
  next_steps: string[];
  error_states: string[];
}

// -----------------------------------------------------------------------------
// Memory Query - Retrieve relevant memories
// -----------------------------------------------------------------------------

async function queryRelevantMemories(query: string, signal?: AbortSignal): Promise<MemoryResult[]> {
  if (!MEMORY_ENABLED) return [];
  try {
    const response = await fetch(`${MEMORY_API_URL}/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": MEMORY_API_KEY },
      body: JSON.stringify({ query: query.slice(0, 1000), limit: 3, min_similarity: 0.7 }),
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as MemoryQueryResponse;
    return data.results || [];
  } catch {
    return [];
  }
}

function extractMemoryQuery(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-10)) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content.slice(0, 300));
  }
  return parts.join(" ").slice(0, 1000);
}

function formatMemoriesSection(memories: MemoryResult[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const date = new Date(m.created_at).toISOString().split("T")[0];
    return `- (${date}) ${m.content.slice(0, 400)}`;
  });
  return `\n\n<retrieved-memories>\n${lines.join("\n")}\n</retrieved-memories>`;
}

// -----------------------------------------------------------------------------
// Memory Store - Save work-in-progress before compaction
// -----------------------------------------------------------------------------

async function storeWorkInProgressMemory(
  wip: WorkInProgress,
  agentId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!MEMORY_ENABLED) return false;

  const lines: string[] = [`[COMPACTION WIP] Task: ${wip.task}`];

  if (wip.progress.length > 0) {
    lines.push(`Progress: ${wip.progress.join("; ")}`);
  }
  if (wip.pending.length > 0) {
    lines.push(`Pending: ${wip.pending.join("; ")}`);
  }
  if (Object.keys(wip.context).length > 0) {
    const contextParts = Object.entries(wip.context).map(([k, v]) => `${k}=${v}`);
    lines.push(`Context: ${contextParts.join(", ")}`);
  }

  const content = lines.join(" | ");

  // Build the memory payload with granular fields
  const payload: Record<string, unknown> = {
    agent_id: agentId,
    content,
    tags: ["compaction", "wip", "auto"],
  };

  // Add granular fields if they have content
  if (wip.files_modified.length > 0) {
    payload.files_modified = wip.files_modified;
  }
  if (wip.commands_run.length > 0) {
    payload.commands_run = wip.commands_run;
  }
  if (wip.decisions.length > 0) {
    payload.decisions = wip.decisions;
  }
  if (wip.next_steps.length > 0) {
    payload.next_steps = wip.next_steps;
  }
  if (wip.error_states.length > 0) {
    payload.error_states = wip.error_states;
  }

  try {
    const response = await fetch(`${MEMORY_API_URL}/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": MEMORY_API_KEY },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (response.ok) {
      console.log(`[memory-store] Saved WIP memory for agent ${agentId} with granular fields`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractMessageText(msg: AgentMessage): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function extractWorkInProgress(
  messages: AgentMessage[],
  fileOps: { readFiles: string[]; modifiedFiles: string[] },
): WorkInProgress | null {
  const wip: WorkInProgress = {
    task: "",
    progress: [],
    pending: [],
    context: {},
    // Granular fields
    files_modified: [],
    commands_run: [],
    decisions: [],
    next_steps: [],
    error_states: [],
  };

  // Find the last substantive user request
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role === "user") {
      const text = extractMessageText(msg);
      if (text.length > 20) {
        wip.task = text.slice(0, 200);
        break;
      }
    }
  }

  if (!wip.task) return null;

  const progressPatterns = [
    /(?:created?|set up|configured?|installed?|deployed?|built|wrote|updated?|fixed|added)\s+([^.!?\n]{10,80})/gi,
    /(?:✅|done|complete|finished|success)\s*:?\s*([^.!?\n]{10,80})/gi,
  ];

  const pendingPatterns = [
    /(?:need to|should|will|must|todo|pending|next)\s+([^.!?\n]{10,80})/gi,
    /(?:⚠️|waiting|blocked)\s*:?\s*([^.!?\n]{10,80})/gi,
  ];

  const contextPatterns: Array<{ pattern: RegExp; key: string }> = [
    { pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi, key: "url" },
    { pattern: /(?:password|pass|pwd)\s*[:=]\s*["']?([^\s"']{4,})/gi, key: "password" },
    { pattern: /(?:user(?:name)?)\s*[:=]\s*["']?([^\s"']+)/gi, key: "username" },
    { pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?)\b/g, key: "ip" },
  ];

  // Patterns for granular field extraction
  const commandPatterns = [
    /```(?:bash|sh|shell)?\s*\n([^`]+)\n```/gi, // Code blocks with shell commands
    /\$\s+([a-z][^\n]{5,80})/gi, // $ command lines
    /(?:run|ran|execute[d]?|running)\s+[`"]([^`"\n]{5,80})[`"]/gi, // "run X" patterns
    /(?:systemctl|curl|ssh|npm|pip|apt|brew|docker|git)\s+[^\n]{5,60}/gi, // Common commands
  ];

  const decisionPatterns = [
    /(?:decided?|chose?|choosing|picked|selected?|opting?)\s+(?:to\s+)?([^.!?\n]{10,100})/gi,
    /(?:because|since|reason)\s+([^.!?\n]{10,100})/gi,
    /(?:instead of|rather than)\s+([^.!?\n]{10,80})/gi,
  ];

  const errorPatterns = [
    /(?:error|failed?|failure|issue|problem|bug|broken|crash)\s*:?\s*([^.!?\n]{10,100})/gi,
    /(?:❌|⚠️)\s*([^.!?\n]{10,100})/gi,
    /(?:doesn't|didn't|won't|can't|cannot)\s+([^.!?\n]{10,80})/gi,
  ];

  const seenProgress = new Set<string>();
  const seenPending = new Set<string>();
  const seenCommands = new Set<string>();
  const seenDecisions = new Set<string>();
  const seenErrors = new Set<string>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") continue;

    const text = extractMessageText(msg);

    // Extract progress
    for (const pattern of progressPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const item = match[1]?.trim();
        if (item && item.length > 10 && !seenProgress.has(item.toLowerCase())) {
          seenProgress.add(item.toLowerCase());
          wip.progress.push(item.slice(0, 100));
          if (wip.progress.length >= 5) break;
        }
      }
    }

    // Extract pending/next_steps
    for (const pattern of pendingPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const item = match[1]?.trim();
        if (item && item.length > 10 && !seenPending.has(item.toLowerCase())) {
          seenPending.add(item.toLowerCase());
          wip.pending.push(item.slice(0, 100));
          wip.next_steps.push(item.slice(0, 100));
          if (wip.pending.length >= 3) break;
        }
      }
    }

    // Extract commands
    for (const pattern of commandPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const cmd = (match[1] || match[0])?.trim();
        if (cmd && cmd.length > 5 && !seenCommands.has(cmd.toLowerCase())) {
          seenCommands.add(cmd.toLowerCase());
          // Clean up the command
          const cleanCmd = cmd.split("\n")[0].slice(0, 100);
          wip.commands_run.push(cleanCmd);
          if (wip.commands_run.length >= 5) break;
        }
      }
    }

    // Extract decisions
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const decision = match[1]?.trim();
        if (decision && decision.length > 10 && !seenDecisions.has(decision.toLowerCase())) {
          seenDecisions.add(decision.toLowerCase());
          wip.decisions.push(decision.slice(0, 150));
          if (wip.decisions.length >= 3) break;
        }
      }
    }

    // Extract errors
    for (const pattern of errorPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const error = match[1]?.trim();
        if (error && error.length > 10 && !seenErrors.has(error.toLowerCase())) {
          seenErrors.add(error.toLowerCase());
          wip.error_states.push(error.slice(0, 100));
          if (wip.error_states.length >= 3) break;
        }
      }
    }

    // Extract context patterns
    for (const { pattern, key } of contextPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match && !wip.context[key]) {
        const value = match[1] || match[0];
        if (key === "password" && value.length > 4) {
          wip.context[key] = `${value.slice(0, 4)}...`;
        } else {
          wip.context[key] = value.slice(0, 50);
        }
      }
    }
  }

  // Add modified files from fileOps
  if (fileOps.modifiedFiles.length > 0) {
    wip.files_modified = fileOps.modifiedFiles.slice(0, 10);
    wip.progress.push(`Modified: ${fileOps.modifiedFiles.slice(0, 3).join(", ")}`);
  }

  // Check if we have enough content to store
  const hasContent =
    wip.progress.length > 0 ||
    wip.pending.length > 0 ||
    Object.keys(wip.context).length > 0 ||
    wip.files_modified.length > 0 ||
    wip.commands_run.length > 0 ||
    wip.decisions.length > 0 ||
    wip.next_steps.length > 0 ||
    wip.error_states.length > 0;

  if (!hasContent) {
    return null;
  }

  return wip;
}

function getAgentId(): string {
  const hostname = process.env.HOSTNAME || "";
  if (hostname.includes("swarm-host")) return "max";
  if (hostname.includes("code-embed") || hostname.includes("jetson")) return "g";
  if (hostname.includes("macbook") || hostname.includes("mbp")) return "nix";
  if (hostname.includes("prod")) return "percy";
  return "damon";
}

// -----------------------------------------------------------------------------
// Combined memory processing - store WIP + retrieve relevant memories
// -----------------------------------------------------------------------------

async function processMemories(
  messages: AgentMessage[],
  fileOps: { readFiles: string[]; modifiedFiles: string[] },
  signal?: AbortSignal,
): Promise<string> {
  if (!MEMORY_ENABLED) return "";

  const agentId = getAgentId();
  let memoriesSection = "";

  // 1. Store work-in-progress FIRST
  try {
    const wip = extractWorkInProgress(messages, fileOps);
    if (wip) {
      await storeWorkInProgressMemory(wip, agentId, signal);
    }
  } catch (err) {
    console.warn(`[memory-store] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Retrieve relevant memories
  try {
    const memoryQuery = extractMemoryQuery(messages);
    if (memoryQuery) {
      const memories = await queryRelevantMemories(memoryQuery, signal);
      if (memories.length > 0) {
        console.log(`[memory-retrieval] Injecting ${memories.length} memories`);
        memoriesSection = formatMemoriesSection(memories);
      }
    }
  } catch (err) {
    console.warn(`[memory-retrieval] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return memoriesSection;
}

// =============================================================================
// Tool failure handling
// =============================================================================

const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) parts.push(`status=${status}`);
  if (exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts.join("\n");
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") continue;
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) continue;
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) continue;
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({ toolCallId, toolName, summary, meta });
  }

  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// =============================================================================
// Main Extension
// =============================================================================

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);

    // Process memories FIRST - store WIP and retrieve relevant memories
    // This happens regardless of whether summarization succeeds
    const memoriesSection = await processMemories(
      [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
      { readFiles, modifiedFiles },
      signal,
    );

    const fallbackSummary = `${FALLBACK_SUMMARY}${toolFailureSection}${fileOpsSummary}${memoriesSection}`;

    const model = ctx.model;
    if (!model) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    try {
      const contextWindowTokens = resolveContextWindowTokens(model);
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;

      const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            console.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio),
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                console.warn(
                  `Compaction safeguard: failed to summarize dropped messages: ${
                    droppedError instanceof Error ? droppedError.message : String(droppedError)
                  }`,
                );
              }
            }
          }
        }
      }

      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      const historySummary = await summarizeInStages({
        messages: messagesToSummarize,
        model,
        apiKey,
        signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: contextWindowTokens,
        customInstructions,
        previousSummary: effectivePreviousSummary,
      });

      let summary = historySummary;
      if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
        const prefixSummary = await summarizeInStages({
          messages: turnPrefixMessages,
          model,
          apiKey,
          signal,
          reserveTokens,
          maxChunkTokens,
          contextWindow: contextWindowTokens,
          customInstructions: TURN_PREFIX_INSTRUCTIONS,
          previousSummary: undefined,
        });
        summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;
      }

      summary += toolFailureSection;
      summary += fileOpsSummary;
      summary += memoriesSection;

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      console.warn(
        `Compaction summarization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }
  });
}

export const __testing = {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  extractWorkInProgress,
  storeWorkInProgressMemory,
} as const;
