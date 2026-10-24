import type { Cassette } from "@exhibit-a/core";
import { lookupModel, type CassetteRecorder } from "@exhibit-a/core";
import { Budget, budgetFromEnv, type Usage } from "./budget.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  agent: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  json?: boolean;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ChatResult = {
  content: string;
  tool_calls: ToolCall[];
  usage: Usage;
  model: string;
};

export type EmbedRequest = {
  agent: string;
  model: string;
  input: string[];
  input_type?: "query" | "passage";
};

export type EmbedResult = {
  model: string;
  embeddings: number[][];
  usage: Usage;
};

export type NimConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  budget?: Budget;
  cassette?: Cassette;
  recorder?: CassetteRecorder;
  fetchImpl?: typeof fetch;
};

/**
 * NVIDIA NIM (OpenAI-compatible) client. SAMPLE_MODE replays a recorded
 * response keyed by the whole request; live mode validates the shape and
 * retries 429/5xx. A malformed response never turns into a fact tool call.
 */
export class NimClient {
  private readonly budget: Budget;

  constructor(private readonly cfg: NimConfig) {
    this.budget = cfg.budget ?? budgetFromEnv();
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (this.cfg.cassette) {
      return lookupModel(this.cfg.cassette, request.agent, request) as ChatResult;
    }
    const body = {
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      temperature: request.temperature ?? 0,
      max_tokens: request.max_tokens ?? 1024,
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    };
    const maxRetries = this.cfg.maxRetries ?? 2;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await this.post(body, request.model);
        this.budget.spend(result.usage);
        this.cfg.recorder?.recordModel(request.agent, request, result);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable = /NIM (429|5\d\d)/.test(lastError.message) || lastError.name === "TimeoutError";
        if (!retryable || attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error("NIM request failed");
  }

  /**
   * Embedding role (H-MEM recall). Replayed from the cassette in SAMPLE_MODE
   * exactly like chat; live calls are retried on 429/5xx and metered through
   * the same spend ledger. Vectors are rounded so the recorded cassette stays
   * small and the live and replayed results hash identically.
   */
  async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (this.cfg.cassette) {
      return lookupModel(this.cfg.cassette, request.agent, request) as EmbedResult;
    }
    const body = {
      model: request.model,
      input: request.input,
      input_type: request.input_type ?? "query",
      encoding_format: "float",
    };
    const result = await this.withRetry(async () => {
      const doFetch = this.cfg.fetchImpl ?? fetch;
      const res = await doFetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`NIM ${res.status}: ${text.slice(0, 300)}`);
      }
      const raw = (await res.json()) as {
        model?: string;
        data?: { index?: number; embedding?: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      const data = [...(raw.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== request.input.length) {
        throw new Error(
          `NIM embeddings returned ${data.length} vectors for ${request.input.length} inputs`,
        );
      }
      const embeddings = data.map((row) => {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new Error("NIM embedding row has no vector");
        }
        return row.embedding.map((value) => Math.round(value * 1e5) / 1e5);
      });
      return {
        model: raw.model ?? request.model,
        embeddings,
        usage: { prompt_tokens: raw.usage?.prompt_tokens ?? 0, completion_tokens: 0 },
      } satisfies EmbedResult;
    });
    this.budget.spend(result.usage);
    this.cfg.recorder?.recordModel(request.agent, request, result);
    return result;
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    const maxRetries = this.cfg.maxRetries ?? 2;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable =
          /NIM (429|5\d\d)/.test(lastError.message) || lastError.name === "TimeoutError";
        if (!retryable || attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error("NIM request failed");
  }

  get spend(): Budget["summary"] {
    return this.budget.summary;
  }

  private async post(body: Record<string, unknown>, model: string): Promise<ChatResult> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`NIM ${res.status}: ${text.slice(0, 300)}`);
    }
    const raw = (await res.json()) as {
      model?: string;
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = raw.choices?.[0]?.message;
    if (!message) throw new Error("NIM response has no message");
    const toolCalls: ToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) throw new Error("NIM tool call has no function name");
      let args: unknown = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        throw new Error(`NIM tool call ${name} returned non-JSON arguments`);
      }
      toolCalls.push({ id: call.id ?? `call_${toolCalls.length}`, name, arguments: args });
    }
    return {
      content: message.content ?? "",
      tool_calls: toolCalls,
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens ?? 0,
        completion_tokens: raw.usage?.completion_tokens ?? 0,
      },
      model: raw.model ?? model,
    };
  }
}

export type NimRoles = {
  apiKey: string;
  baseUrl: string;
  lead: string;
  critic: string;
  scout: string;
  embed: string;
  safety: string;
};

/** Model IDs are configured, never guessed. */
export function nimRolesFromEnv(): NimRoles | null {
  const apiKey = process.env.NVIDIA_API_KEY;
  const lead = process.env.NIM_LEAD_MODEL;
  if (!apiKey || !lead) return null;
  return {
    apiKey,
    baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    lead,
    critic: process.env.NIM_CRITIC_MODEL ?? lead,
    scout: process.env.NIM_SCOUT_MODEL ?? lead,
    embed: process.env.NIM_EMBED_MODEL ?? "",
    safety: process.env.NIM_SAFETY_MODEL ?? "",
  };
}

export function createNimClient(input?: {
  roles?: NimRoles | null;
  cassette?: Cassette;
  recorder?: CassetteRecorder;
  budget?: Budget;
  fetchImpl?: typeof fetch;
}): NimClient | null {
  const roles = input?.roles ?? nimRolesFromEnv();
  if (!roles) return null;
  return new NimClient({
    apiKey: roles.apiKey,
    baseUrl: roles.baseUrl,
    cassette: input?.cassette,
    recorder: input?.recorder,
    budget: input?.budget,
    fetchImpl: input?.fetchImpl,
  });
}
