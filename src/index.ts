#!/usr/bin/env node
/**
 * thinker-mcp — an MCP server exposing a single `think` tool.
 *
 * Inspired by Codebuff's thinker agent (agents/thinker/thinker.ts):
 * a specialized agent with NO tools whose job is to reason deeply about a
 * problem and return a concise response. The tool-using agent (Hermes, Claude,
 * etc.) keeps orchestration; the thinker contributes pure reasoning.
 *
 * Two backends:
 *   - `claude-code` — spawns `claude -p` and uses the user's Anthropic
 *     subscription (Pro/Max) OAuth. No per-token billing, just counts against
 *     subscription usage. Supports `opus` / `sonnet` / `haiku` models.
 *   - `openrouter` — HTTPS call to OpenRouter. Any model (Claude, GPT, Gemini,
 *     DeepSeek, etc.) via per-token billing.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

type Backend = 'claude-code' | 'openrouter';
type Effort = 'low' | 'medium' | 'high';

function detectBackend(): Backend {
  const explicit = process.env.THINKER_BACKEND?.trim().toLowerCase();
  if (explicit === 'claude-code' || explicit === 'openrouter') return explicit;
  // Default: prefer claude-code if the CLI is reachable, else fall back to openrouter.
  return claudeCliPath() ? 'claude-code' : 'openrouter';
}

function claudeCliPath(): string | null {
  // Only check PATH entries; never shell out to `which` here to avoid a spawn
  // on every server startup. PATH resolution is good enough.
  const override = process.env.THINKER_CLAUDE_CLI;
  if (override && existsSync(override)) return override;
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':').filter(Boolean)) {
    const candidate = `${dir}/claude`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const BACKEND: Backend = detectBackend();
const DEFAULT_EFFORT: Effort = (process.env.THINKER_REASONING_EFFORT ?? 'high') as Effort;
const DEFAULT_MODEL =
  process.env.THINKER_MODEL ??
  (BACKEND === 'claude-code' ? 'opus' : 'anthropic/claude-opus-4.6');

const APP_NAME = process.env.THINKER_APP_NAME ?? 'thinker-mcp';
const APP_URL = process.env.THINKER_APP_URL ?? 'https://github.com/devgwardo/thinker-mcp';

// Timeout for claude-code subprocess calls.
const CLAUDE_TIMEOUT_MS = Number(process.env.THINKER_TIMEOUT_MS ?? 180_000);

const SYSTEM_PROMPT = `You are a thinker agent. You have no tools — your sole job is to reason.

Think carefully and deeply about the problem. You may use <think>...</think> tags to work through your reasoning; anything inside those tags will be stripped from the final response, so use them freely as scratch space.

When you are satisfied, write out a concise response that captures the essential insight, plan, or answer. Do not be verbose — say the minimum needed for the caller to act on your reasoning. Assume the caller will execute any code, edits, or commands; you should not produce those, only the thinking behind them.

If the caller gave you <context>, read it carefully before reasoning. If the context is insufficient to answer confidently, say so explicitly rather than guessing.`;

interface ThinkArgs {
  prompt: string;
  context?: string;
  effort?: Effort;
  model?: string;
}

// ---------------------------------------------------------------------------
// claude-code backend
// ---------------------------------------------------------------------------

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

async function thinkViaClaudeCode(args: ThinkArgs, userContent: string): Promise<string> {
  const cli = claudeCliPath();
  if (!cli) {
    throw new Error(
      'claude CLI not found on PATH. Install Claude Code or set THINKER_BACKEND=openrouter.'
    );
  }

  const model = args.model ?? DEFAULT_MODEL;
  const effort = args.effort ?? DEFAULT_EFFORT;

  const cliArgs = [
    '-p',
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'json',
    '--setting-sources', 'user',
    '--model', model,
    '--effort', effort,
    '--system-prompt', SYSTEM_PROMPT,
    userContent,
  ];

  // Run from a neutral cwd so project-level CLAUDE.md files don't leak into
  // the thinker's context.
  const cwd = tmpdir();

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(cli, cliArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude spawn failed: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${err.trim() || out.trim() || '(no output)'}`));
        return;
      }
      resolve(out);
    });
  });

  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`claude -p returned non-JSON output: ${stdout.slice(0, 500)}`);
  }

  if (parsed.is_error) {
    throw new Error(`claude -p reported error: ${parsed.result ?? '(no message)'}`);
  }

  const rawResult = parsed.result ?? '';
  const cleaned = rawResult.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const usage = parsed.usage;
  const duration = parsed.duration_ms ? `${(parsed.duration_ms / 1000).toFixed(1)}s` : '?';
  const tokenInfo = usage
    ? ` · ${usage.input_tokens ?? '?'} in / ${usage.output_tokens ?? '?'} out`
    : '';

  return `${cleaned}\n\n---\n_backend: claude-code (subscription) · model: ${model} · effort: ${effort} · ${duration}${tokenInfo}_`;
}

// ---------------------------------------------------------------------------
// openrouter backend
// ---------------------------------------------------------------------------

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
  };
  error?: { message?: string; code?: number };
  model?: string;
}

async function thinkViaOpenRouter(args: ThinkArgs, userContent: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Either export it, or set THINKER_BACKEND=claude-code.'
    );
  }

  const model = args.model ?? DEFAULT_MODEL;
  const effort = args.effort ?? DEFAULT_EFFORT;

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    reasoning: { effort },
    include_reasoning: true,
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': APP_URL,
      'X-Title': APP_NAME,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const choice = data.choices?.[0];
  const rawContent = choice?.message?.content ?? '';
  const reasoning = choice?.message?.reasoning ?? '';
  const cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const usage = data.usage;
  const tokenInfo = usage
    ? ` · ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out${usage.reasoning_tokens ? ` (${usage.reasoning_tokens} reasoning)` : ''}`
    : '';
  const reasoningHint = reasoning ? `\n_(${reasoning.length} chars of reasoning trace suppressed)_` : '';

  return `${cleaned}${reasoningHint}\n\n---\n_backend: openrouter · model: ${data.model ?? model} · effort: ${effort}${tokenInfo}_`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function think(args: ThinkArgs): Promise<string> {
  const userContent = args.context
    ? `<context>\n${args.context}\n</context>\n\n<prompt>\n${args.prompt}\n</prompt>`
    : args.prompt;

  return BACKEND === 'claude-code'
    ? thinkViaClaudeCode(args, userContent)
    : thinkViaOpenRouter(args, userContent);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const modelExamples =
  BACKEND === 'claude-code'
    ? 'opus, sonnet, haiku, or full Claude model names like claude-opus-4-6'
    : 'anthropic/claude-opus-4.6, openai/gpt-5.4, google/gemini-3.1-pro-preview, deepseek/deepseek-r1';

const server = new Server(
  { name: 'thinker-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'think',
      description:
        'Delegate deep reasoning to a stronger model. Use this when you hit a hard problem that benefits from careful step-by-step thought: architecture decisions, subtle bugs, plan critique, tricky logic. The thinker has NO tools — it only reasons and returns a concise response. You must gather any relevant context yourself and pass it in via the `context` arg. Does not modify files, run commands, or access the network beyond the reasoning call.',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description:
              'The problem to think about. Can be brief — the thinker will reason about it carefully. Example: "Is this race condition in the claim() function real, and if so what\'s the minimal fix?"',
          },
          context: {
            type: 'string',
            description:
              'Optional. Relevant code, conversation excerpts, error messages, or other material the thinker needs. The thinker cannot read files, so anything it needs to see must be pasted here.',
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: `Optional reasoning effort override. Defaults to ${DEFAULT_EFFORT}. Use "high" for the hardest problems, "low" for quick sanity checks.`,
          },
          model: {
            type: 'string',
            description: `Optional model override. Defaults to ${DEFAULT_MODEL}. Accepted values for current backend (${BACKEND}): ${modelExamples}.`,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'think') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = (request.params.arguments ?? {}) as Partial<ThinkArgs>;
  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    throw new Error('`prompt` is required and must be a non-empty string.');
  }

  try {
    const response = await think({
      prompt: args.prompt,
      context: typeof args.context === 'string' ? args.context : undefined,
      effort: args.effort,
      model: typeof args.model === 'string' ? args.model : undefined,
    });
    return { content: [{ type: 'text', text: response }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `thinker-mcp error: ${message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `thinker-mcp ready · backend: ${BACKEND} · model: ${DEFAULT_MODEL} · effort: ${DEFAULT_EFFORT}\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `thinker-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
