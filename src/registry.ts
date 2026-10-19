import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import type { AgentCard } from "./types.js";

const DATA_DIR = join(ROOT, "data");
const FILE = join(DATA_DIR, "agents.json");

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "")
      .slice(0, 40) || `agent-${Date.now()}`
  );
}

export function loadRegistry(): AgentCard[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf-8")) as AgentCard[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveRegistry(cards: AgentCard[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cards, null, 2) + "\n", "utf-8");
}
