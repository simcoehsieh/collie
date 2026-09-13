import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "./json.ts";
import { jsonRecord, jsonStringField } from "./stt/json.ts";
import type { CodexHandoffModel } from "./types.ts";

// Read Codex's own catalog; never start a model process or guess which efforts a model supports.
// Only non-secret model metadata is returned. A missing/malformed cache keeps launcher defaults.
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
export function parseHandoffModels(value: JsonValue): CodexHandoffModel[] {
  const rows = jsonRecord(value)?.models;
  if (!Array.isArray(rows)) return [];
  const result: CodexHandoffModel[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = jsonRecord(raw);
    if (!row || row.visibility !== "list") continue;
    const id = jsonStringField(row.slug);
    const label = jsonStringField(row.display_name);
    const levels = row.supported_reasoning_levels;
    if (!id || !NAME.test(id) || seen.has(id) || !Array.isArray(levels)) continue;
    const efforts = [...new Set(levels.map((v) => jsonStringField(jsonRecord(v)?.effort)).filter((v): v is string => v !== null && NAME.test(v)))];
    const preferred = jsonStringField(row.default_reasoning_level);
    if (efforts.length === 0) continue;
    seen.add(id);
    result.push({ id, label: label || id, efforts, defaultEffort: preferred && efforts.includes(preferred) ? preferred : efforts[0]! });
  }
  return result;
}

let cached: CodexHandoffModel[] = [];
let readAt = 0;
let running: Promise<CodexHandoffModel[]> | undefined;
export function readHandoffModels(): Promise<CodexHandoffModel[]> {
  if (running) return running;
  if (Date.now() - readAt < 10_000) return Promise.resolve(cached);
  running = (async () => {
    try {
      const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
      if ((await stat(path)).size > 2 * 1024 * 1024) {
        cached = [];
        return cached;
      }
      // SAFETY: JSON.parse returns JSON values; the parser validates every field before use.
      const value = JSON.parse(await readFile(path, "utf8")) as JsonValue;
      cached = parseHandoffModels(value);
    } catch {
      cached = [];
    } finally {
      readAt = Date.now();
      running = undefined;
    }
    return cached;
  })();
  return running;
}
