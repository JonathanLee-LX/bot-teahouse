/**
 * 真实场景项目工具：让 agent 直接操作 ~/workspace/gtd-attach-exp 仓库。
 * - sh:    在项目目录执行 shell（timeout 180s），可跑 pnpm test/build、wrangler 等
 * - read:  读文件（防目录穿越）
 * - write: 写整个文件
 * - edit:  精确字符串替换
 *
 * 安全兜底（只防生产事故，不限制行为）：
 * - cwd 锁死项目目录；读写路径必须落在项目目录内
 * - 拒绝直连生产 Cloudflare：wrangler 带 --remote 必须同时用 -c wrangler.exp.json；
 *   pnpm db:migrate / pnpm deploy（生产脚本）一律拒绝
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";

export const PROJECT_DIR = resolve(homedir(), "workspace", "gtd-attach-exp");
export const EXP_WRANGLER_CONFIG = "wrangler.exp.json";

function insideProject(p: string): string {
  const abs = resolve(PROJECT_DIR, p);
  if (abs !== PROJECT_DIR && !abs.startsWith(PROJECT_DIR + sep)) {
    throw new Error(`路径越界，已拒绝：${p}`);
  }
  return abs;
}

export function projectRead(path: string, offset?: number, limit?: number): string {
  const abs = insideProject(path);
  if (!existsSync(abs)) throw new Error(`文件不存在：${path}`);
  const lines = readFileSync(abs, "utf8").split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit ? start + limit : lines.length;
  const slice = lines.slice(start, Math.min(end, lines.length));
  const out = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
  return `(共 ${lines.length} 行，显示 ${start + 1}-${start + slice.length} 行)\n${out}`;
}

export function projectWrite(path: string, content: string): string {
  const abs = insideProject(path);
  writeFileSync(abs, content, "utf8");
  return `已写入 ${path}（${content.length} 字符）`;
}

export function projectEdit(path: string, oldText: string, newText: string): string {
  const abs = insideProject(path);
  if (!existsSync(abs)) throw new Error(`文件不存在：${path}`);
  const src = readFileSync(abs, "utf8");
  const idx = src.indexOf(oldText);
  if (idx === -1) throw new Error(`未找到待替换文本（old_text 不匹配）`);
  if (src.indexOf(oldText, idx + 1) !== -1) {
    throw new Error(`old_text 有多处匹配，请给更长的上下文以唯一确定`);
  }
  writeFileSync(abs, src.slice(0, idx) + newText + src.slice(idx + oldText.length), "utf8");
  return `已替换 ${path} 中的一处文本`;
}

/** 生产 Cloudflare 防护：只允许实验配置 */
function guardCloudflare(cmd: string): void {
  const usesWrangler = /(^|[\s;|&])wrangler[\s]/.test(cmd) || cmd.trimStart().startsWith("wrangler ");
  if (!usesWrangler) return;
  const expCfg = cmd.includes(EXP_WRANGLER_CONFIG);
  if (/(^|[\s])pnpm\s+(db:migrate|deploy)(\s|$)/.test(cmd)) {
    throw new Error(
      `已拒绝：pnpm db:migrate / pnpm deploy 是生产脚本（直连生产 D1/worker gtd）。` +
        `实验只能用 -c ${EXP_WRANGLER_CONFIG} 的 wrangler 命令。`
    );
  }
  if (cmd.includes("--remote") && !expCfg) {
    throw new Error(
      `已拒绝：wrangler --remote 未指定实验配置。实验 Cloudflare 操作必须带 -c ${EXP_WRANGLER_CONFIG}。`
    );
  }
  if (/(^|[\s;|&])wrangler\s+deploy\b/.test(cmd) && !expCfg) {
    throw new Error(
      `已拒绝：wrangler deploy 未指定实验配置（会覆盖生产 worker gtd）。必须带 -c ${EXP_WRANGLER_CONFIG}。`
    );
  }
  if (/(^|[\s;|&])wrangler\s+d1\s/.test(cmd) && !expCfg) {
    throw new Error(
      `已拒绝：wrangler d1 未指定实验配置（会碰生产 D1 gtd）。必须带 -c ${EXP_WRANGLER_CONFIG}。`
    );
  }
  if (/(^|[\s;|&])wrangler\s+r2\s/.test(cmd) && !expCfg) {
    throw new Error(
      `已拒绝：wrangler r2 未指定实验配置。必须带 -c ${EXP_WRANGLER_CONFIG}。`
    );
  }
}

export interface ShResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function projectSh(command: string, timeoutMs = 180_000): Promise<ShResult> {
  guardCloudflare(command);
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      { cwd: PROJECT_DIR, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: (stdout || "").slice(-6000),
          stderr: (stderr || "").slice(-3000),
          timedOut: !!err?.killed,
        });
      }
    );
  });
}
