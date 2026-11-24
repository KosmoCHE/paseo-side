import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { openSideRpc } from "../shared/side";
import { forkClaudeTranscript } from "./claude-fork";
import { withLocalDaemon } from "./local-daemon";

const execFileAsync = promisify(execFile);

// Adapted from Codex's side conversation boundary and policy
// (codex-rs/context-fragments/src/side_conversation.rs).
const SIDE_NOTE = `<system-reminder>
Side conversation boundary.

Everything before this boundary is inherited history from the main session. It is reference context only, not your current task. Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Tool calls and outputs before this boundary happened in the main session. Only messages the user sends after this boundary are active instructions for this side conversation. If there is no user message after this boundary yet, wait for one.

You are in a side conversation, separate from the main session, which keeps running on its own and never sees this conversation. Answer questions and do lightweight, non-mutating exploration, such as reading or searching files and running checks that do not change tracked files. Do not present yourself as continuing the main session's active task.

Do not start or interact with subagents or background tasks, even if the inherited history used them.

Do not modify files, source, git state, permissions, configuration, or other workspace state unless the user explicitly asks for that change in this side conversation. If they do, keep it minimal, local to the request, and avoid disrupting the main session.
</system-reminder>`;

/**
 * Branches a Claude Code agent into a side agent that resumes a native fork of its session.
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

  // Everything written so far, a running turn included. On resume Claude Code records a tool
  // call left without a result as interrupted.
  const forkId = await forkClaudeTranscript(sessionId, parent.cwd, SIDE_NOTE);

  const sideId = await withLocalDaemon(async (daemon) => {
    const side = await daemon.importAgent({
      provider: parent.provider,
      sessionId: forkId,
      cwd: parent.cwd,
      ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
      labels: { side: parent.id },
    });
    // An import starts from Paseo's defaults; any setting left different would change the request.
    if (parent.model) await daemon.setAgentModel(side.id, parent.model);
    if (parent.currentModeId) await daemon.setAgentMode(side.id, parent.currentModeId);
    await daemon.setAgentThinkingOption(side.id, parent.thinkingOptionId ?? null);
    if (parent.options) await daemon.setAgentOptions(side.id, parent.options as Record<string, unknown>);
    await daemon.updateAgent(side.id, { name: `side: ${parent.title ?? parent.id.slice(0, 8)}` });
    return side.id;
  });
  if (prompt) await paseo.agents.ref(sideId).send(prompt);

  const cli = process.env.PASEO_CLI;
  if (!cli) {
    throw new Error(`旁路会话 ${sideId} 已建好，但没有 PASEO_CLI 环境变量，打不开标签页（只支持 Paseo 桌面端）`);
  }
  await execFileAsync(cli, ["agent", "open", sideId]);
  return { agentId: sideId };
}
