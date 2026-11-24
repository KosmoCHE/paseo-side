import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Entry = Record<string, unknown>;

/**
 * Copies a Claude Code transcript beside the original under a new session id, ends the copy with
 * `note` as a hidden user message, and returns the new id.
 *
 * Only each entry's own `sessionId` changes, so a session resumed from the copy sends the model
 * the same messages as the original, followed by the note. An entry a running turn is still
 * writing is left out.
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
  const leaf = entries.findLast((entry) => typeof entry.uuid === "string" && entry.isSidechain !== true);
  entries.push(hiddenUserMessage(note, leaf!.uuid as string, forkId, lastMessage));
  await writeFile(
    path.join(path.dirname(source), `${forkId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { flag: "wx" },
  );
  return forkId;
}

/** A user message the model reads and the transcript views hide, as Claude Code writes them. */
function hiddenUserMessage(text: string, parentUuid: string, sessionId: string, like: Entry): Entry {
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
    isMeta: true,
    message: { role: "user", content: text },
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
