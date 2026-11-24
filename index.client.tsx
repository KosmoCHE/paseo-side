import type { PluginClientContext } from "@getpaseo/plugin/client";
import { openSideRpc } from "./shared/side";

export default function contribute(client: PluginClientContext) {
  return client.addSlashCommand({
    name: "side",
    description: "把当前 Claude Code 会话分叉成旁路会话，复用主会话的缓存",
    argumentHint: "[要在旁路会话里说的话]",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      await rpc(openSideRpc, { agentId: agent.id, prompt: args });
    },
  });
}
