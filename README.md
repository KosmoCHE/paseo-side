# Side for Paseo

A Codex-style `/side` for Claude Code agents in [Paseo](https://paseo.sh): ask a side question about the conversation without touching the main session, and pay full price only for the new part.

`/side` forks the agent's Claude Code session into a side agent. The side agent sees the main session's history, and its first request opens with the same tools, system prompt and messages as the main session's last one, so it reads the main session's prompt cache.

## Requirements

- Paseo 0.17.3 or later, with plugins enabled
- A Claude Code agent, or one from a custom provider based on Claude Code
- The plugin runs on the daemon's machine: it connects to the local daemon with the daemon home's `local-credential` (`$PASEO_HOME`, `~/.paseo` by default) to import the fork and set its model, mode and thinking option, which the plugin API does not offer

## Install

```bash
paseo plugin install git:KosmoCHE/paseo-side
```

Paseo runs `npm ci --omit=dev --ignore-scripts` from the manifest's `build` to install the runtime dependencies, so the daemon needs `npm` on its `PATH`.

## Use

In a Claude Code agent's composer, type `/side`, optionally followed by a message:

```text
/side why did the last test fail?
```

The message is sent as the side agent's first message. Without one, the side agent waits for you.

- **Where it opens.** The side agent is a subagent of the main agent. It does not open by itself: it appears in the subagent list above the composer, and opens when you click it. To open it on the right of the main agent, set **Settings → Open location → Clicking a subagent in an agent chat** to **On the side**.
- **Its name.** `side: <main agent's name> · <first message>`, with the first 20 characters of the first line of the first message. A side agent opened without a message gets its topic after your first message's turn ends; slash commands do not count, and a name you gave it in the meantime stays.
- **While the main agent is running.** You can open a side agent at any time. It continues from what the main session has written so far. A tool call still running is recorded in the side agent as failed, saying its result stays in the main session, and the side agent ignores notifications about background tasks the main session started.
- **Archiving.** When the main agent is archived, its side agents that are not open are archived with it, and open ones are detached and stay. **Archive finished subagents** in the subagent list also archives idle side agents.

## What the side agent may do

The rules follow Codex's `/side`. A hidden note after the inherited history tells the model that everything above it is reference only: it does not continue the main session's tasks, plans or tool calls. In the side conversation it answers questions and looks around without changing anything, keeps away from subagents and background tasks, and changes files, git state or configuration only when you ask for it there.

## How it works

1. The plugin copies the main session's Claude Code transcript, whole, into a new session file beside it. Only each entry's `sessionId` changes. It then appends the failed results for unfinished tool calls and the side note.
2. It imports the new session into Paseo, in the main agent's workspace, labelled `side=<main agent id>` and `paseo.parent-agent-id=<main agent id>`.
3. It gives the side agent the main agent's directory, model, mode, thinking option and provider options, and adds or removes no tools.

Claude Code sends the model nothing older than the last compaction, so the side agent's model sees what the main agent's model sees: the latest compaction summary and the messages after it. Its first request repeats the main session's last request and adds the side note and your message, which are the only part billed at full price.

The cache is shared only when both requests reach it:

- Anthropic keeps the cache for 5 minutes after the main session's last request by default.
- A gateway that sends the two requests to different accounts misses it.
- Claude Code works out its tool list when its process starts. A main agent whose process started before a change in that list, such as a tool that Claude Code enabled or disabled since, sends different tools, and the side agent's first request misses the cache.

## Limits

- Claude Code agents only.
- `/side` with an attachment is not run: Paseo sends the text and the attachment to the main agent as an ordinary message ([getpaseo/paseo#10766](https://github.com/getpaseo/paseo/issues/10766)). Send `/side` alone, then send the attachment in the side agent.
- The side agent's timeline shows the main session's whole history, compacted parts included, and its transcript is a full copy of the main session's.
- The copy has no file-history snapshots, so the side agent cannot undo file changes made before the fork.
- Forking with the Claude Agent SDK's `forkSession`, which Anthropic maintains with Claude Code, waits for Paseo to load the SDK in a plugin ([#1](https://github.com/KosmoCHE/paseo-side/issues/1), code on [`feat/sdk-fork-session`](https://github.com/KosmoCHE/paseo-side/tree/feat/sdk-fork-session)).

## Development

| File | What it holds |
| --- | --- |
| `index.client.tsx` | The `/side` slash command |
| `index.server.ts` | Registers the RPC and the hook |
| `shared/side.ts` | The `side.open` RPC contract |
| `server/side.ts` | Opens the side agent, the side note, naming after the first message |
| `server/claude-fork.ts` | Copies the Claude Code transcript |
| `server/local-daemon.ts` | The plugin's own connection to the local daemon |

Install from a checkout to work on it:

```bash
git clone https://github.com/KosmoCHE/paseo-side.git
cd paseo-side
npm install
paseo plugin install "$(pwd)"
```

After a change:

```bash
npm run typecheck
paseo plugin reload side
```

## Credits and licence

The plugin is under the MIT License, in [LICENSE](LICENSE), except for the side note in `server/side.ts`. The side note is adapted from Codex's side conversation boundary and policy, in [`codex-rs/context-fragments/src/side_conversation.rs`](https://github.com/openai/codex/blob/main/codex-rs/context-fragments/src/side_conversation.rs), © OpenAI, under the [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE), and stays under that licence.
