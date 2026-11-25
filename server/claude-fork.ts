import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Entry = Record<string, unknown>;

const UNFINISHED_TOOL_RESULT =
  "No result: this call was still running in the main session when the side conversation started, and its result stays there.";

/**
 * Copies a Claude Code transcript beside the original under a new session id, ends the copy with
 * `note` as a hidden user message, and returns the new id.
 *
 * Only each entry's own `sessionId` changes, so a session resumed from the copy sends the model
 * the same messages as the original, followed by the note. An entry a running turn is still
 * writing is left out, and each tool call the running turn is still waiting on gets a failed
 * result, so neither the model nor the timeline takes it for running.
 */
export async function forkClaudeTranscript(
  sessionId: string,
  cwd: string,
  note: string,
): Promise<string> {
  const source = await findTranscript(sessionId, cwd);
  const text = await readFile(source, "utf8");
  // Claude Code ends every entry with a newline; text after the last one is still being written.
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((line) => line.trim());
  const forkId = randomUUID();
  const entries = lines.map((line, index): Entry => {
    try {
      const entry: Entry = JSON.parse(line);
      return entry.sessionId === sessionId ? { ...entry, sessionId: forkId } : entry;
    } catch (error) {
      throw new Error(`${source} 第 ${index + 1} 行不是合法的 JSON`, { cause: error });
    }
  });
  const lastMessage = entries.findLast((entry) => entry.type === "user" || entry.type === "assistant");
  if (!lastMessage) throw new Error(`${source} 里还没有对话消息`);
  // Claude Code appends each entry to the last one of the main chain.
  let leaf = entries.findLast((entry) => typeof entry.uuid === "string" && entry.isSidechain !== true)!
    .uuid as string;
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
    entries.push(results);
    leaf = results.uuid as string;
  }
  entries.push({ ...userMessage(note, leaf, forkId, lastMessage), isMeta: true });
  await writeFile(
    path.join(path.dirname(source), `${forkId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return forkId;
}

/** Tool calls of the main chain's last assistant message that have no result yet. */
function unfinishedToolUses(entries: Entry[]): string[] {
  const assistant = entries.filter((entry) => entry.type === "assistant" && entry.isSidechain !== true);
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
  throw new Error(`在 ${projects} 下找不到会话 ${sessionId} 的记录，这个会话不是 Claude Code`);
}
