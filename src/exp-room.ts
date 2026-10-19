/**
 * room 模型实验入口：多进程 + 无主从。
 * - 每个 agent 独立进程、独立会话（落盘，可崩溃恢复）。
 * - hub 是 dumb pipe：存消息、广播、记账、supervision，不做发言决策。
 * - agent 之间直接在 room 里沟通；收敛靠"静默检测"（一段无人发言即收尾），token 预算做熔断。
 * - TURN_MODEL=1：回合制（屏障同步）。每轮 hub 把新消息同时投递给所有 agent
 *   （无指定顺序，回复速度决定落盘顺序）；全部 agent 回复（发言或 <skip>）后进入下一轮，
 *   下一轮的信息基于上一轮的回复；某一轮全部 <skip> 即自然收敛。
 *   用法：TURN_MODEL=1 bash run.sh exp-room
 * - CONCLUSION_PROTOCOL=1（需配合 TURN_MODEL=1）：结论提案协议（第四轮实验变量）。
 *   可选协议，hub 不做任何裁定：agent 可发「【结论】<一句话>」提案，下一轮其他人只能
 *   「【认同】」/「【反对】<一句话理由>」；一轮无人反对则提案人再下一轮发「【结论生效】」关闭争议。
 *   用法：TURN_MODEL=1 CONCLUSION_PROTOCOL=1 bash run.sh exp-room
 *
 * 用法：bash run.sh exp-room
 * 环境变量：QUIET_SECONDS（默认180，静默多少秒收尾）、GROUP_TOKEN_BUDGET（默认2000000）、SMOKE=1（2人冒烟）
 * 断点续跑：RESUME_RUNID=<runId> TURN_MODEL=1 bash run.sh exp-room。
 *   同一 runId，从落盘会话 + 实录 + barrier 落盘恢复，接被中断的那一轮继续，实录连续追加。
 *   新 run 每轮/每次回复都把 barrier 状态落盘到 data/barrier/<runId>.json；
 *   老 run（无 barrier 文件）则从实录 round_start/round_reply（或 run log 的 skip 行）考古重建。
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { Transcript } from "./transcript.js";
import { installCrashGuard, memMB } from "./crashGuard.js";
import { RoomHub } from "./room/hub.js";

const TEAM: { name: string; role: string; tools: string[] }[] = [
  {
    name: "阿策",
    role: "产品经理：负责需求整合、范围裁定、任务拆分与收口。按 v1.5 决策守住范围。",
    tools: ["需求分析", "任务拆分"],
  },
  {
    name: "小艾",
    role: "前端开发：负责 React 前端实现，包括附件上传/展示 UI、上传状态机、错误恢复。",
    tools: ["React 前端开发", "项目工具"],
  },
  {
    name: "阿坚",
    role: "后端开发：负责 Hono API、Drizzle schema、D1 迁移、附件存储方案。所有 SQL 只走 schema + migration 文件。",
    tools: ["API 设计", "D1/Drizzle", "项目工具"],
  },
  {
    name: "阿棠",
    role: "交互设计：负责附件功能的交互流程与视觉呈现，输出可直接落地的交互说明。",
    tools: ["交互设计"],
  },
  {
    name: "阿砚",
    role: "测试/QA：审查方案与代码，跑 pnpm test / tsc，设计验证用例。交付=可检查的实物（测试输出、curl 结果）。",
    tools: ["测试设计", "方案审查", "项目工具"],
  },
  {
    name: "阿铁",
    role: "运维/部署：负责实验环境 D1 迁移、R2、worker 部署与线上验证。只能用 -c wrangler.exp.json。",
    tools: ["CI/部署", "D1 迁移", "项目工具"],
  },
];

const MISSION = `真实任务：把 gtd 附件功能收尾到可交付——从上一轮实验结束时的状态继续，不是重做。

## 起点（上一轮结束时的状态）
- 仓库：~/workspace/gtd-attach-exp，分支 wip/attachments-round3（commit 7ae1f98），工作树干净。从这个状态继续，**不要**切回 main 重做，也**不要**重置 D1。
- D1 实验库：迁移 0001+0002+0003 已应用；attachments 75 行、attachment_uploads 131 行（多为实验残留）、gc_runs 0 行。R2 桶 gtd-attach-exp-uploads 里有实验残留对象。
- 上一轮自报的验证结论（单测 196/0/0、tsc -b 干净、live 51/0/0、窗口探针 16/0/0、线上版本 8bd11407）：**逐项独立复核**，复核不过的打回重做，不要复述上一轮的结论。

## 遗留问题清单（上一轮复盘记下，供复核，不是定论）
1. attachment_uploads.status='failed' 全库只有一个写入点且无任何清理路径 → 永久残留：要不要清、怎么清。
2. confirmUpload 里"大小不符丢弃 R2 对象"的分支实际不可达（PUT 阶段已按 size 拒绝）→ 留还是删。
3. GC 逐项 try/catch：env.UPLOADS 缺失时整轮记 partial 而不是 failed → 监控要不要覆盖 partial。
4. 实验残留数据（75 attachments / 131 uploads）与 R2 残留对象 → 清理策略。
5. 交付分支完整性：git status 应干净，有无漏提交的文件。

## 环境与铁律（不变）
- Cloudflare 实验资源：worker 名 gtd-attach-exp、D1 库 gtd-attach-exp、R2 桶 gtd-attach-exp-uploads；配置 wrangler.exp.json
- 所有 wrangler 命令必须带 -c wrangler.exp.json；生产 worker/D1（gtd）碰都别碰，违规命令会被直接拒绝
- 你们有真实项目工具：sh（执行命令，cwd=项目目录）、read、write、edit
- D1 没有传统事务；route / MCP 里不写 SQL，走 src/worker/services/；表结构走 src/db/schema.ts + drizzle migration 文件

## 协作方式（room 模型 + 本轮实验变量）
- 你们都在 room「任务群」里，所有消息所有人可见。没有上下级，直接沟通，不需要中间人转达。
- 先由阿策认领收尾范围、列出待决事项；动手前在 room 里说一声自己要动哪块，避免同时改同一文件；关键进展发到 room 里。
- **本轮实验变量：结论提案协议**（见你们每轮收到的协议说明）：争议不要无限讨论，任何人可发「【结论】<一句话结论>」提案，下一轮其他人只能「【认同】」或「【反对】<一句话理由>」；一轮内无人反对，提案人在再下一轮发「【结论生效】」关闭争议。此事关闭后，相关讨论直接 <skip>。
- 完成标准：遗留问题逐项有结论（修 / 不修 / 延后，以「【结论生效】」为准）+ 复核门禁全绿。收口后自然安静下来（没什么想说的就 <skip>）。

开工。`;

const SMOKE = process.env.SMOKE === "1";
const QUIET_SECONDS = Number(process.env.QUIET_SECONDS ?? (SMOKE ? "45" : "180"));
const TOKEN_BUDGET = Number(process.env.GROUP_TOKEN_BUDGET ?? "2000000");
const TURN_MODEL = process.env.TURN_MODEL === "1";
/** 断点续跑：RESUME_RUNID=20260917-101417，接上一次因宿主重启中断的 run（同一 runId，实录连续）。 */
const RESUME_RUNID = (process.env.RESUME_RUNID ?? "").trim();

const TURN_PARA = `
## 协作方式（回合制·屏障同步）
- 每轮 hub 把上一轮的新消息同时发给所有人。你们各自读完、各自回复，回复不分先后、先回完的先落盘。
- 每轮：想发言就调 send_message，想动手就直接动手（sh/read/write/edit），把这轮的事做完；
  没什么想说的只回 <skip>。你回复完（发言或 <skip>）后，你的本轮就结束了。
- 所有人都回复完后进入下一轮，下一轮你会看到本轮大家的全部回复。注意：本轮之内别人的回复
  你看不到——动手前先读完本轮消息，避免和别人撞活；需要协调的事项，留到下一轮在 room 里说。
- 所有消息所有人可见；@名字点名、reply_to 引用都照常用。
- 某一轮所有人都是 <skip>，实验就自然结束。别为了"有始有终"硬找话说，也别在没事可做时反复发言。`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 从实录读原实验开始时间（run_start 的 ts），用于断点续跑时"墙上的钟"接着走。 */
function readRunStartedAt(runId: string): string | null {
  try {
    const file = join(ROOT, "data", "transcripts", runId, "events.jsonl");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const e = JSON.parse(l) as { type?: string; ts?: string };
        if (e.type === "run_start" && typeof e.ts === "string") return e.ts;
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 读不到就用现在 */
  }
  return null;
}

/**
 * 老 run 的日志文件里找「「X」第 R 轮回复（<skip>）」行，补回 transcript 里没有的 skip 记录。
 */
function parseSkipsFromLog(runId: string, round: number): Set<string> {
  const out = new Set<string>();
  try {
    const dir = join(ROOT, "data", "logs");
    const f = readdirSync(dir).find((n) => n.startsWith(runId + "-") && n.endsWith("-exp-room.log"));
    if (!f) return out;
    const re = new RegExp(`「(.+?)」第 ${round} 轮回复（<skip>）`);
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const m = re.exec(line);
      if (m) out.add(m[1]);
    }
  } catch {
    /* 找不到日志就认栽 */
  }
  return out;
}

/**
 * 无 barrier 落盘的老 run：从实录考古出中断时的轮次状态。
 * 精确路径：round_reply 事件（发言/skip 都有）；老实录没有该事件时，
 * speakers 从 room_message 取，skippers 从 run log 解析。
 * 返回 null 表示实录里没有 round_start（没法续）。
 */
function archaeology(
  runId: string,
  hub: RoomHub,
  roomId: string
): { round: number; finished: boolean; total: number; spoke: number; pendingIds: string[] } | null {
  const file = join(ROOT, "data", "transcripts", runId, "events.jsonl");
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return null;
  }
  let lastStartIdx = -1;
  let round = 0;
  let memberNames: string[] = [];
  lines.forEach((l, i) => {
    try {
      const e = JSON.parse(l) as { type?: string; roomId?: string; round?: number; members?: string[] };
      if (e.type === "round_start" && e.roomId === roomId) {
        lastStartIdx = i;
        round = e.round ?? 0;
        memberNames = e.members ?? [];
      }
    } catch {
      /* 坏行跳过 */
    }
  });
  if (lastStartIdx < 0 || round <= 0) return null;
  let finished = false;
  const replied = new Map<string, boolean>(); // name -> spoke（精确路径：round_reply）
  const speakers = new Set<string>(); // 兜底路径：room_message
  for (let i = lastStartIdx + 1; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]) as {
        type?: string;
        roomId?: string;
        round?: number;
        from?: string;
        agent?: string;
        spoke?: boolean;
      };
      if (e.type === "round_end" && e.roomId === roomId && e.round === round) {
        finished = true;
        break;
      }
      if (e.type === "round_reply" && e.roomId === roomId && e.round === round && e.agent) {
        replied.set(e.agent, !!e.spoke);
      }
      if (e.type === "room_message" && e.roomId === roomId && e.from && e.from !== "用户") {
        speakers.add(e.from);
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  if (replied.size === 0) {
    // 老实录：没有 round_reply，用 speakers + run log 里的 skip 行重建
    for (const n of speakers) replied.set(n, true);
    for (const n of parseSkipsFromLog(runId, round)) replied.set(n, false);
  }
  const memberIds = memberNames
    .map((n) => hub.getCard(n)?.id)
    .filter((x): x is string => !!x);
  const replierIds = new Set(
    [...replied.keys()].map((n) => hub.getCard(n)?.id).filter((x): x is string => !!x)
  );
  const spoke = [...replied.values()].filter(Boolean).length;
  return {
    round,
    finished,
    total: memberIds.length > 0 ? memberIds.length : memberNames.length,
    spoke,
    pendingIds: memberIds.filter((id) => !replierIds.has(id)),
  };
}

/** 断点续跑：同一 runId，从落盘会话 + 实录 + barrier 恢复，接被中断的那一轮继续。返回 room id。 */
async function resumeRun(hub: RoomHub, transcript: Transcript, runId: string): Promise<string> {
  const cards = hub.listAgents();
  if (cards.length === 0) {
    throw new Error(`断点续跑失败：注册表 data/agents.json 为空，找不到上次的成员`);
  }
  const startedAt = readRunStartedAt(runId);
  if (startedAt) hub.setStartedAt(startedAt);
  const room = hub.rebuildRoomFromTranscript("任务群");
  if (!room) throw new Error(`断点续跑失败：实录里找不到 room「任务群」`);
  console.log(
    `[launcher] 断点续跑 run ${runId}：从实录重建 room「任务群」（${room.log.length} 条消息，成员 ${room.members.size} 人）`
  );
  for (const c of cards) hub.spawnWorker(c);
  await hub.waitForRegistered(180_000);
  console.log(`[launcher] ${hub.registeredCount()} 个 worker 已恢复上线（会话/游标均从落盘恢复），恢复屏障…`);

  const barrier = RoomHub.loadBarrier(runId);
  if (barrier && barrier.roomId === room.id) {
    if (!barrier.roundActive) {
      // 上次停在两轮之间：barrier.round 已是下一轮号，直接开
      room.round = barrier.round;
      console.log(`[launcher] 上次停在第 ${barrier.round - 1} 轮结束后，开始第 ${barrier.round} 轮`);
      transcript.log({ type: "run_resume", runId, reason: "host_restart", round: barrier.round });
      hub.beginRound(room.id);
    } else {
      transcript.log({ type: "run_resume", runId, reason: "host_restart", round: barrier.round });
      hub.resumeRound(room.id, barrier.round, barrier.pending, barrier.total, barrier.spoke, "host_restart");
    }
    return room.id;
  }
  // 老 run 没有 barrier 落盘：从实录考古
  const rec = archaeology(runId, hub, room.id);
  if (!rec) throw new Error(`断点续跑失败：实录里没有 round_start，没法确定中断轮次`);
  transcript.log({ type: "run_resume", runId, reason: "host_restart", round: rec.finished ? rec.round + 1 : rec.round });
  if (rec.finished) {
    room.round = rec.round + 1;
    console.log(`[launcher] 上次第 ${rec.round} 轮已结束，开始第 ${rec.round + 1} 轮`);
    hub.beginRound(room.id);
  } else {
    hub.resumeRound(room.id, rec.round, rec.pendingIds, rec.total, rec.spoke, "host_restart（实录重建）");
  }
  return room.id;
}

async function main() {
  const regFile = join(ROOT, "data", "agents.json");
  if (!RESUME_RUNID && existsSync(regFile)) unlinkSync(regFile);

  process.env.PROJECT_TOOLS = SMOKE ? "0" : "1";
  const transcript = new Transcript(RESUME_RUNID || undefined);
  installCrashGuard(transcript);

  const hub = new RoomHub(transcript);
  hub.turnModel = TURN_MODEL;
  hub.startWatchdog();

  let roomId: string;
  if (RESUME_RUNID) {
    roomId = await resumeRun(hub, transcript, RESUME_RUNID);
  } else {
    const team = SMOKE ? TEAM.slice(0, 2) : TEAM;    for (const m of team) hub.defineAgent({ name: m.name, role: m.role, tools: m.tools, parent: "user" });
    transcript.log({
      type: "run_start",
      model: "deepseek/deepseek-flash",
      agents: hub.listAgents().map((c) => ({ id: c.id, name: c.name, role: c.role })),
    });
    console.log(`[launcher] 实录：data/transcripts/${transcript.runId}/events.jsonl`);

    for (const c of hub.listAgents()) hub.spawnWorker(c);

    const room = hub.createRoom("任务群", "用户");
    roomId = room.id;
    for (const c of hub.listAgents()) hub.joinRoom(room.id, c.id, "用户");

    await hub.waitForRegistered(180_000);
    console.log(`[launcher] ${hub.registeredCount()} 个 worker 已上线，发布任务…`);
    hub.post(room.id, "user", "用户", SMOKE ? "冒烟测试：大家互相打个招呼，确认 room 消息收发正常，然后安静下来。" : MISSION + (TURN_MODEL ? TURN_PARA : ""));
    if (TURN_MODEL) {
      console.log(`[launcher] 回合制（屏障同步）：开始第 1 轮`);
      hub.beginRound(room.id);
    }
  }

  // 主循环：静默检测收尾 + token 预算熔断 + hub 心跳 + 操作员干预通道
  let lastBeat = Date.now();
  for (;;) {
    await sleep(5000);
    // 操作员干预：用户已授权 min 在必要时（如团队陷入循环无进展）以"用户"身份
    // 往 room 递启发式提示信息。hub 只搬运，不读内容做判断；最终怎么定还是 agent 的事。
    for (const text of hub.drainOperatorInbox()) {
      hub.post(roomId, "user", "用户", text);
      transcript.log({ type: "operator_note", text: text.slice(0, 300) });
      console.log(`[launcher] 操作员提示已投递: ${text.slice(0, 120)}`);
    }
    if (Date.now() - lastBeat >= 5 * 60_000) {
      lastBeat = Date.now();
      transcript.log({ type: "heartbeat", round: 0, ...memMB() });
    }
    const used = hub.totalTokens();
    if (used.input + used.output > TOKEN_BUDGET) {
      console.log(`[launcher] token 超预算（${used.input + used.output} > ${TOKEN_BUDGET}），收尾。`);
      transcript.log({ type: "room_budget_stop", tokens: used.input + used.output });
      break;
    }
    if (TURN_MODEL && hub.converged) {
      console.log(`[launcher] 回合制自然收敛（一整轮无人发言），收尾。`);
      break;
    }
    if (hub.quietFor() > QUIET_SECONDS * 1000 && !hub.anyBusy()) {
      console.log(`[launcher] 已安静 ${QUIET_SECONDS}s，无人发言，收尾。`);
      transcript.log({ type: "room_quiet_end", quietSeconds: QUIET_SECONDS });
      break;
    }
  }

  await hub.shutdownAll(20_000);
  const total = hub.totalTokens();
  transcript.log({ type: "run_end", tokens: total });
  console.log(
    `\n实验结束。本次 token：input ${total.input} / output ${total.output}（共 ${total.input + total.output}）`
  );
  console.log(`实录：data/transcripts/${transcript.runId}/events.jsonl`);
  transcript.close();
}

main().catch((e) => {
  // 顶层异常：installCrashGuard 会记 crash 事件，这里只打印并退出
  console.error(e);
  process.exit(1);
});
