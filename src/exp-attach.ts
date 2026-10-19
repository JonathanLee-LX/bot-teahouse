/**
* 附件功能协作实验：基于真实项目 gtd，考察 agent 团队协作流程。
* 重置花名册 → 创建 6 人团队 → 在群里抛出需求+项目简报 → 团队自主多轮讨论。
* 全程事件实时落盘到 data/transcripts/<runId>/events.jsonl。
*/
import { existsSync, unlinkSync} from "node:fs";
import { join} from "node:path";
import { ROOT} from "./paths.js";
import { AgentRunner} from "./runner.js";
import { groupRound} from "./groupChat.js";

const TEAM: { name: string; role: string; tools: string[]}[] = [
{
name: "阿策",
role: "产品经理：负责需求整合、范围裁定，汇总输出 PRD。不负责技术架构选型，技术选型由团队基于项目现状讨论决定。",
tools: ["需求分析", "PRD 撰写"],
},
{
name: "小艾",
role: "前端开发：负责 React 前端实现，包括附件上传/展示 UI、上传状态机、错误恢复。",
tools: ["React 前端开发"],
},
{
name: "阿坚",
role: "后端开发：负责 Hono API、Drizzle schema 设计、D1 迁移、附件存储方案。",
tools: ["API 设计", "D1/Drizzle"],
},
{
name: "阿棠",
role: "交互设计：负责附件功能的交互流程与视觉呈现。",
tools: ["交互设计"],
},
{
name: "阿砚",
role: "测试/QA：负责审查需求与方案、设计测试用例。兼任交付物真实性确认：当有人说“已完成/已落地”时，必须追问可检查的实物（群里贴出的完整文档、SQL、链接等），“我搞定了”一句话不算交付。",
tools: ["测试设计", "方案审查"],
},
{
name: "阿铁",
role: "运维/部署：负责 CI、部署、D1 迁移执行，以及存储与部署方案的风险评估。",
tools: ["CI/部署", "D1 迁移"],
},
];

const OPENING = `待办支持添加附件（图片、链接、视频等）

（真实项目：个人待办管理应用 gtd）
- 技术栈：Cloudflare Workers（Hono）+ D1（Drizzle ORM）+ React 19 + Vite；认证用 better-auth；另有 MCP server 和每天一次的 cron
- tasks 表字段：id, user_id, project_id, title, notes, status(默认 inbox), priority, due_at, start_at, completed_at, parent_id(子任务), waiting_on, source, idempotency_key, created_at, updated_at, deleted_at(软删除)
- API 在 src/worker/routes/tasks.ts，前端在 src/react-app
- 技术架构开放：附件存哪、怎么存（比如是否引入 R2 或其他 Cloudflare 服务），由团队讨论决定


1. 基于上面的真实项目现状讨论，技术架构开放，由团队决定
2. 把协作流程跑起来：需求澄清、方案讨论、互相审查，想到什么就说
3. 阿策负责汇总输出 PRD（在群里贴完整版）
4. “交付”=在群里贴出完整可评审的内容，一句“我搞定了”不算数

需求：用户希望在待办任务里添加附件，类型包括图片、链接、视频等。请团队讨论并输出方案。`;

// 续跑开场：RESUME_FROM=<runId> 时使用。把上一轮的纪要带进来，团队从中断处继续，而不是从头重聊。
const RESUME_BRIEF = `（系统通知：这是同一会话的继续，不是从头开始。上一轮 runId=__RUNID__ 因 token 预算在第 3 轮被截停——停在阿铁第 3 轮发言后。注：各 agent 的私有会话已丢失，下面这份纪要就是你们共享的上下文。）

下面纪要里的"已定事项"全部有效，不要重开讨论；只处理"未决事项"。上一轮零复读，继续保持：只说新增内容，没有新增就发 <skip>。全部收口后自然结束。

## 实验边界（用户最新指示，优先级高于一切已定事项）
本实验考察的是协作流程，不要求任何真实执行：所有"待实物"的验收物（8 条 curl、3 条闸门反向用例、A9 改值演练、T-41 等），团队只需在讨论中确认验收清单、口径、签收标准一致，即可记为"已完成（形式签收）"，不再等待真实终端输出，也不再向用户索要 runner 权限或要求用户手动执行。§7 错误体原文同理：按已定第 32 条走完形式确认即可，不再索要原文。第 21 条"只认实物"在本实验内按此条执行。

## 已定事项（纪要）
1. 存储：附件独立建 attachments 表；二进制绝不进 D1；图片/文件走 R2 私有桶；链接只存 URL（不抓正文，防 SSRF）。
2. 上传：两段式 presign → 浏览器直传 R2 → Worker confirm（HEAD 核验真实 size/mime 后落行）；r2_key 服务端生成；客户端传的字段一律不可信；confirm 幂等；key 用 If-None-Match: * 防覆盖。
3. 下载/预览：GET 走同源 Worker 代理（已推翻预签名 302）；12a/12b/12c 判据 = 探针返回码（探针 src 必须与 <img> 完全一致，含 ?v=checksum）。
4. 视频：MVP 只做外链（B站/YouTube 粘贴 URL 卡片展示），上传视频放 P1（需 Cloudflare Stream，付费）。
5. 软删除：孤儿对象 vs 回收对象分开；任务进回收站附件对象不删；POST /api/attachments/:id/restore（回滚必须写回读到的原始 deleted_at）；宽限窗 60s；保留期 30 天；purge 只删最小前缀、LIMIT+1 溢出行只判 hasMore 不删。
6. 契约冻结：PRD v1.5，R36–R45 全部裁定；§7 接口 / §6.1 DDL / §9 状态与文案 / §12 数值冻结；此后新发现只进 §13 已知限制或 P1-backlog（例外：安全缺陷、数据不可逆丢失）。
7. 数值单一来源：单文件 25MB、单任务 20 个、单用户 1GB/500 个、presign 60 次/分、purge 10 次/分、purge 上限 100、撤销窗 8s、宽限窗 60s——全部进 src/shared/limits.ts，前后端 import 同一份，文案走模板渲染。
8. DDL：三表一次建成（attachments、attachment_uploads 含 session_tag、gc_runs）；GC 复用现有 cron，GC_MODE=dry，R2 用前缀/环境隔离。
9. 交互：12 态状态表 + 渲染规则 v2 + 文案定稿 v3；M 自检表口径=结构级（DOM/CSS 结构+可断言描述，不依赖像素）。
10. QA：T-01…T-40 用例；15 条可验收、3 条卡外部条件（标"未验证"）。
11. 用户已确认：Q1–Q6 按默认值执行（含批准开通 R2）。Free/Paid 计划、静态证据、merge gate、Part A spike 实测数据仍是"未验证"，不阻塞开工。
12. R46（§7 例外 b）：purge_max_rows 上调 或 retention_days 缩短 ⇒ 必须先发前端 bundle → 确认 /api/limits 的 sha 已更新 → 再发 Worker；反向（下调/延长）为安全变更，可单独发布。
13. R47（记录性）：§9 挂载 9-A（M 自检表 16 行）+ 文案模板补 max_bytes_file（25MB）、retention_days（30 天）两行。
14. V-01 /api/limits：与 limits.ts 同一份类型定义；只含数值 + commit sha + schemaVersion；只读、免登录；Cache-Control: no-store；CI 先校验 sha 与本次部署一致。
15. V-02 CI 闸门：输入=归档产物（每次部署归档 limits.snapshot.json + sha，保留≥2 版），不是活的 prod Worker；按方向拆开判（new_worker.purge_max_rows <= min(归档 bundle)、new_worker.retention_days >= max(归档 bundle)）；A4 变异测试是准入条件（反向用例跑不出 fail 的闸门标"未验证"）。
16. V-03：retention_days 缩短必须捆绑一次 GC_MODE=dry 预演作放行证据；适用边界：已打开标签页不刷新这一窗口消不掉。
17. V-04：src/shared/limits.ts 导出 serializeLimits() 纯函数，Worker 与前端快照同为该函数产物（不解析文本、不手写 JSON）；构建期生成 limits.snapshot.json 随 bundle 发布；前端 limits 必须构建期内联，禁止运行时 fetch /api/limits 取值。
18. V-05：入口 HTML / asset manifest 用 no-store；带 content-hash 资源 immutable, max-age=31536000；版本支持窗口 2 版（当前 + 上一版）。
19. A4–A7（T-38/9-A 附注）：闸门变异测试、前­端禁运行时取值静态断言、no-store + sha 校验、schemaVersion 未知直接 fail。
20. P1-P：动态文案改由 API 响应携带生效 limits 渲染——判超范围，落 P1-backlog（改动已冻结的 §9 渲染规则）。
21. 交付物口径：只认实物（curl -I 头输出、snapshot 文件本体、A4 的 fail 闸门日志），PR 链接不算交付。
22. A8/A9 附注扩充（已裁定）：扫描域只收 src/shared/copy/** 的源模板文本（不扫 bundle 全量文本）；全仓唯一合法单位字面量 = 单位表那一处（第三类"合法来源代码"，行级豁免）；A9 返回契约 {value, unit, text}，模板只做组合；A8 双向覆盖参照集 = 12 态状态表 ∪ §9 挂载文案条目（断言输入由冻结表生成，禁手抄）；小艾①降级为源模板扫描（bundle 文本扫描不作准入）。
23. V-02 附注（已裁定）：时序固定 build → 生成 snapshot+sha → 写归档 → 归档成功才 deploy；归档保留 N=5（独立分支、GC_MODE=dry、带 LIMIT，不进 limits.ts）；归档与用户域显式互斥（不计入 1GB/500 个、不被 GC 前缀扫到）；归档隔离采纳独立 binding（BUCKET vs ARCHIVE_BUCKET），退路为同桶 + 共享前缀常量 + 静态断言（§13 记明抗风险降级）。
24. 落地条件：A9 无字面量、A8 双向覆盖、A8 目录级默认覆盖三条，各需一份反向用例日志（模板手写 25MB / 删某 state 的 copy key / 塞无主 key → 跑出红）才算落地，否则标"未验证"。
25. R48（V-02 摘帽口径）：摘帽需 (a) 拓扑判读落地成文 (b) A4 反向用例实物日志；单判拓扑只解除"头部落地/时序"子项，整条 V-02 维持"未验证"。
26. R49（单命令 deploy 下 R46 等价放行证据）：不拆 deploy，走替代路径——CI 闸门通过 + 归档 limits.snapshot.json 的 commit sha 与本次 bundle 内联值一致（diff/断言日志+退出码，"CI 过了"不算交付）。
27. R50/R54（§9 挂载附注）：/api/* 前缀下 404 / body 非 JSON / 被 onError 吞掉的 HTTPException，一律映射 §9 现有错误态；401/403/429 必须以原状态码到达前端；不新增态、不新增文案。Retry-After 保留在响应头，前端只用于退避调度、不进可见文案。
28. R51/R55（API 前缀终局化）：run_worker_first 写法定稿为 ["/api", "/api*", "/mcp", "/mcp/*"]（不依赖任何 glob 语义假设）；Worker 显式 app.notFound，/api/* 一律返 §7 形状 JSON 404；实现约束入 §13（不得 env.ASSETS.fetch() 兜底、不得套 Cache API）。
29. R56（验收集 8 条，不可抽查其一）：/api、/api/、/api/limitsx（头+body 合并，须 JSON+§7 形状）；/api/limits（须 cache-control: no-store）；/（入口 HTML no-store）；归档 index.html 里真实 hash 资源（immutable）；/settings 深链（200+no-store）；/mcp/nonexistent（头+body 本体，形状待定已登记）。同一 preview、同一 commit sha。
30. R57（R52 归档 2→3 条）：limits.snapshot.json（含 sha）+ _headers + dist/client/index.html（有 vite manifest 一并加）；同构建产物、同 sha、同级。
31. R58（线上/集成分界）：线上可验 = 401 / 404(×3) / 头策略(×3)；429 与 500 走 app.request() 集成测试，不为此加调试路由；429 用例 D1 绑定=本地 miniflare 临时 persist 目录（跑完销毁），禁 remote（静态断言拦显式 --remote + 运行时 database_id 比对双保险）；429 断言三合一：status 429 + application/json + 响应头含 Retry-After。
32. onError 口径（阿坚自我更正）：HTTPException 只取 status 和 headers（Retry-After 必须活下来），不取 body；body 一律由 errorBody() 工厂产出（字段对齐只发生一处，§7 原文到位后改一行即可）；onError 必须先分流 HTTPException 再兜 500。
33. R60（小艾 A9 改值演练最终配方）：目标值改表内唯一值 7 MB（与 1GB 不同串，证据排他）；期望串不许手写、取 formatBytes 实际输出；准入判据=渲染断言（渲染后的可见文本节点 == formatBytes(7MB) 且 != formatBytes(旧值 25MB)），grep 降为辅助（snapshot 断字段值、bundle 串命中 0 也照贴不判红）；判红条件只有：src/shared/copy/** 源模板出现该串，或渲染断言不通过。
34. T-41（QA 新增，标"未验证"）：V-05 版本窗口 2 版需连发两版实测；A8 双向覆盖参照集以 12 态 state name 为键，HTTP 码→state 映射单列一张表（防"多输入→同一 key"假红）。

## 未决事项（从第 3 轮阿铁发言后继续，按"实验边界"形式签收，不等待真实执行）
- 形式签收 8 条 curl + 3 条闸门反向用例 + A9 改值演练 + T-41：各负责人确认验收清单/口径/签收标准无误后记"已完成（形式签收）"。
- §7 错误体：按已定第 32 条走完形式确认（字段对齐只发生一处、原文未到不阻塞落地），不再向用户索要原文。
- 归档载体：R2 桶 vs git 分支，R23 措辞两可，请阿策定一次（两者 CI 凭据与"归档成功"判定点不同）。
- deploy job 时序重排（阿铁新增）：现行 install → migrate --remote → build → deploy 与 R23 冻结时序冲突；建议新顺序 install → vite build → 生成 snapshot+sha → 写归档 → 闸门/静态断言 → D1 migrate --remote → wrangler deploy（归档失败硬失败，deploy 不执行）。请阿策裁定。
- /mcp/nonexistent 的 body 形状：已登记（JSON-RPC error vs §7 形状），待判。
- V-02 摘帽：子项"头部落地/时序"已解除；A4 反向用例按形式签收确认口径后，整条记"已验证（形式）"。
- 收尾：阿策汇总 v1.5 最终定稿；无新增直接 <skip>。`;

async function main() {
// 干净开局：清空上一轮花名册
const regFile = join(ROOT, "data", "agents.json");
if (existsSync(regFile)) unlinkSync(regFile);

const runner = new AgentRunner();
await runner.init();

console.log("== 创建 6 人团队 ==");
for (const m of TEAM) {
const card = await runner.createAgent({...m, parent: "user"});
console.log(`已创建「${card.name}」：${card.role.slice(0, 24)}…`);
}

const resumeFrom = process.env.RESUME_FROM;
const opening = resumeFrom ? RESUME_BRIEF.replaceAll("__RUNID__", resumeFrom) : OPENING;
console.log(resumeFrom ? `\n== 续跑：接续 ${resumeFrom} 的讨论 ==` : "\n== 在群里抛出需求，团队开始自主讨论 ==");
await groupRound(runner, opening);

const r = runner.tokenReport();
console.log(
`\n实验结束。本次 token：input ${r.total.input} / output ${r.total.output}（共 ${r.total.input + r.total.output}）`
);
console.log(`实录：data/transcripts/${runner.transcript.runId}/events.jsonl`);
runner.transcript.log({ type: "run_end", tokens: r.total});
runner.transcript.close();
runner.dispose();
}

main().catch((e) => {
console.error("实验失败：", e instanceof Error? e.message: e);
process.exit(1);
});
