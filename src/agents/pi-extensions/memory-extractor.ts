import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  TurnEndEvent,
  InputEvent,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// =============================================================================
// CONTINUOUS MEMORY EXTRACTION
// Runs a cheap LLM after every N turns to extract structured work context.
// Direct API call - never enters the agent conversation (no recursion).
// =============================================================================

const MEMORY_API_URL = process.env.MEMORY_API_URL || "http://134.199.235.140:8000";
const MEMORY_API_KEY = process.env.MEMORY_API_KEY || "3af7aebc2f1714f378580d68eb569a12";
const EXTRACT_MODEL = process.env.MEMORY_EXTRACT_MODEL || "gpt-4o-mini";
const EXTRACT_EVERY_N_TURNS = parseInt(process.env.MEMORY_EXTRACT_INTERVAL || "3", 10);
const EXTRACT_ENABLED = process.env.MEMORY_EXTRACT_ENABLED !== "false";

// Anti-recursion lock
let _extracting = false;
let _turnCount = 0;
let _lastExtractedTurn = -1;

// Circular buffer of recent messages for context
const MAX_CONTEXT_MESSAGES = 30;
let _messageBuffer: Array<{ role: string; text: string }> = [];

function getAgentId(): string {
  const hostname = process.env.HOSTNAME || "";
  if (hostname.includes("swarm-host")) return "max";
  if (hostname.includes("code-embed") || hostname.includes("jetson")) return "g";
  if (hostname.includes("macbook") || hostname.includes("mbp")) return "nix";
  if (hostname.includes("prod")) return "percy";
  return "damon";
}

function extractText(msg: AgentMessage): string {
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

function buildTranscript(): string {
  return _messageBuffer
    .slice(-20)
    .map((m) => `${m.role}: ${m.text.slice(0, 600)}`)
    .join("\n\n");
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Given this conversation between a human and an AI agent, extract the current work context as structured JSON.

Focus on:
- What the human is asking for (active tasks)
- What has been completed
- What is still pending
- Key decisions and their reasoning
- Important values (URLs, filenames, configs, credentials mentioned)
- Any blockers or errors encountered
- User preferences or constraints stated

<conversation>
{TRANSCRIPT}
</conversation>

Return ONLY valid JSON in this exact format:
{
  "active_task": "Current task description",
  "completed": ["List of completed items"],
  "pending": ["List of pending items"],
  "decisions": ["Decision: reasoning"],
  "key_values": {"name": "value"},
  "blockers": ["Any blockers"],
  "user_preferences": ["Stated preferences"]
}`;

async function extractAndStore(): Promise<void> {
  if (_extracting || !EXTRACT_ENABLED) return;
  if (_messageBuffer.length < 3) return; // Need enough context

  _extracting = true;
  const agentId = getAgentId();

  try {
    const transcript = buildTranscript();
    const prompt = EXTRACTION_PROMPT.replace("{TRANSCRIPT}", transcript);

    // Get API key — try OpenAI first (works with direct calls), then Anthropic
    const openaiKey = process.env.OPENAI_API_KEY || "";
    const anthropicKey = process.env.ANTHROPIC_API_KEY || "";

    let text = "";

    if (openaiKey) {
      // OpenAI API call — NOT through the agent system
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: EXTRACT_MODEL,
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.warn(`[memory-extractor] OpenAI API error: ${response.status}`);
        return;
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      text = data.choices?.[0]?.message?.content || "";
    } else if (anthropicKey && !anthropicKey.startsWith("sk-ant-oat")) {
      // Anthropic direct API (non-OAuth keys only)
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.warn(`[memory-extractor] Anthropic API error: ${response.status}`);
        return;
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      text = data.content?.[0]?.text || "";
    } else {
      console.warn("[memory-extractor] No usable API key, skipping extraction");
      return;
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(jsonStr.trim());
    } catch {
      console.warn("[memory-extractor] Failed to parse extraction JSON");
      return;
    }

    // Format as a rich memory
    const parts: string[] = [];

    if (extracted.active_task) {
      parts.push(`[ACTIVE TASK] ${extracted.active_task}`);
    }
    if (Array.isArray(extracted.completed) && extracted.completed.length > 0) {
      parts.push(`[COMPLETED] ${(extracted.completed as string[]).join("; ")}`);
    }
    if (Array.isArray(extracted.pending) && extracted.pending.length > 0) {
      parts.push(`[PENDING] ${(extracted.pending as string[]).join("; ")}`);
    }
    if (Array.isArray(extracted.decisions) && extracted.decisions.length > 0) {
      parts.push(`[DECISIONS] ${(extracted.decisions as string[]).join("; ")}`);
    }
    if (
      extracted.key_values &&
      typeof extracted.key_values === "object" &&
      Object.keys(extracted.key_values as object).length > 0
    ) {
      const kvParts = Object.entries(extracted.key_values as Record<string, string>).map(
        ([k, v]) => `${k}=${v}`,
      );
      parts.push(`[CONTEXT] ${kvParts.join(", ")}`);
    }
    if (Array.isArray(extracted.blockers) && extracted.blockers.length > 0) {
      parts.push(`[BLOCKERS] ${(extracted.blockers as string[]).join("; ")}`);
    }
    if (Array.isArray(extracted.user_preferences) && extracted.user_preferences.length > 0) {
      parts.push(`[PREFERENCES] ${(extracted.user_preferences as string[]).join("; ")}`);
    }

    if (parts.length === 0) return;

    const content = parts.join(" | ");

    // Store to memory API
    const storeResponse = await fetch(`${MEMORY_API_URL}/memory/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": MEMORY_API_KEY,
      },
      body: JSON.stringify({
        agent_id: agentId,
        content,
        tags: ["extraction", "continuous", "auto"],
        decisions: Array.isArray(extracted.decisions) ? extracted.decisions : undefined,
        next_steps: Array.isArray(extracted.pending) ? extracted.pending : undefined,
        error_states: Array.isArray(extracted.blockers) ? extracted.blockers : undefined,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (storeResponse.ok) {
      console.log(`[memory-extractor] Stored extraction for ${agentId} (turn ${_turnCount})`);
    }
  } catch (err) {
    console.warn(`[memory-extractor] Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    _extracting = false;
  }
}

export default function memoryExtractorExtension(api: ExtensionAPI): void {
  // Track messages as they flow through
  api.on("turn_end", (event: TurnEndEvent, _ctx: ExtensionContext) => {
    _turnCount++;

    // Buffer the assistant message
    const text = extractText(event.message);
    if (text) {
      _messageBuffer.push({ role: "Assistant", text });
      // Trim buffer
      if (_messageBuffer.length > MAX_CONTEXT_MESSAGES) {
        _messageBuffer = _messageBuffer.slice(-MAX_CONTEXT_MESSAGES);
      }
    }

    // Extract every N turns (fire-and-forget, don't await)
    if (_turnCount - _lastExtractedTurn >= EXTRACT_EVERY_N_TURNS) {
      _lastExtractedTurn = _turnCount;
      // Async fire-and-forget - never blocks the agent
      extractAndStore().catch((err) => {
        console.warn(`[memory-extractor] Background error: ${err}`);
      });
    }
  });

  // Also capture user messages via input event
  api.on("input", (event: InputEvent, _ctx: ExtensionContext) => {
    const text = event.text || "";
    if (text && text.length > 5) {
      _messageBuffer.push({ role: "Human", text });
      if (_messageBuffer.length > MAX_CONTEXT_MESSAGES) {
        _messageBuffer = _messageBuffer.slice(-MAX_CONTEXT_MESSAGES);
      }
    }
  });
}
