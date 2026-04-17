# athena-mcp

> *When Hermes is stuck, it asks Athena.*

An MCP server that gives your tool-using agent a **reasoning sidekick**. One tool: `think`. No side effects — Athena has no tools of her own. She just reasons.

When your main agent (Hermes, Claude Code, Cursor, any MCP-speaking client) hits a hard problem — a subtle bug, an architecture call, a plan that needs critique — it calls `think` and gets back a concise, well-reasoned response. Your agent stays in the driver's seat; Athena is the quiet consultant it turns to when the problem is thornier than its default model handles well.

Inspired by [Codebuff's thinker agent](https://github.com/CodebuffAI/codebuff/blob/main/agents/thinker/thinker.ts), which does exactly this internally: Codebuff's orchestrator spawns `thinker-gpt` with no tools after gathering context, and the thinker's sole job is to think hard and return a brief answer.

## Why the separation?

Most agents run on one model for everything. That model is a compromise: fast and cheap enough for hundreds of tool calls, smart enough for most of them. But when it's genuinely stuck, you want a *different* model — a reasoning-heavy one (Claude Opus, GPT-5, Gemini Pro, DeepSeek R1) — without ceding control of the rest of the task. That's what Athena is for.

- **Cost** — reasoning models are expensive to run on every turn. Call them only when needed.
- **Latency** — reasoning models think slowly. Save them for hard problems.
- **Tool orthogonality** — Athena has no tools on purpose. The caller stays in control of side effects.
- **Model portability** — swap reasoning models per call without reconfiguring your whole agent.

## Two backends

**`claude-code` (default when the `claude` CLI is on PATH)** — spawns `claude -p` for each call and uses your Anthropic **Pro/Max subscription** OAuth. No API key, no per-token billing. Just counts against your subscription quota. Supports `opus`, `sonnet`, `haiku`, or full Claude model names.

**`openrouter`** — HTTPS call to OpenRouter. Any model (Claude, GPT, Gemini, DeepSeek, Qwen, whatever) via per-token billing. Requires `OPENROUTER_API_KEY`.

Pick explicitly with `ATHENA_BACKEND=claude-code` or `ATHENA_BACKEND=openrouter`.

## Install

```bash
git clone https://github.com/DevvGwardo/athena-mcp.git ~/projects/athena-mcp
cd ~/projects/athena-mcp
npm install
npm run build
```

## Environment

| Var | Backend | Default | Notes |
|---|---|---|---|
| `ATHENA_BACKEND` | both | auto | `claude-code` if `claude` CLI found, else `openrouter` |
| `ATHENA_MODEL` | both | `opus` / `anthropic/claude-opus-4.6` | Model to use |
| `ATHENA_EFFORT` | both | `high` | `low` / `medium` / `high` |
| `ATHENA_CLAUDE_CLI` | claude-code | auto (PATH lookup) | Absolute path to `claude` binary |
| `ATHENA_TIMEOUT_MS` | claude-code | 180000 | Subprocess timeout |
| `OPENROUTER_API_KEY` | openrouter | — | Required |
| `ATHENA_APP_NAME` / `ATHENA_APP_URL` | openrouter | — | OpenRouter analytics headers |

## Wire into Hermes

Hermes speaks MCP over stdio natively ([Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)).

**With a Claude subscription (recommended):**

```bash
hermes mcp add athena \
  --command /path/to/node \
  --args /path/to/athena-mcp/dist/index.js \
  --env ATHENA_CLAUDE_CLI=/opt/homebrew/bin/claude
```

**With OpenRouter:**

```bash
hermes mcp add athena \
  --command /path/to/node \
  --args /path/to/athena-mcp/dist/index.js \
  --env ATHENA_BACKEND=openrouter OPENROUTER_API_KEY=sk-or-v1-... ATHENA_MODEL=anthropic/claude-opus-4.6
```

Verify:

```bash
hermes mcp list          # should show `athena`
hermes mcp test athena   # should report "Connected" and 1 tool
```

Start a new Hermes session and the agent will see a `think` tool.

## Wire into Claude Code

```bash
claude mcp add athena --command node --args /path/to/athena-mcp/dist/index.js
```

## Wire into any other MCP client

It's a standard stdio MCP server. Point your client at `node /path/to/athena-mcp/dist/index.js`.

## The `think` tool

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The problem to reason about. Can be brief. |
| `context` | string | no | Code, conversation excerpt, error messages — anything Athena needs to see. She can't read files. |
| `effort` | `low`\|`medium`\|`high` | no | Reasoning effort. Defaults to `ATHENA_EFFORT`. |
| `model` | string | no | Model override for this call. Format depends on backend. |

**Example call (JSON-RPC):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "think",
    "arguments": {
      "prompt": "Is there a race condition in the claim() function? If so, minimal fix?",
      "context": "def claim(self, rid):\n    if self.claims.get(rid):\n        return False\n    self.claims[rid] = self.agent_id\n    return True",
      "effort": "high"
    }
  }
}
```

Response comes back as text with a footer line: `backend: ... · model: ... · effort: ... · duration · tokens`.

## Design notes

- **Stateless.** Each call is independent. For conversation continuity, pass the relevant history via `context`.
- **`<think>...</think>` blocks** in Athena's response are stripped before returning — she can use them as scratch space without polluting the output. Matches Codebuff's convention.
- **Neutral `cwd`.** The claude-code backend spawns from `os.tmpdir()` so project `CLAUDE.md` files don't leak into Athena's context.
- **`--tools ""` + `--disable-slash-commands` + `--no-session-persistence`** on every claude-code call keep her truly tool-free and stateless.
- **No retry logic.** If the backend errors, the error surfaces cleanly so the caller decides whether to retry.

## Development

```bash
npm run dev     # tsc --watch
npm run build
npm start       # runs dist/index.js (needs an MCP stdio peer)
```

Smoke test without touching any API:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

## License

MIT

## Credits

Pattern borrowed — with appreciation — from [Codebuff](https://github.com/CodebuffAI/codebuff) by the CodebuffAI team. Their thinker agent is the canonical reference for this design.
