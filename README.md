# thinker-mcp

An MCP server that exposes a single `think` tool — pure reasoning, no side effects.

Modeled after [Codebuff's thinker agent](https://github.com/CodebuffAI/codebuff/blob/main/agents/thinker/thinker.ts): a specialized agent with **no tools** whose only job is to reason deeply and return a concise response. The caller (Hermes, Claude, Cursor, whatever speaks MCP) keeps orchestration and tool use; the thinker contributes pure thought via a stronger model than the caller would normally run inline.

## Why

Most agents run on a single model that balances cost, speed, and quality. When that agent hits a genuinely hard problem — a subtle bug, an architecture trade-off, a plan that needs critique — you want it to call out to a heavier reasoning model (Claude Opus, GPT-5, Gemini Pro, DeepSeek R1) without ceding control of the rest of the task. That's what `think` is for.

Codebuff uses this pattern internally: their orchestrator agent ("Buffy") explicitly spawns `thinker-gpt` after gathering context for complex problems. The thinker sees the message history, reasons, returns a brief response, and the orchestrator keeps driving.

## Install

```bash
git clone <this-repo> ~/projects/thinker-mcp
cd ~/projects/thinker-mcp
npm install
npm run build
```

## Two backends

**`claude-code` (default when the `claude` CLI is on PATH)** — spawns `claude -p` for each call and uses your Anthropic Pro/Max subscription's OAuth. No API key required; usage counts against your subscription quota instead of per-token billing. Supports `opus`, `sonnet`, `haiku`, or full Claude model names.

**`openrouter`** — HTTPS call to OpenRouter. Any model (Claude via API, GPT, Gemini, DeepSeek, etc.) via per-token billing. Requires `OPENROUTER_API_KEY`.

Pick explicitly with `THINKER_BACKEND=claude-code` or `THINKER_BACKEND=openrouter`.

## Env vars

| Var | Backend | Default | Notes |
|---|---|---|---|
| `THINKER_BACKEND` | both | auto | `claude-code` if `claude` CLI found, else `openrouter` |
| `THINKER_MODEL` | both | `opus` (claude-code) / `anthropic/claude-opus-4.6` (openrouter) | Model to use |
| `THINKER_REASONING_EFFORT` | both | `high` | `low` / `medium` / `high` |
| `THINKER_CLAUDE_CLI` | claude-code | auto (PATH lookup) | Absolute path to `claude` binary |
| `THINKER_TIMEOUT_MS` | claude-code | 180000 | Subprocess timeout |
| `OPENROUTER_API_KEY` | openrouter | — | Required for openrouter backend |
| `THINKER_APP_NAME`, `THINKER_APP_URL` | openrouter | — | OpenRouter analytics headers |

## Register with Hermes

Hermes speaks MCP over stdio natively. Use the CLI:

**claude-code backend (subscription):**

```bash
hermes mcp add thinker \
  --command /path/to/node \
  --args /Users/YOU/projects/thinker-mcp/dist/index.js \
  --env THINKER_CLAUDE_CLI=/opt/homebrew/bin/claude
```

**openrouter backend (API):**

```bash
hermes mcp add thinker \
  --command /path/to/node \
  --args /Users/YOU/projects/thinker-mcp/dist/index.js \
  --env THINKER_BACKEND=openrouter OPENROUTER_API_KEY=sk-or-v1-... THINKER_MODEL=anthropic/claude-opus-4.6
```

Verify:

```bash
hermes mcp list       # should show `thinker`
hermes mcp test thinker  # should report "✓ Connected" and discover 1 tool
```

Restart Hermes (or start a new session) to make the tool available to the agent.

## Use it from any MCP client

The tool is called `think`. Input schema:

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The problem to reason about. Can be brief. |
| `context` | string | no | Relevant code, conversation excerpt, error messages. Thinker cannot read files — paste anything it needs. |
| `effort` | `low`\|`medium`\|`high` | no | Reasoning effort. Defaults to `THINKER_REASONING_EFFORT`. |
| `model` | string | no | OpenRouter model id override. Defaults to `THINKER_MODEL`. |

Example JSON-RPC call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "think",
    "arguments": {
      "prompt": "Is there a race condition in the claim() function and if so what's the minimal fix?",
      "context": "def claim(self, resource_id):\n    if self.claims.get(resource_id):\n        return False\n    self.claims[resource_id] = self.agent_id\n    return True",
      "effort": "high"
    }
  }
}
```

## How it differs from just using a better model

You could point Hermes at Claude Opus directly and skip the thinker. Reasons not to:

1. **Cost** — Opus for every turn gets expensive. Calling it only when stuck is cheaper.
2. **Latency** — reasoning models are slow. You want them for hard problems, not routine tool calls.
3. **Tool orthogonality** — the thinker has no tools on purpose. The caller stays in control of side effects.
4. **Model portability** — you can A/B different reasoning models per call without reconfiguring the whole agent.

## Design notes

- Stateless — each `think` call is independent. If you want conversation continuity, pass it in via `context`.
- Stdio-only transport. Matches how Hermes already loads `brain-mcp`.
- `<think>...</think>` blocks in the model's response are stripped before returning, matching Codebuff's convention (gives the model scratch space without polluting the output).
- The raw `reasoning` field (when OpenRouter returns one separately) is not dumped in the response by default — we return just a length hint. Add a flag later if you want to surface full reasoning traces.
- No retry logic. If OpenRouter errors, the error is surfaced to the caller so they can decide whether to retry.

## Development

```bash
npm run dev   # tsc --watch
npm run build
npm start     # runs dist/index.js (expects stdio peer — use an MCP client)
```

Smoke test without a real API key:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

## License

MIT
