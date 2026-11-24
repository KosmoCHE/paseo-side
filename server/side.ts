import type { RpcInput } from "@getpaseo/plugin";
import type {
  PluginHandlerContext,
  PluginHookContext,
  PluginHookPayload,
} from "@getpaseo/plugin/server";
import type { openSideRpc } from "../shared/side";
import { forkClaudeTranscript } from "./claude-fork";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { withLocalDaemon } from "./local-daemon";

// Set on a side agent opened without a message, which is named after its main agent alone; holds
// that name until the first message gives it a topic.
const UNNAMED = "side.unnamedTitle";
const TOPIC_CHARS = 20;

// Adapted from Codex's side conversation boundary and policy
// (codex-rs/context-fragments/src/side_conversation.rs).
const SIDE_NOTE = `<system-reminder>
Side conversation boundary.

Everything before this boundary is inherited history from the main session. It is reference context only, not your current task. Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Tool calls and outputs before this boundary happened in the main session. Only messages the user sends after this boundary are active instructions for this side conversation. If there is no user message after this boundary yet, wait for one.

You are in a side conversation, separate from the main session, which keeps running on its own and never sees this conversation. Answer questions and do lightweight, non-mutating exploration, such as reading or searching files and running checks that do not change tracked files. Do not present yourself as continuing the main session's active task.

Do not start or interact with subagents or background tasks, even if the inherited history used them. Background tasks started before this boundary belong to the main session and keep running there. This conversation cannot see their real state, so ignore any notification about them here, such as a report that they stopped or did not finish.

Do not modify files, source, git state, permissions, configuration, or other workspace state unless the user explicitly asks for that change in this side conversation. If they do, keep it minimal, local to the request, and avoid disrupting the main session.
</system-reminder>`;

/**
 * Branches a Claude Code agent into a side agent that resumes a native fork of its session.
 *
 * The side agent is the parent's subagent: it waits in the parent's subagent track instead of
 * opening a tab, and opens beside the parent when the subagent open location is set to the side.
 *
 * Importing the fork shows its history. The side agent then repeats the parent's directory,
 * model, mode, thinking option and provider options, and changes no tools, so its first request
 * opens with the same tools, system prompt and messages as the parent's last one and reads the
 * parent's prompt cache. The side note follows the inherited history, after that shared prefix.
 */
export async function openSide(
  { agentId, prompt }: RpcInput<typeof openSideRpc>,
  { paseo }: PluginHandlerContext,
) {
  const refreshed = await paseo.agents.ref(agentId).refresh();
  if (!refreshed) throw new Error(`找不到 agent ${agentId}`);
  const parent = refreshed.agent;
  const sessionId = parent.persistence?.sessionId;
  if (!sessionId) throw new Error("这个会话还没有 Claude Code 会话记录，先发一条消息再开旁路会话");

  // Everything written so far, a running turn included.
  const forkId = await forkClaudeTranscript(sessionId, parent.cwd, SIDE_NOTE);

  const baseTitle = `side: ${parent.title ?? parent.id.slice(0, 8)}`;
  const title = withTopic(baseTitle, prompt);
  const sideId = await withLocalDaemon(async (daemon) => {
    const side = await daemon.importAgent({
      provider: parent.provider,
      sessionId: forkId,
      cwd: parent.cwd,
      ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
      labels: { side: parent.id, [PARENT_AGENT_ID_LABEL]: parent.id },
    });
    // An import starts from Paseo's defaults; any setting left different would change the request.
    if (parent.model) await daemon.setAgentModel(side.id, parent.model);
    if (parent.currentModeId) await daemon.setAgentMode(side.id, parent.currentModeId);
    await daemon.setAgentThinkingOption(side.id, parent.thinkingOptionId ?? null);
    if (parent.options) await daemon.setAgentOptions(side.id, parent.options as Record<string, unknown>);
    await daemon.updateAgent(side.id, { name: title });
    return side.id;
  });
  if (title === baseTitle) await paseo.agents.ref(sideId).setMetadata({ [UNNAMED]: baseTitle });
  if (prompt) await paseo.agents.ref(sideId).send(prompt);
  return { agentId: sideId };
}

/** Adds the topic of its first message to the name of a side agent opened without one. */
export async function nameSideAfterFirstMessage(
  { agent, turnId }: PluginHookPayload<"agent.turn.after">,
  { paseo }: PluginHookContext,
) {
  const baseTitle = agent.metadata[UNNAMED];
  if (typeof baseTitle !== "string" || !turnId) return;
  const side = paseo.agents.ref(agent.id);
  const page = await side.timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
  if (!page.agent) throw new Error(`读不到旁路会话 ${agent.id} 的当前名字`);
  let message: string | undefined;
  for (const entry of page.entries) {
    if (entry.turnId === turnId && entry.item.type === "user_message") message = entry.item.text;
  }
  // A turn the user did not start, such as a task notification.
  if (message === undefined) return;
  const title = withTopic(baseTitle, message);
  // A slash command names no topic; wait for the next message.
  if (title === baseTitle) return;
  // A name the user gave in the meantime stays. The hook's `agent.title` is not the shown name.
  if (page.agent.title === baseTitle) await withLocalDaemon((daemon) => daemon.updateAgent(agent.id, { name: title }));
  await side.setMetadata({ [UNNAMED]: null });
}

/** `title` followed by the start of the first line of `message`, unless that line is a slash command. */
function withTopic(title: string, message: string): string {
  const line = message.split("\n").map((text) => text.trim()).find(Boolean);
  if (!line || line.startsWith("/")) return title;
  const chars = Array.from(line.replace(/\s+/g, " "));
  return `${title} · ${chars.slice(0, TOPIC_CHARS).join("")}${chars.length > TOPIC_CHARS ? "…" : ""}`;
}
