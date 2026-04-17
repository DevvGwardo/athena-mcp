#!/usr/bin/env node
/**
 * thinker-mcp — an MCP server exposing a single `think` tool.
 *
 * Inspired by Codebuff's thinker agent (agents/thinker/thinker.ts):
 * a specialized agent with NO tools whose job is to reason deeply about a
 * problem and return a concise response. The tool-using agent (Hermes, Claude,
 * etc.) keeps orchestration; the thinker contributes pure reasoning via a
 * stronger model than the caller would normally use inline.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_MODEL = process.env.THINKER_MODEL ?? 'anthropic/claude-opus-4.6';
const DEFAULT_EFFORT = (process.env.THINKER_REASONING_EFFORT ?? 'high') as
  | 'low'
  | 'medium'
  | 'high';
const APP_NAME = process.env.THINKER_APP_NAME ?? 'thinker-mcp';
const APP_URL = process.env.THINKER_APP_URL ?? 'https://github.com/devgwardo/thinker-mcp';

const SYSTEM_PROMPT = `You are a thinker agent. You have no tools — your sole job is to reason.

Think carefully and deeply about the problem. You may use <think>...</think> tags to work through your reasoning; anything inside those tags will be stripped from the final response, so use them freely as scratch space.

When you are satisfied, write out a concise response that captures the essential insight, plan, or answer. Do not be verbose — say the minimum needed for the caller to act on your reasoning. Assume the caller will execute any code, edits, or commands; you should not produce those, only the thinking behind them.

If the caller gave you <context>, read it carefully before reasoning. If the context is insufficient to answer confidently, say so explicitly rather than guessing.`;

interface ThinkArgs {
  prompt: string;
  context?: string;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown;
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

async function think(args: ThinkArgs): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Export it in the Hermes environment or set it in your MCP server config.'
    );
  }

  const model = args.model ?? DEFAULT_MODEL;
  const effort = args.effort ?? DEFAULT_EFFORT;

  const userContent = args.context
    ? `<context>\n${args.context}\n</context>\n\n<prompt>\n${args.prompt}\n</prompt>`
    : args.prompt;

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const body = {
    model,
    messages,
    reasoning: { effort },
    // Explicitly ask OpenRouter to stream reasoning traces back in the response
    // so the caller can see the thinking if the model surfaces it.
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

  // Strip <think>...</think> blocks the way Codebuff's thinker does.
  const cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const usage = data.usage;
  const usageLine = usage
    ? `\n\n---\n_model: ${data.model ?? model} · tokens: ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out${usage.reasoning_tokens ? ` (${usage.reasoning_tokens} reasoning)` : ''}_`
    : `\n\n---\n_model: ${data.model ?? model}_`;

  // If the model returned separate reasoning content, include a brief note that
  // it's available but don't dump it by default — the caller asked for a concise
  // answer. They can ask for reasoning explicitly by passing a prompt that
  // requests it.
  const reasoningHint = reasoning
    ? `\n_(${reasoning.length} chars of reasoning trace suppressed)_`
    : '';

  return `${cleaned}${reasoningHint}${usageLine}`;
}

const server = new Server(
  { name: 'thinker-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'think',
      description:
        'Delegate deep reasoning to a stronger model. Use this when you hit a hard problem that benefits from careful step-by-step thought: architecture decisions, subtle bugs, plan critique, tricky logic. The thinker has NO tools — it only reasons and returns a concise response. You must gather any relevant context yourself and pass it in. Does not modify files, run commands, or access the network beyond the reasoning call. Costs tokens on the configured reasoning model.',
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
            description: `Optional OpenRouter model id override. Defaults to ${DEFAULT_MODEL}. Examples: anthropic/claude-opus-4.6, openai/gpt-5.4, google/gemini-3.1-pro-preview, deepseek/deepseek-r1.`,
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
  // Log to stderr so stdout stays a clean MCP channel.
  process.stderr.write(
    `thinker-mcp ready · default model: ${DEFAULT_MODEL} · effort: ${DEFAULT_EFFORT}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`thinker-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
