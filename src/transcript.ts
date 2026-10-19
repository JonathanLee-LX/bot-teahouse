/** 实验全记录：把每一次协作事件实时追加写入 data/transcripts/<runId>/events.jsonl。
 *  用同步写，保证进程被 SIGTERM/SIGKILL 杀掉时，已发生的事件不丢失。
 *  日志只写不读，写失败绝不中断运行。 */

import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";

export type TranscriptEvent =
  | { type: "run_start"; model: string; agents: { id: string; name: string; role: string }[] }
  | { type: "group_user"; text: string }
  | { type: "group_round_start"; round: number }
  | { type: "group_agent"; round: number; who: string; text: string }
  | { type: "group_skip"; round: number; who: string }
  | { type: "group_error"; round: number; who: string; message: string }
  | { type: "group_end"; rounds: number }
  | { type: "group_budget_stop"; rounds: number; tokens: number }
  | { type: "dm_user"; to: string; text: string }
  | { type: "dm_agent"; from: string; text: string }
  | { type: "ask"; from: string; to: string; question: string; direct: boolean }
  | { type: "ask_reply"; from: string; to: string; direct: boolean; text: string }
  | { type: "handoff"; from: string; to: string; task: string; progress: string; reason: string; nextStep: string; context?: string }
  | { type: "broadcast"; from: string; text: string }
  | { type: "create_agent"; name: string; id: string; role: string; parent: string }
  | { type: "tool_call"; who: string; tool: string; args: string; ok: boolean; ms: number; output: string }
  | { type: "run_end"; tokens: { input: number; output: number } }
  // 运维事件：心跳（定位死亡时间点 + 观察内存爬升）、crash（临终遗言）
  | { type: "heartbeat"; round: number; rssMB: number; heapUsedMB: number; heapTotalMB: number }
  | { type: "crash"; kind: string; message: string; rssMB: number; heapUsedMB: number; heapTotalMB: number }
  // room 模型事件：room 是共享上下文空间，hub 只存消息/广播/记账，不做发言决策
  | { type: "room_create"; roomId: string; name: string; by: string }
  | { type: "room_join"; roomId: string; roomName: string; agent: string }
  | { type: "room_message"; roomId: string; roomName: string; seq: number; from: string; text: string }
  | { type: "agent_crash"; agentId: string; name: string; code: number | null; signal: string | null; rssMB: number; heapUsedMB: number; heapTotalMB: number }
  | { type: "agent_restart"; agentId: string; name: string; attempt: number }
  | { type: "agent_dead"; agentId: string; name: string; restarts: number }
  | { type: "room_quiet_end"; quietSeconds: number }
  | { type: "room_budget_stop"; tokens: number }
  | { type: "round_start"; roomId: string; roomName: string; round: number; members: string[] }
  | { type: "round_end"; roomId: string; roomName: string; round: number; spoke: number; skipped: number }
  | { type: "round_converged"; roomId: string; roomName?: string; round?: number; reason: string }
  | { type: "round_resume"; roomId: string; roomName: string; round: number; pending: string[]; reason: string }
  | { type: "round_reply"; roomId: string; roomName: string; round: number; agent: string; spoke: boolean }
  | { type: "run_resume"; runId: string; reason: string; round: number }
  | { type: "operator_note"; text: string };

export class Transcript {
  readonly runId: string;
  readonly dir: string;
  private file: string;
  private closed = false;

  constructor(resumeRunId?: string) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    this.runId =
      resumeRunId ??
      (`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
    this.dir = join(ROOT, "data", "transcripts", this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, "events.jsonl");
    // LATEST 指向最近一次运行，方便直接看"上一次发生了什么"
    try {
      const latest = join(ROOT, "data", "transcripts", "LATEST");
      if (existsSync(latest)) unlinkSync(latest);
      writeFileSync(latest, this.runId);
    } catch {
      /* 忽略：指针写失败不影响记录本身 */
    }
  }

  log(event: TranscriptEvent): void {
    if (this.closed) return;
    try {
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    } catch {
      /* 忽略：记录失败绝不中断实验 */
    }
  }

  close(): void {
    this.closed = true;
  }
}
