/** Agent worker：独立进程，独立会话，信箱驱动。
 *
 * - 启动时从 WORKER_CONFIG 读身份；会话落盘在 sessionDir，崩溃重启后自动恢复。
 * - hub 投递 room 消息 → 进信箱 → 唤醒 → 自主决定回不回（<skip> 则沉默）。
 * - 想发言必须调 send_message（可发到任何自己在的 room）；若本轮没调而是直接返回了文本，
 *   则把文本自动发到唤醒它的 room（防"想说但忘调工具"）。
 * - 投递是 at-least-once：处理完才 ack cursor；崩溃重启后 hub 会补发未 ack 的消息。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { ROOT } from "../paths.js";
import { memMB } from "../crashGuard.js";
import type { AgentCard, TokenUsage } from "../types.js";
import type { H2W, RoomInfo, RoomMsg, W2H, W2HRequest, WorkerConfig } from "./protocol.js";
import { buildAgentTools } from "./agentTools.js";
import { buildRoomPrompt } from "./prompts.js";

const MODELS_PATH = join(ROOT, ".pi", "models.json");
const SKIP = "<skip>";
const HEARTBEAT_MS = 15_000;

const cfg: WorkerConfig = (() => {
  const c = JSON.parse(process.env.WORKER_CONFIG ?? "null") as WorkerConfig | null;
  if (!c || typeof process.send !== "function") {
    console.error("[worker] 必须由 hub fork 启动（缺少 WORKER_CONFIG 或 IPC 通道）");
    process.exit(2);
  }
  return c;
})();
const send = (m: W2H): void => {
  try {
    process.send!(m);
  } catch {
    /* hub 已死，重启流程会处理 */
  }
};
const tag = `[worker:${cfg.name}]`;

// 临终尽量留一句话（hub 主要靠 exit 事件做重启，这里是补充）
process.on("uncaughtException", (e) => {
  console.error(tag, "uncaughtException:", e instanceof Error ? e.message : e);
  process.exit(1);
});
process.on("unhandledRejection", (r) => {
  console.error(tag, "unhandledRejection:", r instanceof Error ? r.message : r);
  process.exit(1);
});

function lastAssistantText(session: AgentSession): string {
  const msgs = session.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
      if (text.trim()) return text.trim();
    }
  }
  return "(无文本回复)";
}

function sessionTokens(session: AgentSession): TokenUsage {
  let input = 0;
  let output = 0;
  for (const m of session.messages as any[]) {
    if (m?.role === "assistant" && m.usage) {
      input += m.usage.input ?? 0;
      output += m.usage.output ?? 0;
    }
  }
  return { input, output };
}

const card: AgentCard = {
  id: cfg.agentId,
  name: cfg.name,
  role: cfg.role,
  tools: cfg.tools,
  resources: cfg.resources,
  permissions: cfg.permissions,
  parent: "hub",
  createdAt: new Date().toISOString(),
};

// ---- IPC 请求/响应 ----
let reqId = 0;
const pending = new Map<number, (r: { ok: boolean; text: string; room?: RoomInfo }) => void>();
function requestHub(m: W2HRequest): Promise<{ ok: boolean; text: string; room?: RoomInfo }> {
  const id = ++reqId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ ...m, reqId: id } as W2H);
  });
}

// ---- 信箱 ----
const inbox: RoomMsg[] = [];
const roomViews = new Map<string, RoomMsg[]>();
const roomInfos = new Map<string, RoomInfo>();
let busy = false;
let shuttingDown = false;
let sentThisTurn = false;

function remember(msg: RoomMsg): void {
  const view = roomViews.get(msg.roomId) ?? [];
  view.push(msg);
  if (view.length > 40) view.splice(0, view.length - 40);
  roomViews.set(msg.roomId, view);
}

function buildWakePrompt(batch: RoomMsg[], turn?: { round: number; total: number; resumeNote?: string }): string {
  const byRoom = new Map<string, RoomMsg[]>();
  for (const m of batch) {
    const list = byRoom.get(m.roomId) ?? [];
    list.push(m);
    byRoom.set(m.roomId, list);
  }
  // 墙上的钟：只呈现"第几条、已进行多久"，不评判、不建议怎么做。收敛与否由 agent 自己判断。
  const elapsedMin = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(cfg.runStartedAt)) / 60000)
  );
  const parts: string[] = [];
  for (const [roomId, msgs] of byRoom) {
    const info = roomInfos.get(roomId);
    const name = info?.name ?? msgs[0].roomName;
    const members = info ? `（成员：${info.members.join("、")}）` : "";
    const latestSeq = Math.max(...msgs.map((m) => m.seq));
    parts.push(
      `room「${name}」${members}的新消息（这是第 ${latestSeq} 条，实验已进行 ${elapsedMin} 分钟）：\n` +
        msgs
          .map((m) => `[#${m.seq} ${m.from}${m.replyTo !== undefined ? ` 回复 #${m.replyTo}` : ""}] ${m.text}`)
          .join("\n")
    );
  }
  const turnHead = turn
    ? `${turn.resumeNote ? `【恢复】${turn.resumeNote}\n\n` : ""}第 ${turn.round} 轮（本轮新消息已同时发给全部 ${turn.total} 位成员，回复不分先后、先回完的先落盘；所有人回复完后进入下一轮）。以下是本轮的新消息（上一轮大家的回复）：\n\n`
    : `你被唤醒了，以下是新消息：\n\n`;
  // 结论提案协议（可选，不用不违规）：给"争议定论"一个形状，hub 不做任何裁定，只靠模型自发使用。
  const conclusionProto =
    turn && process.env.CONCLUSION_PROTOCOL === "1"
      ? `- 想给某个争议定论：可发「【结论】<一句话结论>」（可选协议，不用不违规）；提案人下一轮只回 ${SKIP}，等大家表态。\n` +
        `- 提案的下一轮，其他人只能表态：「【认同】」或「【反对】<一句话理由>」，不要另起新论证。\n` +
        `- 一轮内无人反对：提案人在再下一轮发「【结论生效】」，此事关闭，之后相关讨论直接 ${SKIP}。\n` +
        `- 有反对则提案作废，继续讨论，可修改后重提；两人同时提案时各自独立走流程。\n`
      : ``;
  return (
    turnHead + `${parts.join("\n\n")}\n\n---\n` +
    `你是「${card.name}」。自主决定：\n` +
    `- 想发言：调用 send_message 发到你在的 room（想点名某位成员就在开头写 @名字；想让别人一眼看出你在回哪条，就带 reply_to=那条消息的序号，不带也行）。\n` +
    conclusionProto +
    `- 没什么想说的：只回复 ${SKIP}，不要输出其他内容。` +
    (turn ? `\n- 你回复（发言或 ${SKIP}）后，你的本轮就结束了；所有人回复完后进入下一轮，下一轮你会看到本轮大家的全部回复。\n- 某一轮所有人都 ${SKIP}，实验自然结束。别为了"有始有终"硬找话说，也别在没事可做时反复发言。` : ``)
  );
}

let session!: AgentSession;

/**
 * 处理一批消息：prompt → 可能发言 → ack cursor。返回本轮是否发过言。
 * 自由发言（pump）和回合制（runTurn）共用这一套。
 */
async function handleBatch(batch: RoomMsg[], wakePrompt: string): Promise<boolean> {
  sentThisTurn = false;
  let spoke = false;
  const before = sessionTokens(session);
  await session.prompt(wakePrompt);
  const after = sessionTokens(session);
  send({
    kind: "tokens",
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
  });
  const reply = lastAssistantText(session);
  // 先 ack（at-least-once：崩溃重启后未 ack 的会被补发）
  for (const m of batch) {
    cursor[m.roomId] = Math.max(cursor[m.roomId] ?? 0, m.seq);
    send({ kind: "cursor_ack", roomId: m.roomId, seq: m.seq });
  }
  saveCursor();
  const clean = reply.trim();
  if (clean && clean !== SKIP && !sentThisTurn) {
    // 本轮没调 send_message 但返回了文本：自动发到唤醒它的 room
    const r = await requestHub({ kind: "room_send", room: batch[0].roomId, text: clean });
    if (!r.ok) console.error(tag, "自动发言失败:", r.text);
    else spoke = true;
  }
  if (sentThisTurn) spoke = true;
  return spoke;
}

// 防御性暂存：回合制下所有成员同时收到 turn_grant，busy 时暂存，等当前工作结束再执行
let pendingGrant: Extract<H2W, { kind: "turn_grant" }> | null = null;

/** 回合制：执行被授予的回合，结束后回 turn_done 把发言权交还 hub。 */
async function runTurn(g: Extract<H2W, { kind: "turn_grant" }>): Promise<void> {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  busy = true;
  send({ kind: "busy", busy: true });
  try {
    const spoke = await handleBatch(
      g.batch,
      buildWakePrompt(g.batch, { round: g.round, total: g.total, resumeNote: g.resumeNote })
    );
    send({ kind: "turn_done", roomId: g.room.id, spoke });
  } catch (e) {
    console.error(tag, "回合处理异常:", e instanceof Error ? e.message : e);
    try {
      send({ kind: "turn_done", roomId: g.room.id, spoke: false });
    } catch {
      /* hub 已死，忽略 */
    }
  } finally {
    busy = false;
    send({ kind: "busy", busy: false });
    if (shuttingDown) process.exit(0);
  }
}

async function pump(): Promise<void> {
  if (busy || inbox.length === 0) return;
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  busy = true;
  send({ kind: "busy", busy: true });
  const batch = inbox.splice(0, inbox.length);
  try {
    await handleBatch(batch, buildWakePrompt(batch));
  } catch (e) {
    console.error(tag, "prompt 异常:", e instanceof Error ? e.message : e);
  } finally {
    busy = false;
    send({ kind: "busy", busy: false });
    if (pendingGrant) {
      const g = pendingGrant;
      pendingGrant = null;
      void runTurn(g);
    } else if (inbox.length > 0) void pump();
    else if (shuttingDown) process.exit(0);
  }
}

// ---- cursor 落盘（重启后从这里继续） ----
const cursorFile = join(cfg.sessionDir, "cursor.json");
let cursor: Record<string, number> = {};
try {
  if (existsSync(cursorFile)) cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
} catch {
  /* 忽略，用空 cursor（hub 会补发） */
}
function saveCursor(): void {
  try {
    writeFileSync(cursorFile, JSON.stringify(cursor));
  } catch {
    /* 忽略 */
  }
}

// ---- hub 消息 ----
process.on("message", (raw) => {
  const m = raw as H2W;
  try {
    switch (m.kind) {
      case "registered":
        for (const r of m.rooms) {
          roomInfos.set(r.id, r);
          if (!roomViews.has(r.id)) roomViews.set(r.id, []);
        }
        break;
      case "room_joined":
        roomInfos.set(m.room.id, m.room);
        roomViews.set(m.room.id, m.history.slice(-40));
        // 被拉进 room：把历史当作一次唤醒读一遍（回合制下不抢跑，等叫号）
        if (m.history.length > 0 && process.env.TURN_MODEL !== "1") {
          inbox.push(...m.history.slice(-10));
          void pump();
        }
        break;
      case "room_deliver":
        remember(m.msg);
        inbox.push(m.msg);
        void pump();
        break;
      case "turn_grant":
        for (const msg of m.batch) remember(msg);
        if (busy) {
          // 防御：回合制下 hub 一次只叫一人，正常不会发生；暂存等当前工作结束
          pendingGrant = m;
        } else {
          void runTurn(m);
        }
        break;
      case "resp": {
        const resolve = pending.get(m.reqId);
        if (resolve) {
          pending.delete(m.reqId);
          resolve({ ok: m.ok, text: m.text, room: m.room });
        }
        break;
      }
      case "shutdown":
        shuttingDown = true;
        if (!busy) process.exit(0);
        break;
    }
  } catch (e) {
    console.error(tag, "处理 hub 消息异常:", e instanceof Error ? e.message : e);
  }
});

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  const modelRuntime = await ModelRuntime.create({ modelsPath: MODELS_PATH, refreshOnCreate: false });
  const model =
    modelRuntime.getModel("deepseek", "deepseek-flash") ??
    modelRuntime.getModel("deepseek", "deepseek-v4-pro");
  if (!model) throw new Error("deepseek 模型未注册，检查 .pi/models.json");

  // 会话恢复：有落盘就 open，没有就新建
  mkdirSync(cfg.sessionDir, { recursive: true });
  const pathFile = join(cfg.sessionDir, "session.path");
  let sm: SessionManager;
  const saved = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
  if (saved && existsSync(saved)) {
    sm = SessionManager.open(saved, cfg.sessionDir, ROOT);
    console.log(tag, "从落盘会话恢复:", saved);
  } else {
    sm = SessionManager.create(ROOT, cfg.sessionDir);
    const f = sm.getSessionFile();
    if (f) writeFileSync(pathFile, f);
    console.log(tag, "新建会话:", f ?? "(未落盘)");
  }

  const loader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: join(ROOT, ".pi"),
    appendSystemPromptOverride: (base) => [...base, buildRoomPrompt(card, cfg.projectTools)],
  });
  await loader.reload();

  const toolsCtx = {
    agentName: card.name,
    projectTools: cfg.projectTools,
    request: requestHub,
    markSent: () => {
      sentThisTurn = true;
    },
    logTool: (tool: string, args: string, ok: boolean, ms: number, output: string) => {
      send({ kind: "tool_call", who: card.name, tool, args: args.slice(0, 500), ok, ms, output: output.slice(0, 1500) });
    },
  };
  const created = await createAgentSession({
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: sm,
    noTools: "builtin",
    customTools: buildAgentTools(toolsCtx),
  });
  session = created.session;

  // 上线
  send({ kind: "register", agentId: card.id, cursor });
  console.log(tag, `上线 (pid=${process.pid})`);
  setInterval(() => send({ kind: "heartbeat", ...memMB() }), HEARTBEAT_MS).unref();
}

main().catch((e) => {
  console.error(tag, "启动失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
