import { createInterface} from "node:readline";
import { AgentRunner} from "./runner.js";
import { groupRound } from "./groupChat.js";

const SKIP = "<skip>";

function parseCreateArgs(line: string) {
// /create <name> --role "..." [--tools "a,b"] [--resources "a,b"] [--approve] [--spend]
const rest = line.replace(/^\/create\s+/, "");
const name = rest.split(/\s+--/)[0].trim();
const get = (flag: string): string | undefined => {
const m = rest.match(new RegExp(`--${flag}\\s+"([^"]+)"`)) || rest.match(new RegExp(`--${flag}\\s+(\\S+)`));
return m?.[1];
};
return {
name,
role: get("role"),
tools: get("tools"),
resources: get("resources"),
approve: /\s--approve(\s|$)/.test(rest),
spend: /\s--spend(\s|$)/.test(rest),
};
}

function printHelp() {
console.log(`命令：
/create <名字> --role "职责一句话" [--tools "a,b"] [--resources "a,b"] [--approve] [--spend] 创建 agent
/agents 查看花名册
/dm <名字> 进入与指定 agent 的单聊（/exit 退出单聊）
/group <消息> 在群里发言，所有 agent 可见、自行判断是否响应
/spawn 说明：agent 如何创建子 agent
/tokens 查看 token 消耗
/help 帮助
/quit 退出`);
}

async function main() {
const runner = new AgentRunner();
await runner.init();
// 正常退出 / Ctrl+C / 被 kill 时都先把 run_end 写进实录（同步写，不丢）
let finished = false;
const finishRun = () => {
if (finished) return;
finished = true;
const r = runner.tokenReport();
runner.transcript.log({ type: "run_end", tokens: r.total });
runner.transcript.close();
};
process.on("SIGINT", () => { finishRun(); process.exit(130); });
process.on("SIGTERM", () => { finishRun(); process.exit(143); });
console.log("多 Agent 协作 MVP（Pi + DeepSeek）。输入 /help 看命令。");

const rl = createInterface({ input: process.stdin, output: process.stdout});
let dmTarget: string | undefined;

const ask = (q: string) =>
new Promise<string>((resolve) => rl.question(q, resolve));

printHelp();
while (true) {
const promptLabel = dmTarget
? `dm:${runner.getCard(dmTarget)?.name?? dmTarget}> `
: "> ";
const line = (await ask(promptLabel)).trim();
if (!line) continue;

try {
if (line === "/quit") break;
if (line === "/help") {
printHelp();
continue;
}
if (line === "/agents") {
const cards = runner.listCards();
if (!cards.length) console.log("(还没有 agent，用 /create 创建)");
for (const c of cards) {
console.log(
`- ${c.name}（id: ${c.id})：${c.role}\n 工具：${c.tools.join("、") || "未限定"}；资源：${c.resources.join("、") || "未限定"}；` +
`审批${c.permissions.approve? "可": "不可"}/花钱${c.permissions.spend? "可": "不可"}；创建者：${c.parent === "user"? "用户": c.parent}`
);
}
continue;
}
if (line === "/tokens") {
const r = runner.tokenReport();
for (const [id, u] of Object.entries(r.perAgent)) {
console.log(`- ${u.name}（${id})：input ${u.input} / output ${u.output}`);
}
console.log(`总计：input ${r.total.input} / output ${r.total.output}`);
continue;
}
if (line === "/spawn") {
console.log(`agent 创建子 agent：在对话中让 agent 调用 create_agent 工具即可。
例：跟「调研员」说「创建一个专门核验数据的子 agent，叫核验员」。
新 agent 会记录 parent 关系，可用 /agents 查看。`);
continue;
}
if (line.startsWith("/create")) {
const a = parseCreateArgs(line);
if (!a.name ||!a.role) {
console.log('用法：/create <名字> --role "职责一句话" [--tools "a,b"] [--resources "a,b"] [--approve] [--spend]');
continue;
}
process.stdout.write(`创建 agent「${a.name}」中…\n`);
const card = await runner.createAgent({
name: a.name,
role: a.role,
tools: a.tools?.split(/[，,]/).map((s) => s.trim()).filter(Boolean),
resources: a.resources?.split(/[，,]/).map((s) => s.trim()).filter(Boolean),
approve: a.approve,
spend: a.spend,
parent: "user",
});
console.log(`已创建「${card.name}」（id: ${card.id}）`);
continue;
}
if (line.startsWith("/dm ")) {
const card = runner.getCard(line.slice(4).trim());
if (!card) {
console.log("找不到这个 agent，先用 /agents 看花名册。");
continue;
}
dmTarget = card.id;
console.log(`进入与「${card.name}」的单聊（/exit 退出）`);
continue;
}
if (line === "/exit") {
dmTarget = undefined;
console.log("已退出单聊");
continue;
}
if (line.startsWith("/group ")) {
await groupRound(runner, line.slice(7).trim());
continue;
}
if (line.startsWith("/")) {
console.log("未知命令，/help 看列表。");
continue;
}
// 普通消息
if (dmTarget) {
const card = runner.getCard(dmTarget)!;
runner.transcript.log({ type: "dm_user", to: card.name, text: line });
process.stdout.write(`「${card.name}」思考中…\n`);
const reply = await runner.promptAgent(dmTarget, `[单聊] 用户对你说：${line}`);
runner.transcript.log({ type: "dm_agent", from: card.name, text: reply });
console.log(`${reply}\n`);
} else {
console.log("不在单聊中：用 /dm <名字> 进入单聊，或用 /group <消息> 在群里发言。");
}
} catch (e) {
console.log(`出错：${e instanceof Error? e.message: e}`);
}
}

const r = runner.tokenReport();
console.log(
`\n本次 token 消耗：input ${r.total.input} / output ${r.total.output}（共 ${r.total.input + r.total.output}）`
);
console.log(`实录已保存：data/transcripts/${runner.transcript.runId}/events.jsonl`);
finishRun();
runner.dispose();
rl.close();
}

main().catch((e) => {
console.error("启动失败：", e instanceof Error? e.message: e);
process.exit(1);
});
