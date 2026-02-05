import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  TurnEndEvent,
  InputEvent,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// =============================================================================
// CONTINUOUS MEMORY EXTRACTION
// Buffers conversation, then calls the server-side /extract endpoint every N turns.
// Server handles LLM call + storage. Extension just collects and sends transcript.
// No recursion risk — this is a raw HTTP POST, never enters agent conversation.
// =============================================================================

const MEMORY_API_URL = process.env.MEMORY_API_URL || "https://memory.swarmfactory.io";
const MEMORY_API_KEY = process.env.MEMORY_API_KEY || "3af7aebc2f1714f378580d68eb569a12";
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

async function extractAndStore(): Promise<void> {
  if (_extracting || !EXTRACT_ENABLED) return;
  if (_messageBuffer.length < 3) return;

  _extracting = true;
  const agentId = getAgentId();

  try {
    const transcript = buildTranscript();

    // Call the server-side /extract endpoint
    // Server handles LLM call (GPT-4o-mini) + structured extraction + storage
    const response = await fetch(`${MEMORY_API_URL}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": MEMORY_API_KEY,
      },
      body: JSON.stringify({
        conversation: transcript,
        agent_id: agentId,
        tags: ["continuous"],
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (response.ok) {
      const result = (await response.json()) as { stored: boolean; memory_id?: string };
      if (result.stored) {
        console.log(
          `[memory-extractor] Stored extraction for ${agentId} (turn ${_turnCount}, id=${result.memory_id})`,
        );
      }
    } else {
      console.warn(`[memory-extractor] /extract error: ${response.status}`);
    }
  } catch (err) {
    console.warn(`[memory-extractor] Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    _extracting = false;
  }
}

export default function memoryExtractorExtension(api: ExtensionAPI): void {
  // Track assistant messages
  api.on("turn_end", (event: TurnEndEvent, _ctx: ExtensionContext) => {
    _turnCount++;

    const text = extractText(event.message);
    if (text) {
      _messageBuffer.push({ role: "Assistant", text });
      if (_messageBuffer.length > MAX_CONTEXT_MESSAGES) {
        _messageBuffer = _messageBuffer.slice(-MAX_CONTEXT_MESSAGES);
      }
    }

    // Extract every N turns (fire-and-forget)
    if (_turnCount - _lastExtractedTurn >= EXTRACT_EVERY_N_TURNS) {
      _lastExtractedTurn = _turnCount;
      extractAndStore().catch((err) => {
        console.warn(`[memory-extractor] Background error: ${err}`);
      });
    }
  });

  // Track user messages
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
