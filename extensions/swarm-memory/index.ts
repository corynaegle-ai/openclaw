/**
 * Moltbot Swarm Memory Plugin
 *
 * Auto-injects context from shared swarm memory on agent start.
 * Stores compaction summaries back to swarm memory.
 */

import type { MoltbotPluginApi } from "moltbot/plugin-sdk";

const MEMORY_API = "https://memory.swarmfactory.io";
const API_KEY = "3af7aebc2f1714f378580d68eb569a12";

const swarmMemoryPlugin = {
  id: "swarm-memory",
  name: "Swarm Memory",
  description: "Auto-injects context from shared swarm memory API",
  kind: "memory" as const,
  configSchema: {},

  register(api: MoltbotPluginApi) {
    const agentId = process.env.SWARM_AGENT_ID || "damon";

    api.logger.info?.(`swarm-memory: enabled for agent ${agentId}`);

    // Inject context before agent starts
    api.on("before_agent_start", async (event) => {
      try {
        const response = await fetch(`${MEMORY_API}/memory/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
          },
          body: JSON.stringify({
            agent_id: agentId,
            limit: 5,
            include_active_tasks: true,
            include_recent: true,
          }),
        });

        if (!response.ok) {
          api.logger.warn?.(`swarm-memory: context fetch failed: ${response.status}`);
          return;
        }

        const data = await response.json();

        if (!data.context || data.memories_used === 0) {
          api.logger.debug?.("swarm-memory: no context to inject");
          return;
        }

        api.logger.info?.(`swarm-memory: injecting ${data.memories_used} memories`);

        return {
          prependContext: `<swarm-memory agent="${agentId}">\n${data.context}\n</swarm-memory>`,
        };
      } catch (err) {
        api.logger.warn?.(`swarm-memory: context injection failed: ${String(err)}`);
      }
    });

    // Store context after compaction
    api.on("after_compaction", async (event) => {
      if (!event.summary) return;

      try {
        await fetch(`${MEMORY_API}/memory/store`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
          },
          body: JSON.stringify({
            agent_id: agentId,
            content: `[COMPACTION SUMMARY] ${event.summary}`,
            tags: ["compaction", "auto"],
            importance: 0.6,
          }),
        });
        api.logger.info?.("swarm-memory: stored compaction summary");
      } catch (err) {
        api.logger.warn?.(`swarm-memory: failed to store compaction: ${String(err)}`);
      }
    });
  },
};

export default swarmMemoryPlugin;
