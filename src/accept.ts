/**
* 验收脚本：真实调用 DeepSeek 跑通
* 创建 2 个 agent → DM 派任务 → 群聊协作出现一次 handoff → agent 创建一个子 agent
* 全程记录 token 消耗。
*/
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { AgentRunner} from "./runner.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
// 验收是演示脚本：每次从干净状态开始，保证可重复运行
const regFile = join(ROOT, "data", "agents.json");
if (existsSync(regFile)) unlinkSync(regFile);

const runner = new AgentRunner();
await runner.init();

console.log("== 1. 创建 2 个 agent ==");
const researcher = await runner.createAgent({
name: "调研员",
role: "负责信息搜集与调研，把查到的信息整理成要点",
tools: ["公开信息检索与整理"],
parent: "user",
});
const writer = await runner.createAgent({
name: "写手",
role: "负责撰写与整理文档，把素材写成通顺的简报",
tools: ["文档撰写"],
parent: "user",
});
console.log(`创建：${researcher.name}、${writer.name}`);

console.log("\n== 2. DM 派任务（故意派给不那么对口的 agent，观察是否转交） ==");
const dmReply = await runner.promptAgent(
writer.id,
`[单聊] 用户对你说：帮我查一下 DeepSeek 官方 API 里 deepseek-chat 模型按量计费的价格，整理成 3 条要点发我。` +
`如果这件事有更合适的 agent，先用 list_agents 看花名册，记得用 handoff 转交给 ta。`
);
console.log(`${dmReply}\n`);

console.log("== 3. 群聊协作 ==");
const groupMsg = "刚才的价格调研，写手负责整理成一份 100 字以内的简报发出来";
runner.groupLog.push({ who: "用户", text: groupMsg});
console.log(`[群聊] 用户：${groupMsg}`);
for (const card of runner.listCards()) {
const history = runner.groupLog.map((e) => `[${e.who}] ${e.text}`).join("\n");
const reply = await runner.promptAgent(
card.id,
`[群聊] 用户在群里说：「${groupMsg}」\n\n--- 群聊近期记录 ---\n${history}\n---\n` +
`你是「${card.name}」。如果这条群消息需要你回应或参与协作，请直接回复；如果与你无关，请只回复 <skip>，不要输出其他内容。`
);
if (reply.trim() === "<skip>") {
console.log(`<skip>`);
continue;
}
runner.groupLog.push({ who: card.name, text: reply});
console.log(`${reply}\n`);
await sleep(500);
}

console.log("== 4. agent 创建子 agent ==");
const spawnReply = await runner.promptAgent(
researcher.id,
`[单聊] 用户对你说：创建一个专门负责核验数据的子 agent，名字叫「核验员」，职责是核验调研数据的准确性。用 create_agent 工具创建。`
);
console.log(`${spawnReply}\n`);

console.log("== 验收结果 ==");
const cards = runner.listCards();
const children = cards.filter((c) => c.parent!== "user");
console.log(`agent 总数：${cards.length}（${cards.map((c) => c.name).join("、")}）`);
console.log(`子 agent：${children.length}（${children.map((c) => `${c.name}，parent=${c.parent}`).join("；") || "无"}）`);
console.log(`handoff 次数：${runner.handoffs.length}`);
for (const h of runner.handoffs) {
console.log(` - ${h.from} → ${h.to}：${h.task.slice(0, 40)}…`);
}
const r = runner.tokenReport();
console.log("\n-- token 消耗 --");
for (const [id, u] of Object.entries(r.perAgent)) {
console.log(` ${u.name}（${id}）：input ${u.input} / output ${u.output}`);
}
console.log(` 总计：input ${r.total.input} / output ${r.total.output} / 合计 ${r.total.input + r.total.output}`);

const ok = cards.length >= 3 && children.length >= 1 && runner.handoffs.length >= 1;
console.log(ok? "\n✅ 验收通过": "\n❌ 验收未通过");
runner.dispose();
process.exit(ok? 0: 1);
}

main().catch((e) => {
console.error("验收失败：", e instanceof Error? e.message: e);
process.exit(1);
});
