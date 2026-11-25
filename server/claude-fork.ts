import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";

type Entry = Record<string, unknown>;

const UNFINISHED_TOOL_RESULT =
  "No result: this call was still running in the main session when the side conversation started, and its result stays there.";

/**
 * Forks a Claude Code session with the Claude Agent SDK, which copies the whole transcript under
 * new session and message ids, ends the fork with `note` as a hidden user message, and returns the
 * new session id.
 *
 * Claude Code sends the model nothing older than the last compaction and the fork changes no
 * message content, so a session resumed from it sends the model the same messages as the
 * original, followed by the note. The SDK leaves out an entry a running turn is still writing;
 * each tool call the running turn is still waiting on gets a failed result here, so neither the
 * model nor the timeline takes it for running.
 */
export async function forkClaudeTranscript(
  sessionId: string,
  cwd: string,
  note: string,
): Promise<string> {
  const { sessionId: forkId } = await forkSession(sessionId).catch((error: Error) => {
    throw new Error(`复制会话 ${sessionId} 失败，旁路会话只支持 Claude Code：${error.message}`, { cause: error });
  });
  const file = await findTranscript(forkId, cwd);
  const text = await readFile(file, "utf8");
  if (!text.endsWith("\n")) throw new Error(`${file} 没有以换行结尾，不能往后追加`);
  const entries = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line): Entry => JSON.parse(line));
  const lastMessage = entries.findLast((entry) => entry.type === "user" || entry.type === "assistant");
  if (!lastMessage) throw new Error(`${file} 里还没有对话消息`);
  // The SDK marks every message it copies; its session records come after them.
  let leaf = entries.findLast((entry) => entry.forkedFrom !== undefined)!.uuid as string;
  const added: Entry[] = [];
  const unfinished = unfinishedToolUses(entries);
  if (unfinished.length > 0) {
    const results = userMessage(
      unfinished.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: UNFINISHED_TOOL_RESULT,
        is_error: true,
      })),
      leaf,
      forkId,
      lastMessage,
    );
    added.push(results);
    leaf = results.uuid as string;
  }
  added.push({ ...userMessage(note, leaf, forkId, lastMessage), isMeta: true });
  await appendFile(file, added.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return forkId;
}

/** Tool calls of the last assistant message that have no result yet. */
function unfinishedToolUses(entries: Entry[]): string[] {
  const assistant = entries.filter((entry) => entry.type === "assistant");
  const lastId = (assistant.at(-1)?.message as Entry | undefined)?.id;
  if (lastId === undefined) return [];
  const answered = new Set(
    entries
      .filter((entry) => entry.type === "user")
      .flatMap(blocks)
      .filter((block) => block.type === "tool_result")
      .map((block) => block.tool_use_id),
  );
  return assistant
    .filter((entry) => (entry.message as Entry).id === lastId)
    .flatMap(blocks)
    .filter((block) => block.type === "tool_use" && !answered.has(block.id))
    .map((block) => block.id as string);
}

function blocks(entry: Entry): Entry[] {
  const content = (entry.message as Entry | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

/** A user message of the main chain, as Claude Code writes them. */
function userMessage(content: unknown, parentUuid: string, sessionId: string, like: Entry): Entry {
  return {
    parentUuid,
    isSidechain: false,
    userType: like.userType,
    cwd: like.cwd,
    sessionId,
    version: like.version,
    gitBranch: like.gitBranch,
    entrypoint: like.entrypoint,
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

async function findTranscript(sessionId: string, cwd: string): Promise<string> {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects");
  // Claude Code names a project folder after its directory, every non-alphanumeric replaced.
  const expected = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(expected)) return expected;
  for (const folder of await readdir(projects)) {
    const candidate = path.join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`在 ${projects} 下找不到会话 ${sessionId} 的记录`);
}
