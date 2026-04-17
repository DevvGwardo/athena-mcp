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

Set your API key (get one at https://openrouter.ai/keys):

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

Optional env vars:

- `THINKER_MODEL` — default OpenRouter model id. Defaults to `anthropic/claude-opus-4.6`. Other good reasoning choices: `openai/gpt-5.4`, `google/gemini-3.1-pro-preview`, `deepseek/deepseek-r1`.
- `THINKER_REASONING_EFFORT` — `low` | `medium` | `high`. Defaults to `high`.
- `THINKER_APP_NAME`, `THINKER_APP_URL` — OpenRouter analytics headers.

## Register with Hermes

Hermes already speaks MCP over stdio. Two options:

**Option 1: CLI**

```bash
hermes mcp add thinker --command node --args /Users/YOU/projects/thinker-mcp/dist/index.js --env OPENROUTER_API_KEY=sk-or-v1-...
```

**Option 2: Edit `~/.hermes/config.yaml`**

Append the absolute path under `mcp_servers`:

```yaml
mcp_servers:
  - /Users/YOU/brain-mcp/dist/index.js
  - /Users/YOU/projects/thinker-mcp/dist/index.js
```

Make sure `OPENROUTER_API_KEY` is in the environment Hermes runs under.

Verify Hermes sees the tool:

```bash
hermes mcp list
```

You should see `thinker` in the output with `think` as an available tool.

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
