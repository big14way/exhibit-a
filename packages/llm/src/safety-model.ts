import type { SafetyModelResult } from "@exhibit-a/core";
import type { ChatRequest, ChatResult } from "./nim.ts";

/** Any chat-capable client: the NIM client or a test double. */
export type ChatClient = { chat(request: ChatRequest): Promise<ChatResult> };

/**
 * Second content-safety layer: NVIDIA's Nemotron content-safety model reads
 * the operator's question and the generated finding and labels both. The
 * deterministic lexical guard still runs first and always; this model can
 * only add a block, never lift one.
 */
export const SAMPLE_SAFETY_MODEL = "nvidia/nemotron-3.5-content-safety";

export const SAFETY_AGENT = "SafetyGuard";

export function buildSafetyRequest(input: {
  model: string;
  question: string;
  finding: string;
}): ChatRequest {
  return {
    agent: SAFETY_AGENT,
    model: input.model,
    messages: [
      { role: "user", content: input.question },
      { role: "assistant", content: input.finding },
    ],
    temperature: 0,
    max_tokens: 200,
  };
}

export function parseSafetyLabels(content: string): {
  user_safety: string | null;
  response_safety: string | null;
  categories: string[];
} {
  const user = content.match(/User Safety:\s*([A-Za-z]+)/i);
  const response = content.match(/Response Safety:\s*([A-Za-z]+)/i);
  const categories = content.match(/Safety Categories:\s*([^\n]+)/i);
  return {
    user_safety: user ? user[1]!.toLowerCase() : null,
    response_safety: response ? response[1]!.toLowerCase() : null,
    categories: categories
      ? categories[1]!
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  };
}

export async function runSafetyModel(input: {
  client: ChatClient | null;
  model: string | null;
  question: string;
  finding: string;
}): Promise<SafetyModelResult> {
  const empty = {
    user_safety: null,
    response_safety: null,
    categories: [],
    raw: "",
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
  if (!input.client || !input.model) {
    return {
      status: "skipped",
      model: input.model,
      detail: "no NVIDIA_API_KEY/NIM_SAFETY_MODEL or no recorded response; lexical guard only",
      ...empty,
    };
  }
  try {
    const reply = await input.client.chat(
      buildSafetyRequest({ model: input.model, question: input.question, finding: input.finding }),
    );
    const labels = parseSafetyLabels(reply.content);
    const detail =
      labels.response_safety === null
        ? "model reply had no Response Safety label; treated as unavailable"
        : `user ${labels.user_safety ?? "?"}, response ${labels.response_safety}` +
          (labels.categories.length ? ` (${labels.categories.join(", ")})` : "");
    return {
      status: "ran",
      model: reply.model || input.model,
      ...labels,
      detail,
      raw: reply.content,
      usage: reply.usage,
    };
  } catch (err) {
    return {
      status: "error",
      model: input.model,
      detail: `content-safety model failed; lexical guard decides: ${err instanceof Error ? err.message : String(err)}`,
      ...empty,
    };
  }
}
