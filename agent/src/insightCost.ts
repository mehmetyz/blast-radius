import { costUsd } from "./pricing.js";
import type { PrFile } from "./github.js";

export type CostDrivers = {
  fromModel: string;
  toModel: string;
  fromCalls: number;
  toCalls: number;
  fromMaxTokens: number | null;
  toMaxTokens: number | null;
};

const MODEL_RE =
  /(?:MODEL\s*=\s*(?:process\.env\.\w+\s*\?\?\s*)?|model:\s*)["'`]([^"'`]+)["'`]/g;
const CREATE_RE = /\.chat\.completions\.create\s*\(/g;
const MAX_RE = /max_tokens:\s*(\d+)/;

export function modelKey(model: string): string {
  const raw = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return raw.replace(/^openai\//, "");
}

function splitPatch(patch: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff")) {
      continue;
    }
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else {
      const body = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(body);
      newLines.push(body);
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function modelsIn(text: string): string[] {
  const out: string[] = [];
  MODEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODEL_RE.exec(text))) {
    const v = m[1] ?? "";
    if (v && !v.includes("LLM_MODEL") && !v.includes("process.env")) out.push(v);
  }
  return out;
}

function createCount(text: string): number {
  return text.match(CREATE_RE)?.length ?? 0;
}

function maxTokens(text: string): number | null {
  const m = MAX_RE.exec(text);
  return m ? Number(m[1]) : null;
}

function tokenFactor(from: number | null, to: number | null): number {
  if (from && to && from > 0) return Math.min(3, Math.max(0.5, to / from));
  if (to && !from) return 1.5;
  if (from && !to) return 1 / 1.5;
  return 1;
}

export function costDeltaPct(d: CostDrivers): number {
  const fromCalls = Math.max(1, d.fromCalls);
  const toCalls = Math.max(1, d.toCalls);
  const from = costUsd(d.fromModel, 1000, 1000) * fromCalls;
  const to = costUsd(d.toModel, 1000, 1000) * toCalls * tokenFactor(d.fromMaxTokens, d.toMaxTokens);
  if (!(from > 0)) return 0;
  return ((to - from) / from) * 100;
}

export function describeCostDrivers(d: CostDrivers): string {
  const bits: string[] = [];
  if (modelKey(d.fromModel) !== modelKey(d.toModel)) {
    bits.push(`\`${d.fromModel}\` → \`${d.toModel}\``);
  }
  if (d.fromCalls !== d.toCalls) bits.push(`${d.fromCalls} → ${d.toCalls} completion calls`);
  if (d.fromMaxTokens !== d.toMaxTokens) {
    bits.push(`max_tokens ${d.fromMaxTokens ?? "unset"} → ${d.toMaxTokens ?? "unset"}`);
  }
  return bits.join(", ");
}

export function costDriversFromFiles(files: PrFile[], fallbackModel: string): CostDrivers {
  let fromModel = fallbackModel;
  let toModel = fallbackModel;
  let fromCalls = 0;
  let toCalls = 0;
  let fromMax: number | null = null;
  let toMax: number | null = null;
  let modelChangeSeen = false;
  let maxChangeSeen = false;

  for (const f of files) {
    if (!f.patch) continue;
    const { oldText, newText } = splitPatch(f.patch);

    const oldSet = new Set(modelsIn(oldText));
    const newSet = new Set(modelsIn(newText));
    const removed = [...oldSet].filter((m) => !newSet.has(m));
    const added = [...newSet].filter((m) => !oldSet.has(m));
    if (removed.length && added.length && !modelChangeSeen) {
      fromModel = removed[0]!;
      toModel = added[0]!;
      modelChangeSeen = true;
    }

    fromCalls += createCount(oldText);
    toCalls += createCount(newText);

    const oldMax = maxTokens(oldText);
    const newMax = maxTokens(newText);
    if (oldMax !== newMax && !maxChangeSeen) {
      fromMax = oldMax;
      toMax = newMax;
      maxChangeSeen = true;
    }
  }

  return {
    fromModel,
    toModel,
    fromCalls,
    toCalls,
    fromMaxTokens: fromMax,
    toMaxTokens: toMax,
  };
}
