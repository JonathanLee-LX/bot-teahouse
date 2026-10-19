/**
 * 附件功能真实场景实验：6 人团队在真实项目仓库里实际落地附件功能。
 * - 项目：~/workspace/gtd-attach-exp（git 干净，可恢复）
 * - 工具：sh / read / write / edit（PROJECT_TOOLS=1 启用）
 * - Cloudflare：只允许实验资源（wrangler.exp.json：worker gtd-attach-exp、
 *   D1 gtd-attach-exp、R2 gtd-attach-exp-uploads）；生产 gtd 一律不得触碰，
 *   违反的命令会被 sh 工具直接拒绝。
 * 全程事件（含 tool_call）实时落盘到 data/transcripts/<runId>/events.jsonl。
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { AgentRunner } from "./runner.js";
import { groupRound } from "./groupChat.js";
import { installCrashGuard, memMB } from "./crashGuard.js";
import type { Transcript } from "./transcript.js";

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

const MISSION = `真实任务：在 gtd 项目仓库里把"待办支持添加附件"功能实际落地。

## 环境
- 仓库：~/workspace/gtd-attach-exp（git 干净，改坏了可恢复；改前先用 sh 看清代码）
- 你们有真实项目工具：sh（执行命令，cwd=项目目录）、read、write、edit
- Cloudflare 实验资源（已就绪）：worker 名 gtd-attach-exp、D1 库 gtd-attach-exp、R2 桶 gtd-attach-exp-uploads；配置 wrangler.exp.json
- 铁律：所有 wrangler 命令必须带 -c wrangler.exp.json；生产 worker/D1（gtd）碰都别碰，违规命令会被直接拒绝

## 项目硬约束（仓库 AGENTS.md，原话）
- 所有业务表带 user_id，查询必须带当前用户
- 客户端不能设置 source，服务端按入口写入
- D1 没有传统事务；route / MCP 里不写 SQL，走 src/worker/services/
- 不要让模型直接写 SQL：表结构走 src/db/schema.ts + drizzle migration 文件
- 技术栈：Cloudflare Workers(Hono) + D1(Drizzle) + React 19 + Vite；tasks 表字段见 src/db/schema.ts

## 实现契约（v1.5 讨论结论，照做）
1. 附件独立建表（attachments / attachment_uploads / gc_runs），二进制绝不进 D1
2. 图片/文件走 R2 私有桶；链接只存 URL（不抓正文）；视频 MVP 只做外链
3. 上传两段式：Worker presign → 浏览器直传 R2 → Worker confirm（HEAD 校验真实 size/mime；r2_key 服务端生成；confirm 幂等；key 用 If-None-Match: * 防覆盖）
4. 下载/预览走同源 Worker 代理 GET（不用预签名 302）
5. 软删除 deleted_at；restore 写回原始 deleted_at；purge 宽限 60s、保留 30 天
6. 数值进 src/shared/limits.ts（单文件 25MB、单任务 20 个、单用户 1GB/500 个），前后端同一份
7. /api/* 统一 JSON 错误体（app.notFound + onError；HTTPException 只取 status/headers）

## 协作方式
- 先由阿策拆任务、定第一垂直闭环（建议：DDL + R2 + presign/confirm/下载 API + 部署到实验 worker + curl 验证；前端 UI 视进度）
- 动手前在群里说一声自己要动哪块，避免同时改同一文件；关键进展贴群里
- 阿砚负责跑通 pnpm test / tsc；阿铁负责实验环境迁移与部署
- 完成标准：实验 worker 上 curl 可验证的真实链路 + 测试通过。收口后自然结束（全员 <skip>）

开工。`;

let transcript: Transcript | undefined;

async function main() {
  const regFile = join(ROOT, "data", "agents.json");
  if (existsSync(regFile)) unlinkSync(regFile);

  process.env.PROJECT_TOOLS = "1";
  const runner = new AgentRunner();
  await runner.init();
  transcript = runner.transcript;
  installCrashGuard(runner.transcript);

  console.log("== 创建 6 人团队（真实场景） ==");
  for (const m of TEAM) {
    const card = await runner.createAgent({
      name: m.name,
      role: m.role,
      tools: m.tools,
      parent: "user",
    });
    console.log(`已创建「${card.name}」`);
  }

  await groupRound(runner, MISSION, { projectMode: true });

  const r = runner.tokenReport();
  console.log(
    `\n实验结束。本次 token：input ${r.total.input} / output ${r.total.output}（共 ${r.total.input + r.total.output}）`
  );
  console.log(`实录：data/transcripts/${runner.transcript.runId}/events.jsonl`);
  runner.transcript.log({ type: "run_end", tokens: r.total });
  runner.transcript.close();
  runner.dispose();
}

main().catch((e) => {
  // main 顶层抛错：先写一条临终事件进实录，再按原语义退出
  try {
    const message = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    transcript?.log({ type: "crash", kind: "main_rejection", message: message.slice(0, 4000), ...memMB() });
  } catch {
    /* 忽略 */
  }
  console.error(e);
  process.exit(1);
});
