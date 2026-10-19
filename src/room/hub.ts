/** RoomHub：dumb pipe + supervision。
 *
 * 只做四件事：
 *  1. 存消息：每个 room 一个 append-only 日志（内存 + 实录落盘）。
 *  2. 投递：自由发言模式下新消息原样广播给所有成员；回合制下按"屏障同步"每轮同时投递。
 *     不读内容、不做决定、不转述。
 *  3. 记账：token ledger、cursor（投递位置）。
 *  4. supervision：worker 进程崩溃/失联时自动重启，从落盘会话恢复、从 cursor 处补发消息。
 *
 * 不做的事：不决定谁发言；回合制下发言顺序由回复速度自然决定，hub 只做屏障同步（等所有人
 * 回完再开下一轮）；不代理转达。
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths.js";
import { Transcript } from "../transcript.js";
import { memMB } from "../crashGuard.js";
import type { AgentCard, TokenUsage } from "../types.js";
import { loadRegistry, saveRegistry, slugify } from "../registry.js";
import type { H2W, RoomInfo, RoomMsg, W2H, WorkerConfig } from "./protocol.js";

const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const HEARTBEAT_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const JOIN_HISTORY_N = 10;

interface RoomRec {
  id: string;
  name: string;
  members: Set<string>; // agent id
  log: RoomMsg[];
  seq: number;
  // ---- 回合制（TURN_MODEL=1 时启用）：屏障同步，无叫号顺序 ----
  // 每轮 hub 把新消息同时投递给所有存活成员（回复顺序按各自响应速度，无指定顺序）；
  // 全部成员回复（发言或 <skip>）后进入下一轮；一轮全 skip 即自然收敛。
  // hub 只做屏障同步，不读内容、不做发言决策。
  round: number; // 当前轮次（从 1 开始）
  roundActive: boolean; // 本轮是否进行中
  roundPending: Set<string>; // 本轮尚未回复的 agent id
  roundTotal: number; // 本轮参与人数
  roundSpoke: number; // 本轮已发言人数
}

/** 断点续跑：barrier 状态落盘格式 */
interface BarrierState {
  roomId: string;
  roomName: string;
  round: number;
  roundActive: boolean;
  pending: string[]; // agent id
  total: number;
  spoke: number;
  members: string[]; // agent id
  at: string;
}

interface WorkerRec {
  card: AgentCard;
  sessionDir: string;
  proc: ChildProcess | null;
  cursor: Record<string, number>;
  lastHeartbeat: number;
  lastMem: { rssMB: number; heapUsedMB: number; heapTotalMB: number };
  restarts: number;
  dead: boolean;
  busy: boolean;
  shuttingDown: boolean;
  registered: boolean;
  restartTimer?: NodeJS.Timeout;
}

let roomSeq = 0;

export class RoomHub {
  private rooms = new Map<string, RoomRec>();
  private workers = new Map<string, WorkerRec>();
  private cards = new Map<string, AgentCard>();
  private ledger = new Map<string, TokenUsage>();
  private lastMessageAt = Date.now();
  private watchdog?: NodeJS.Timeout;
  /** hub 构造时刻 = 实验开始时刻，只用于"墙上的钟"，不做任何判定。断点续跑时可覆盖为原实验开始时间。 */
  private startedAt = new Date().toISOString();
  setStartedAt(iso: string): void {
    this.startedAt = iso;
  }
  /** 操作员信箱消费游标（内存） */
  private opInboxCursor = 0;
  /**
   * 回合制开关（TURN_MODEL=1）：屏障同步——每轮新消息同时投递给所有存活成员，
   * 全部回复后进入下一轮；一轮全 skip 即自然收敛。依然是 dumb pipe：只做屏障同步，
   * 不读内容、不决定谁发言（顺序由回复速度自然决定）。
   */
  turnModel = false;
  /** 回合制收敛旗：一整轮全 skip 即置位，主循环据此收尾。 */
  converged = false;

  /**
   * 操作员干预通道：用户授权的外部操作员（如 min）在必要时递提示信息。
   * hub 只做搬运：读 data/control/<runId>/msgs.jsonl 里新增的 {text} 行，原样返回，不读内容做判断。
   * 调用方以"用户"身份 post 进 room，等同于用户本人在 room 里说话。
   */
  drainOperatorInbox(): string[] {
    const file = join(ROOT, "data", "control", this.transcript.runId, "msgs.jsonl");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const fresh = lines.slice(this.opInboxCursor);
    this.opInboxCursor = lines.length;
    const out: string[] = [];
    for (const line of fresh) {
      try {
        const o = JSON.parse(line) as { text?: unknown };
        if (typeof o.text === "string" && o.text.trim().length > 0) out.push(o.text);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  }

  constructor(readonly transcript: Transcript) {
    for (const c of loadRegistry()) this.cards.set(c.id, c);
  }

  // ---------- agent 注册表 ----------

  defineAgent(input: {
    name: string;
    role: string;
    tools?: string[];
    resources?: string[];
    approve?: boolean;
    spend?: boolean;
    parent?: string;
  }): AgentCard {
    let id = slugify(input.name);
    let n = 2;
    while (this.cards.has(id)) id = `${slugify(input.name)}-${n++}`;
    const card: AgentCard = {
      id,
      name: input.name.trim(),
      role: input.role.trim(),
      tools: input.tools ?? [],
      resources: input.resources ?? [],
      permissions: { approve: !!input.approve, spend: !!input.spend },
      parent: input.parent ?? "user",
      createdAt: new Date().toISOString(),
    };
    this.cards.set(id, card);
    this.ledger.set(id, { input: 0, output: 0 });
    this.transcript.log({
      type: "create_agent",
      name: card.name,
      id: card.id,
      role: card.role,
      parent: this.cards.get(input.parent ?? "user")?.name ?? input.parent ?? "user",
    });
    saveRegistry(this.listAgents());
    return card;
  }

  listAgents(): AgentCard[] {
    return [...this.cards.values()];
  }

  getCard(idOrName: string): AgentCard | undefined {
    const key = slugify(idOrName);
    return (
      this.cards.get(key) ?? [...this.cards.values()].find((c) => c.name === idOrName)
    );
  }

  // ---------- room ----------

  createRoom(name: string, by: string): RoomRec {
    const id = `room-${++roomSeq}-${slugify(name) || "room"}`;
    const room: RoomRec = {
      id,
      name: name.trim(),
      members: new Set(),
      log: [],
      seq: 0,
      round: 1,
      roundActive: false,
      roundPending: new Set(),
      roundTotal: 0,
      roundSpoke: 0,
    };
    this.rooms.set(id, room);
    this.transcript.log({ type: "room_create", roomId: id, name: room.name, by });
    return room;
  }

  resolveRoom(ref: string): RoomRec | undefined {
    return (
      this.rooms.get(ref) ??
      [...this.rooms.values()].find((r) => r.name === ref.trim())
    );
  }

  /** 拉人进 room（幂等）。被拉的 worker 会收到 room_joined + 最近消息，直接可参与。 */
  joinRoom(roomId: string, agentId: string, by: string): boolean {
    const room = this.rooms.get(roomId);
    const card = this.cards.get(agentId);
    if (!room || !card) return false;
    const isNew = !room.members.has(agentId);
    room.members.add(agentId);
    if (isNew) {
      this.transcript.log({ type: "room_join", roomId, roomName: room.name, agent: card.name });
      const rec = this.workers.get(agentId);
      if (rec?.proc && rec.registered) {
        this.send(rec, {
          kind: "room_joined",
          room: this.roomInfo(room),
          history: room.log.slice(-JOIN_HISTORY_N),
        });
        // 回合制：如果正好有轮在跑，新成员直接加入本轮屏障（和大家一起回复）
        if (this.turnModel && room.roundActive && !rec.dead && !room.roundPending.has(agentId)) {
          room.roundPending.add(agentId);
          room.roundTotal++;
          const batch = room.log.filter((m) => m.seq > (rec.cursor[room.id] ?? 0));
          this.send(rec, {
            kind: "turn_grant",
            room: this.roomInfo(room),
            batch,
            round: room.round,
            total: room.roundTotal,
          });
        }
      }
    }
    void by;
    return true;
  }

  private roomInfo(room: RoomRec): RoomInfo {
    return {
      id: room.id,
      name: room.name,
      members: [...room.members].map((id) => this.cards.get(id)?.name ?? id),
    };
  }

  /** 发一条消息：落盘、广播（除了发送者本人）、更新 cursor。返回消息记录。
   * replyTo 只做存在性校验（引用必须指向本 room 已存在的 seq），不做任何内容判断。 */
  post(roomId: string, fromId: string, fromName: string, text: string, replyTo?: number): RoomMsg | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const validReplyTo =
      typeof replyTo === "number" && room.log.some((m) => m.seq === replyTo) ? replyTo : undefined;
    const msg: RoomMsg = {
      seq: ++room.seq,
      roomId: room.id,
      roomName: room.name,
      from: fromName,
      fromId,
      text,
      ts: new Date().toISOString(),
      ...(validReplyTo !== undefined ? { replyTo: validReplyTo } : {}),
    };
    room.log.push(msg);
    this.lastMessageAt = Date.now();
    this.transcript.log({
      type: "room_message",
      roomId: room.id,
      roomName: room.name,
      seq: msg.seq,
      from: fromName,
      ...(validReplyTo !== undefined ? { replyTo: validReplyTo } : {}),
      text,
    });
    console.log(`[${room.name}][${fromName}] ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`);
    if (this.turnModel) {
      // 回合制：不广播。消息只存进日志，等轮到各 agent 时随 turn_grant 一并投递。
      // 发送者自己的 cursor 照常推进。
      const rec = this.workers.get(fromId);
      if (rec) rec.cursor[room.id] = msg.seq;
      return msg;
    }
    for (const memberId of room.members) {
      if (memberId === fromId) {
        // 发送者自己：cursor 直接推进，不投递（它 already 知道）
        const rec = this.workers.get(memberId);
        if (rec) rec.cursor[room.id] = msg.seq;
        continue;
      }
      const rec = this.workers.get(memberId);
      if (rec?.proc && rec.registered && !rec.dead) {
        this.send(rec, { kind: "room_deliver", msg });
      }
    }
    return msg;
  }

  // ---------- 回合制调度（TURN_MODEL=1）：屏障同步 ----------

  /**
   * 开始新一轮：把自各成员上次 ack 以来本 room 的所有新消息，同时投递给所有存活成员。
   * 无先后顺序、无指定顺序；回复速度决定落盘顺序。hub 只做屏障同步，不读内容。
   */
  beginRound(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.turnModel || this.converged || room.roundActive) return;
    const live = [...room.members].filter((id) => {
      const r = this.workers.get(id);
      return r && !r.dead && r.registered && r.proc;
    });
    if (live.length === 0) {
      this.converged = true;
      this.transcript.log({ type: "round_converged", roomId: room.id, reason: "no_live_speakers" });
      console.log(`[hub][${room.name}] 没有存活的 agent，收尾。`);
      return;
    }
    room.roundActive = true;
    room.roundPending = new Set(live);
    room.roundTotal = live.length;
    room.roundSpoke = 0;
    const names = live.map((id) => this.cards.get(id)?.name ?? id);
    this.transcript.log({
      type: "round_start",
      roomId: room.id,
      roomName: room.name,
      round: room.round,
      members: names,
    });
    console.log(`[hub][${room.name}] 第 ${room.round} 轮开始：同时投递给 ${live.length} 人（${names.join("、")}）`);
    for (const id of live) {
      const rec = this.workers.get(id)!;
      const batch = room.log.filter((m) => m.seq > (rec.cursor[room.id] ?? 0));
      this.send(rec, {
        kind: "turn_grant",
        room: this.roomInfo(room),
        batch,
        round: room.round,
        total: live.length,
      });
    }
    this.saveBarrier(room);
  }

  /** 回合制：某成员本轮回复（发言或 <skip>）。全部回复后进入下一轮或自然收敛。 */
  private onRoundResponse(rec: WorkerRec, roomId: string, spoke: boolean): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.turnModel || this.converged || !room.roundActive) return;
    if (!room.roundPending.delete(rec.card.id)) return; // 不是本轮成员或已回复，忽略
    if (spoke) room.roundSpoke++;
    this.transcript.log({
      type: "round_reply",
      roomId: room.id,
      roomName: room.name,
      round: room.round,
      agent: rec.card.name,
      spoke,
    });
    console.log(
      `[hub][${room.name}] 「${rec.card.name}」第 ${room.round} 轮回复（${spoke ? "发言" : "<skip>"}），剩余 ${room.roundPending.size} 人`
    );
    this.saveBarrier(room);
    if (room.roundPending.size === 0) this.endRound(room);
  }

  private endRound(room: RoomRec): void {
    room.roundActive = false;
    const skipped = room.roundTotal - room.roundSpoke;
    this.transcript.log({
      type: "round_end",
      roomId: room.id,
      roomName: room.name,
      round: room.round,
      spoke: room.roundSpoke,
      skipped,
    });
    console.log(
      `[hub][${room.name}] 第 ${room.round} 轮结束：${room.roundSpoke} 人发言 / ${skipped} 人 <skip>`
    );
    if (room.roundSpoke === 0) {
      this.converged = true;
      this.transcript.log({
        type: "round_converged",
        roomId: room.id,
        roomName: room.name,
        round: room.round,
        reason: "all_skip",
      });
      console.log(`[hub][${room.name}] 第 ${room.round} 轮无人发言，自然收敛，收尾。`);
      this.saveBarrier(room);
      return;
    }
    room.round++;
    this.saveBarrier(room);
    this.beginRound(room.id);
  }

  // ---------- 断点续跑：barrier 状态落盘 + 从实录重建 ----------

  private barrierFile(): string {
    return join(ROOT, "data", "barrier", `${this.transcript.runId}.json`);
  }

  /** 每轮开始 / 每次回复 / 每轮结束都落盘：宿主重启后可从这里恢复屏障。落盘失败不影响运行。 */
  private saveBarrier(room: RoomRec): void {
    try {
      mkdirSync(join(ROOT, "data", "barrier"), { recursive: true });
      const s: BarrierState = {
        roomId: room.id,
        roomName: room.name,
        round: room.round,
        roundActive: room.roundActive,
        pending: [...room.roundPending],
        total: room.roundTotal,
        spoke: room.roundSpoke,
        members: [...room.members],
        at: new Date().toISOString(),
      };
      writeFileSync(this.barrierFile(), JSON.stringify(s));
    } catch {
      /* 忽略 */
    }
  }

  static loadBarrier(runId: string): BarrierState | null {
    try {
      const f = join(ROOT, "data", "barrier", `${runId}.json`);
      if (!existsSync(f)) return null;
      return JSON.parse(readFileSync(f, "utf8")) as BarrierState;
    } catch {
      return null;
    }
  }

  /**
   * 断点续跑：从实录重建 room（消息日志 + 成员 + seq），保留原 roomId，
   * 这样 worker 落盘的 cursor（按 roomId 存）继续有效。roomSeq 序号同步推进，避免后建 room 撞 id。
   */
  rebuildRoomFromTranscript(roomName: string): RoomRec | null {
    const file = join(ROOT, "data", "transcripts", this.transcript.runId, "events.jsonl");
    if (!existsSync(file)) return null;
    let room: RoomRec | null = null;
    let maxRoomN = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(l) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof e.roomId === "string") {
        const m = /^room-(\d+)-/.exec(e.roomId);
        if (m) maxRoomN = Math.max(maxRoomN, Number(m[1]));
      }
      if (e.type === "room_create" && e.name === roomName && !room && typeof e.roomId === "string") {
        room = {
          id: e.roomId,
          name: String(e.name),
          members: new Set(),
          log: [],
          seq: 0,
          round: 1,
          roundActive: false,
          roundPending: new Set(),
          roundTotal: 0,
          roundSpoke: 0,
        };
        this.rooms.set(room.id, room);
      }
      if (!room || e.roomId !== room.id) continue;
      if (e.type === "room_join" && typeof e.agent === "string") {
        const card = this.getCard(e.agent);
        if (card) room.members.add(card.id);
      } else if (e.type === "room_message" && typeof e.seq === "number" && typeof e.text === "string") {
        const from = String(e.from ?? "");
        const card = this.getCard(from);
        room.log.push({
          seq: e.seq,
          roomId: room.id,
          roomName: room.name,
          from,
          fromId: card?.id ?? (from === "用户" ? "user" : ""),
          text: e.text,
          ts: typeof e.ts === "string" ? e.ts : "",
          ...(typeof e.replyTo === "number" ? { replyTo: e.replyTo } : {}),
        });
        room.seq = Math.max(room.seq, e.seq);
      }
    }
    roomSeq = Math.max(roomSeq, maxRoomN);
    return room;
  }

  /**
   * 断点续跑：恢复被中断的那一轮。只叫尚未回复的成员，已回复的不再打扰
   * （下一轮的 turn_grant 会把本轮消息带给他们）。batch 按各成员落盘 cursor 现算。
   */
  resumeRound(
    roomId: string,
    round: number,
    pendingIds: string[],
    total: number,
    spoke: number,
    reason: string
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.turnModel || this.converged || room.roundActive) return;
    const live = pendingIds.filter((id) => {
      const r = this.workers.get(id);
      return r && !r.dead && r.registered && r.proc;
    });
    if (live.length === 0) {
      this.converged = true;
      this.transcript.log({
        type: "round_converged",
        roomId: room.id,
        roomName: room.name,
        round,
        reason: "no_live_speakers_on_resume",
      });
      console.log(`[hub][${room.name}] 断点续跑：第 ${round} 轮无存活待回复成员，收尾。`);
      this.saveBarrier(room);
      return;
    }
    room.round = round;
    room.roundActive = true;
    room.roundPending = new Set(live);
    room.roundTotal = total;
    room.roundSpoke = spoke;
    const pendingNames = live.map((id) => this.cards.get(id)?.name ?? id);
    this.transcript.log({
      type: "round_resume",
      roomId: room.id,
      roomName: room.name,
      round,
      pending: pendingNames,
      reason,
    });
    console.log(
      `[hub][${room.name}] 断点续跑：第 ${round} 轮继续，待回复 ${live.length} 人（${pendingNames.join("、")}），原因：${reason}`
    );
    const note =
      `宿主机曾重启，这是第 ${round} 轮的继续（不是新一轮）。` +
      `${spoke} 位成员已在本轮回复过；你还没回完——请接着本轮的消息继续，正常回复（发言或 <skip>）即可。`;
    for (const id of live) {
      const rec = this.workers.get(id)!;
      const batch = room.log.filter((m) => m.seq > (rec.cursor[room.id] ?? 0));
      this.send(rec, {
        kind: "turn_grant",
        room: this.roomInfo(room),
        batch,
        round,
        total,
        resumeNote: note,
      });
    }
    this.saveBarrier(room);
  }

  // ---------- worker supervision（崩溃重启） ----------

  spawnWorker(card: AgentCard): WorkerRec {
    let rec = this.workers.get(card.id);
    const sessionDir = rec?.sessionDir ?? join(ROOT, "data", "sessions", this.transcript.runId, card.id);
    mkdirSync(sessionDir, { recursive: true });
    const cfg: WorkerConfig = {
      agentId: card.id,
      name: card.name,
      role: card.role,
      tools: card.tools,
      resources: card.resources,
      permissions: card.permissions,
      sessionDir,
      projectTools: process.env.PROJECT_TOOLS === "1",
      runStartedAt: this.startedAt,
    };
    const proc = fork(join(ROOT, "dist", "room", "worker.js"), [], {
      env: { ...process.env, WORKER_CONFIG: JSON.stringify(cfg) },
    });
    if (!rec) {
      rec = {
        card,
        sessionDir,
        proc: null,
        cursor: {},
        lastHeartbeat: Date.now(),
        lastMem: { rssMB: 0, heapUsedMB: 0, heapTotalMB: 0 },
        restarts: 0,
        dead: false,
        busy: false,
        shuttingDown: false,
        registered: false,
      };
      this.workers.set(card.id, rec);
    }
    const r: WorkerRec = rec;
    r.proc = proc;
    r.registered = false;
    r.shuttingDown = false;
    r.lastHeartbeat = Date.now();
    proc.on("message", (raw) => {
      try {
        this.onWorkerMessage(r, raw as W2H);
      } catch (e) {
        console.error(`[hub] 处理 ${card.name} 的消息异常:`, e instanceof Error ? e.message : e);
      }
    });
    proc.on("exit", (code, signal) => this.onWorkerExit(r, proc, code, signal));
    console.log(`[hub] 启动 worker「${card.name}」(pid=${proc.pid})${r.restarts > 0 ? `，第 ${r.restarts} 次重启` : ""}`);
    return r;
  }

  private onWorkerExit(rec: WorkerRec, proc: ChildProcess, code: number | null, signal: string | null): void {
    if (rec.proc !== proc) return; // 已被新进程替换，旧退出忽略
    rec.proc = null;
    rec.registered = false;
    if (rec.shuttingDown || rec.dead) return;
    // 非预期退出：记 crash，安排重启
    const m = rec.lastMem;
    this.transcript.log({
      type: "agent_crash",
      agentId: rec.card.id,
      name: rec.card.name,
      code,
      signal: signal ?? "",
      rssMB: m.rssMB,
      heapUsedMB: m.heapUsedMB,
      heapTotalMB: m.heapTotalMB,
    });
    console.error(
      `[hub] worker「${rec.card.name}」异常退出 (code=${code}, signal=${signal})，` +
        `最后心跳内存 rss=${m.rssMB}MB heap=${m.heapUsedMB}MB，安排重启…`
    );
    this.scheduleRestart(rec);
    if (this.turnModel) {
      // 回合制：崩溃 = 本轮自动 <skip>，屏障不被卡住。重启归来的 agent 从下一轮重新参与。
      for (const room of this.rooms.values()) {
        if (room.roundActive && room.roundPending.delete(rec.card.id)) {
          console.log(
            `[hub][${room.name}] 「${rec.card.name}」第 ${room.round} 轮崩溃，按 <skip> 计（剩余 ${room.roundPending.size} 人）`
          );
          if (room.roundPending.size === 0) this.endRound(room);
        }
      }
    }
  }

  private scheduleRestart(rec: WorkerRec): void {
    if (rec.dead || rec.shuttingDown) return;
    if (rec.restarts >= MAX_RESTARTS) {
      rec.dead = true;
      this.transcript.log({ type: "agent_dead", agentId: rec.card.id, name: rec.card.name, restarts: rec.restarts });
      console.error(`[hub] worker「${rec.card.name}」已重启 ${rec.restarts} 次仍失败，标记死亡，不再重启。`);
      return;
    }
    const delay = RESTART_BACKOFF_MS[rec.restarts] ?? 16000;
    rec.restarts++;
    console.log(`[hub] ${delay}ms 后重启「${rec.card.name}」（第 ${rec.restarts} 次）`);
    rec.restartTimer = setTimeout(() => {
      if (rec.dead || rec.shuttingDown) return;
      this.transcript.log({ type: "agent_restart", agentId: rec.card.id, name: rec.card.name, attempt: rec.restarts });
      this.spawnWorker(rec.card); // worker 从落盘会话恢复，hub 从 cursor 处补发消息
    }, delay);
    rec.restartTimer.unref?.();
  }

  /** 看门狗：心跳超时（进程还在但僵死）→ SIGKILL，走正常崩溃重启流程。 */
  startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const rec of this.workers.values()) {
        const proc = rec.proc;
        if (!proc || rec.dead || rec.shuttingDown || !rec.registered) continue;
        if (now - rec.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          console.error(
            `[hub] worker「${rec.card.name}」心跳超时 ${Math.round((now - rec.lastHeartbeat) / 1000)}s，SIGKILL 后重启`
          );
          try {
            proc.kill("SIGKILL");
          } catch {
            /* 已经死了，exit 事件会处理 */
          }
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  // ---------- 消息路由 ----------

  private send(rec: WorkerRec, m: H2W): void {
    try {
      rec.proc?.send(m);
    } catch {
      /* worker 已死，重启流程会处理 */
    }
  }

  private respond(rec: WorkerRec, reqId: number | undefined, ok: boolean, text: string, room?: RoomInfo): void {
    if (reqId === undefined) return;
    this.send(rec, { kind: "resp", reqId, ok, text, room });
  }

  private onWorkerMessage(rec: WorkerRec, m: W2H): void {
    const reqId = (m as { reqId?: number }).reqId;
    switch (m.kind) {
      case "register": {
        rec.registered = true;
        rec.lastHeartbeat = Date.now();
        // worker 带着自己落盘的 cursor 上线：hub 从该位置补发错过的消息（at-least-once）
        for (const [id, seq] of Object.entries(m.cursor)) rec.cursor[id] = Math.max(rec.cursor[id] ?? 0, seq);
        this.send(rec, {
          kind: "registered",
          rooms: [...this.rooms.values()].filter((r) => r.members.has(rec.card.id)).map((r) => this.roomInfo(r)),
        });
        for (const room of this.rooms.values()) {
          if (!room.members.has(rec.card.id)) continue;
          if (this.turnModel) {
            // 回合制：崩溃被视为本轮 <skip>（onWorkerExit 里已从屏障移除），重启归来不补叫号，
            // 只等下一轮的 turn_grant。batch 按 cursor 现算，下一轮自动收到错过的消息。
            continue;
          }
          const missed = room.log.filter((x) => x.seq > (rec.cursor[room.id] ?? 0));
          for (const msg of missed) this.send(rec, { kind: "room_deliver", msg });
          if (missed.length > 0) {
            console.log(`[hub] 向「${rec.card.name}」补发 ${missed.length} 条 room「${room.name}」的历史消息`);
          }
        }
        break;
      }
      case "heartbeat":
        rec.lastHeartbeat = Date.now();
        rec.lastMem = { rssMB: m.rssMB, heapUsedMB: m.heapUsedMB, heapTotalMB: m.heapTotalMB };
        break;
      case "busy":
        rec.busy = m.busy;
        break;
      case "cursor_ack":
        rec.cursor[m.roomId] = Math.max(rec.cursor[m.roomId] ?? 0, m.seq);
        break;
      case "turn_done":
        this.onRoundResponse(rec, m.roomId, m.spoke);
        break;
      case "tokens": {
        const cur = this.ledger.get(rec.card.id) ?? { input: 0, output: 0 };
        cur.input += Math.max(0, m.input);
        cur.output += Math.max(0, m.output);
        this.ledger.set(rec.card.id, cur);
        break;
      }
      case "tool_call":
        this.transcript.log({
          type: "tool_call",
          who: m.who,
          tool: m.tool,
          args: m.args,
          ok: m.ok,
          ms: m.ms,
          output: m.output,
        });
        break;
      case "room_send": {
        const room = this.resolveRoom(m.room);
        if (!room) return this.respond(rec, reqId, false, `找不到 room「${m.room}」，用 list_rooms 看看你在哪些 room 里。`);
        if (!room.members.has(rec.card.id))
          return this.respond(rec, reqId, false, `你不在 room「${room.name}」里，不能发言。`);
        const msg = this.post(room.id, rec.card.id, rec.card.name, m.text, m.replyTo);
        this.respond(
          rec,
          reqId,
          true,
          msg ? `已发送到「${room.name}」（#${msg.seq}）。` : "发送失败。"
        );
        break;
      }
      case "room_create": {
        const room = this.createRoom(m.name, rec.card.name);
        room.members.add(rec.card.id);
        this.transcript.log({ type: "room_join", roomId: room.id, roomName: room.name, agent: rec.card.name });
        this.respond(rec, reqId, true, `已创建 room「${room.name}」，你已在其中。`, this.roomInfo(room));
        break;
      }
      case "room_invite": {
        const room = this.resolveRoom(m.room);
        if (!room) return this.respond(rec, reqId, false, `找不到 room「${m.room}」。`);
        const target = this.getCard(m.who);
        if (!target) return this.respond(rec, reqId, false, `找不到 agent「${m.who}」，用 list_agents 看花名册。`);
        this.joinRoom(room.id, target.id, rec.card.name);
        this.respond(rec, reqId, true, `已邀请「${target.name}」加入「${room.name}」。`);
        break;
      }
      case "room_list": {
        const rooms = [...this.rooms.values()].filter((r) => r.members.has(rec.card.id));
        const text =
          rooms.length === 0
            ? "你还没有加入任何 room。"
            : rooms.map((r) => `- 「${r.name}」（id: ${r.id}）：成员 ${this.roomInfo(r).members.join("、")}`).join("\n");
        this.respond(rec, reqId, true, text);
        break;
      }
      case "agent_list": {
        const text =
          this.listAgents()
            .map((c) => `- ${c.name}（id: ${c.id}）：${c.role}`)
            .join("\n") || "(暂无 agent)";
        this.respond(rec, reqId, true, text);
        break;
      }
      case "agent_create": {
        const target = this.getCard(m.name);
        if (target) return this.respond(rec, reqId, false, `已存在同名 agent「${target.name}」。`);
        const room = this.resolveRoom(m.room);
        if (!room) return this.respond(rec, reqId, false, `找不到 room「${m.room}」。`);
        const card = this.defineAgent({ name: m.name, role: m.role, parent: rec.card.id });
        this.spawnWorker(card);
        this.joinRoom(room.id, card.id, rec.card.name);
        this.respond(rec, reqId, true, `已创建 agent「${card.name}」并邀请加入「${room.name}」。`);
        break;
      }
    }
  }

  // ---------- 运行状态 ----------

  totalTokens(): TokenUsage {
    const total = { input: 0, output: 0 };
    for (const u of this.ledger.values()) {
      total.input += u.input;
      total.output += u.output;
    }
    return total;
  }

  tokenReport(): { perAgent: Record<string, TokenUsage & { name: string }>; total: TokenUsage } {
    const perAgent: Record<string, TokenUsage & { name: string }> = {};
    for (const [id, u] of this.ledger) {
      perAgent[id] = { ...u, name: this.cards.get(id)?.name ?? id };
    }
    return { perAgent, total: this.totalTokens() };
  }

  quietFor(): number {
    return Date.now() - this.lastMessageAt;
  }

  anyBusy(): boolean {
    return [...this.workers.values()].some((r) => r.busy && !r.dead);
  }

  registeredCount(): number {
    return [...this.workers.values()].filter((r) => r.registered).length;
  }

  liveWorkerCount(): number {
    return [...this.workers.values()].filter((r) => !r.dead).length;
  }

  async waitForRegistered(timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.registeredCount() >= this.liveWorkerCount() && this.liveWorkerCount() > 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error(
      `[hub] 等待 worker 注册超时：${this.registeredCount()}/${this.liveWorkerCount()} 已注册，继续。`
    );
  }

  /** 优雅关机：通知所有 worker 退出，超时后 SIGKILL 残留。 */
  async shutdownAll(timeoutMs: number): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    for (const rec of this.workers.values()) {
      if (rec.restartTimer) clearTimeout(rec.restartTimer);
      rec.shuttingDown = true;
      rec.dead = true; // 关机期间不再重启
      if (rec.proc) this.send(rec, { kind: "shutdown" });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const alive = [...this.workers.values()].some((r) => r.proc && !r.proc.killed && r.proc.exitCode === null);
      if (!alive) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const rec of this.workers.values()) {
      try {
        rec.proc?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}
