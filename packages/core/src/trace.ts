import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TraceLine } from "./models.ts";

export function tracePath(root: string, caseId: string): string {
  return join(root, "logs", caseId, "trace.jsonl");
}

export function writeTrace(root: string, line: TraceLine): void {
  const path = tracePath(root, line.case_id);
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(line)}\n`;
  appendFileSync(path, payload, "utf8");
  if (process.env.EXHIBIT_A_QUIET !== "1") process.stdout.write(payload);
}

export function emitTrace(
  root: string,
  partial: Omit<TraceLine, "timestamp" | "retry_count" | "tokens_in" | "tokens_out" | "model"> &
    Partial<Pick<TraceLine, "retry_count" | "tokens_in" | "tokens_out" | "model">>,
): TraceLine {
  const line: TraceLine = {
    timestamp: new Date().toISOString(),
    retry_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    model: null,
    ...partial,
  };
  writeTrace(root, line);
  return line;
}
