import type { AgentRunner } from "./runner.js";
import { memMB } from "./crashGuard.js";

const SKIP = "<skip>";
// 单次群聊讨论的 token 预算：防止讨论无限膨胀烧掉过多 token。
// 这是资源兜底，不是行为规则——预算之内 agent 依然自由决定发言、轮数不限。
// 可用环境变量 GROUP_TOKEN_BUDGET 覆盖默认值。
const TOKEN_BUDGET = Number(process.env.GROUP_TOKEN_BUDGET ?? "200000");

function totalTokens(runner: AgentRunner): number {
  const r = runner.tokenReport();
  return r.total.input + r.total.output;
}

export async function groupRound(runner: AgentRunner, msg: string, opts?: { projectMode?: boolean }) {
runner.groupLog.push({ who: "用户", text: msg});
runner.transcript.log({ type: "group_user", text: msg });
console.log(`[群聊] 你：${msg}`);
// 多轮群聊：每轮每个 agent 都能看到截至目前的全部发言，自主决定是否/如何回复；
// 整轮无人发言（所有人都 <skip>）则自然结束。不设轮数上限，停不停由 agent 自己决定。
const history = () =>
runner.groupLog
.slice(-16)
.map((e) => `[${e.who}] ${e.text}`)
.join("\n");
const projectHint = opts?.projectMode
? `你有真实项目工具：sh（在 ~/workspace/gtd-attach-exp 执行命令）、read、write、edit。\n` +
  `本轮你可以先动手（看代码、写代码、跑测试），再把关键进展/结论发到群里；只动嘴不动手也可以。\n` +
  `动手前先看群里别人做了什么，避免重复劳动、避免同时改同一个文件。\n`
: "";
let rounds = 0;
const startTokens = totalTokens(runner);
// 心跳：每 HEARTBEAT_MINUTES 分钟（默认 5）记一条，带内存占用。
// 进程若悄无声息地死掉，实录尾部最后一个心跳就是死亡时间点；
// 内存数字一路爬升则指向堆 OOM。
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MINUTES ?? "5") * 60_000;
let lastBeat = Date.now();
const beat = (round: number) => {
if (Date.now() - lastBeat >= HEARTBEAT_MS) {
lastBeat = Date.now();
runner.transcript.log({ type: "heartbeat", round, ...memMB() });
}
};
for (let round = 1; ; round++) {
rounds = round;
runner.transcript.log({ type: "group_round_start", round });
let anyoneSpoke = false;
for (const card of runner.listCards()) {
beat(round);
const prompt =
`这是群聊，群里的每条消息所有成员都能看到。\n\n--- 群聊记录 ---\n${history()}\n---\n\n` +
projectHint +
`你是「${card.name}」。请自主决定：\n` +
`- 想发言就直接说：可以回应用户，也可以回应某位成员、追问、补充；想点名某位成员注意就用 @名字。\n` +
`- 这轮没什么想说的，只回复 ${SKIP}，不要输出其他内容。`;
process.stdout.write(` …「${card.name}」思考中`);
try {
const reply = await runner.promptAgent(card.id, prompt);
process.stdout.write("\r" + " ".repeat(40) + "\r");
if (reply.trim() === SKIP) {
runner.transcript.log({ type: "group_skip", round, who: card.name });
continue;
}
anyoneSpoke = true;
runner.groupLog.push({ who: card.name, text: reply});
runner.transcript.log({ type: "group_agent", round, who: card.name, text: reply });
console.log(`[${card.name}] ${reply}\n`);
} catch (e) {
process.stdout.write("\r" + " ".repeat(40) + "\r");
const message = e instanceof Error? e.message: String(e);
runner.transcript.log({ type: "group_error", round, who: card.name, message });
console.log(`出错：${message}\n`);
}
}
if (!anyoneSpoke) break;
const used = totalTokens(runner) - startTokens;
if (used > TOKEN_BUDGET) {
console.log(`\n[群聊] 本次讨论已用 token（${used}）超过预算（${TOKEN_BUDGET}），提前结束。`);
runner.transcript.log({ type: "group_budget_stop", rounds, tokens: used });
break;
}
}
runner.transcript.log({ type: "group_end", rounds });
}
