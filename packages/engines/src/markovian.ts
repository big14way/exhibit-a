import { createHash } from "node:crypto";

export type ContextItem = {
  id: string;
  kind: string;
  text: string;
  sha256?: string;
};

export type ContextChunk = {
  ordinal: number;
  key: string;
  item_ids: string[];
  chars: number;
  text: string;
  previous: string | null;
  next: string | null;
};

export type ContextPack = {
  mode: "markovian-bounded";
  max_chars: number;
  total_chars: number;
  item_count: number;
  chunk_count: number;
  chunks: ContextChunk[];
  dropped: number;
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Markovian bounded context: pack evidence into consecutive windows with a
 * hard character cap and explicit previous/next transition keys. The critic
 * sees every item at most once, and the exhibit records exactly what fit.
 * This is intentionally a reference implementation of the engine contract,
 * not a claim to run the Meterless runtime.
 */
export function chunkContext(input: {
  items: ContextItem[];
  maxChars?: number;
  maxItems?: number;
}): ContextPack {
  const maxChars = Math.max(200, input.maxChars ?? 6000);
  const maxItems = Math.max(1, input.maxItems ?? 64);
  const items = input.items.slice(0, maxItems);
  const totalChars = items.reduce((sum, item) => sum + item.text.length, 0);
  const chunks: { item_ids: string[]; chars: number; text: string }[] = [];
  let current: { item_ids: string[]; chars: number; text: string } = {
    item_ids: [],
    chars: 0,
    text: "",
  };
  for (const item of items) {
    const line = `[${item.kind}] ${item.text}`;
    if (current.item_ids.length > 0 && current.chars + line.length > maxChars) {
      chunks.push(current);
      current = { item_ids: [], chars: 0, text: "" };
    }
    current.item_ids.push(item.id);
    current.chars += line.length;
    current.text += `${current.text ? "\n" : ""}${line}`;
  }
  if (current.item_ids.length > 0) chunks.push(current);

  const packed: ContextChunk[] = chunks.map((chunk, index) => ({
    ordinal: index,
    key: `ctx_${digest(chunk.text)}`,
    item_ids: chunk.item_ids,
    chars: chunk.chars,
    text: chunk.text,
    previous: index > 0 ? `ctx_${digest(chunks[index - 1]!.text)}` : null,
    next: index + 1 < chunks.length ? `ctx_${digest(chunks[index + 1]!.text)}` : null,
  }));

  return {
    mode: "markovian-bounded",
    max_chars: maxChars,
    total_chars: totalChars,
    item_count: items.length,
    chunk_count: packed.length,
    chunks: packed,
    dropped: Math.max(0, input.items.length - items.length),
  };
}

export function packPrompt(pack: ContextPack): string {
  return pack.chunks
    .map(
      (chunk) =>
        `--- ${chunk.key} (${chunk.chars} chars; prev ${chunk.previous ?? "none"}; next ${chunk.next ?? "none"}) ---\n${chunk.text}`,
    )
    .join("\n");
}
