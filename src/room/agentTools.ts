/** Worker 侧的工具定义。
 * - room 工具：通过 IPC 请求 hub 执行（hub 是 dumb pipe，只做存/广播/记账）。
 * - 项目工具（sh/read/write/edit）：worker 本地执行，直接操作仓库目录；调用记录上报 hub 落盘。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PROJECT_DIR,
  EXP_WRANGLER_CONFIG,
  projectSh,
  projectRead,
  projectWrite,
  projectEdit,
} from "../projectTools.js";
import type { RoomInfo, W2HRequest } from "./protocol.js";

export interface ToolCtx {
  agentName: string;
  projectTools: boolean;
  request: (m: W2HRequest) => Promise<{ ok: boolean; text: string; room?: RoomInfo }>;
  /** 本轮 prompt 里是否已经用 send_message 发过言（防自动发言重复） */
  markSent: () => void;
  logTool: (tool: string, args: string, ok: boolean, ms: number, output: string) => void;
}

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

export function buildAgentTools(ctx: ToolCtx) {
  const tools = [
    defineTool({
      name: "send_message",
      label: "发消息",
      description:
        "往一个 room 发消息，room 里所有成员都能看到。想点名某位成员引起其关注，就在开头写 @名字。想让别人一眼看出你在回哪条消息，就带上 reply_to=那条消息的序号（不带也行）。",
      parameters: Type.Object({
        room: Type.String({ description: "room 的名字或 id（用 list_rooms 查看）" }),
        text: Type.String({ description: "消息内容" }),
        reply_to: Type.Optional(Type.Number({ description: "在回哪条消息：填那条消息的序号，可选" })),
      }),
      execute: async (_id, params) => {
        const t0 = Date.now();
        const r = await ctx.request({ kind: "room_send", room: params.room, text: params.text, replyTo: params.reply_to });
        ctx.markSent();
        ctx.logTool("send_message", `${params.room}: ${params.text.slice(0, 200)}`, r.ok, Date.now() - t0, r.text);
        return textResult(r.text);
      },
    }),
    defineTool({
      name: "create_room",
      label: "建 room",
      description: "创建一个新的 room（共享上下文空间），你自动成为成员。适合拉几个人开小会、私聊。",
      parameters: Type.Object({
        name: Type.String({ description: "room 名字" }),
      }),
      execute: async (_id, params) => {
        const r = await ctx.request({ kind: "room_create", name: params.name });
        return textResult(r.text);
      },
    }),
    defineTool({
      name: "invite",
      label: "拉人进 room",
      description: "邀请一个 agent 加入指定 room。对方会收到 room 历史，直接可参与讨论。",
      parameters: Type.Object({
        room: Type.String({ description: "room 的名字或 id" }),
        who: Type.String({ description: "要邀请的 agent 名字" }),
      }),
      execute: async (_id, params) => {
        const r = await ctx.request({ kind: "room_invite", room: params.room, who: params.who });
        return textResult(r.text);
      },
    }),
    defineTool({
      name: "list_rooms",
      label: "看我的 room",
      description: "列出你所在的 room（含成员名单）。",
      parameters: Type.Object({}),
      execute: async () => {
        const r = await ctx.request({ kind: "room_list" });
        return textResult(r.text);
      },
    }),
    defineTool({
      name: "list_agents",
      label: "看花名册",
      description: "查看所有 agent 的花名册（名字、职责）。",
      parameters: Type.Object({}),
      execute: async () => {
        const r = await ctx.request({ kind: "agent_list" });
        return textResult(r.text);
      },
    }),
    defineTool({
      name: "create_agent",
      label: "创建 agent",
      description:
        "创建一个新的 agent 并把它拉进指定 room。新 agent 是独立个体，有自己的进程和会话，上线后会收到 room 历史。",
      parameters: Type.Object({
        name: Type.String({ description: "新 agent 的名字" }),
        role: Type.String({ description: "职责一句话" }),
        room: Type.String({ description: "把它拉进哪个 room（名字或 id）" }),
      }),
      execute: async (_id, params) => {
        const r = await ctx.request({ kind: "agent_create", name: params.name, role: params.role, room: params.room });
        return textResult(r.text);
      },
    }),
  ];

  if (ctx.projectTools) {
    const trunc = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…(截断)" : s);
    tools.push(
      defineTool({
        name: "sh",
        label: "执行 shell",
        description:
          `在项目目录 ${PROJECT_DIR} 执行 shell 命令（timeout 180s）。` +
          `Cloudflare 实验资源配置在 ${EXP_WRANGLER_CONFIG}，` +
          `所有 wrangler 命令必须带 -c ${EXP_WRANGLER_CONFIG}（直连生产的命令会被拒绝）。` +
          `CLOUDFLARE_API_TOKEN 已注入环境变量。`,
        parameters: Type.Object({
          command: Type.String({ description: "要执行的 shell 命令" }),
        }),
        execute: async (_id, params) => {
          const t0 = Date.now();
          try {
            const r = await projectSh(params.command);
            const out = `exit=${r.code}${r.timedOut ? " (TIMEOUT)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
            ctx.logTool("sh", params.command, r.ok, Date.now() - t0, out);
            return textResult(trunc(out));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.logTool("sh", params.command, false, Date.now() - t0, msg);
            return textResult(`拒绝执行：${msg}`);
          }
        },
      }),
      defineTool({
        name: "read",
        label: "读文件",
        description: `读项目内文件（路径相对于 ${PROJECT_DIR}）。大文件用 offset/limit 分页。`,
        parameters: Type.Object({
          path: Type.String({ description: "相对路径，如 src/worker/routes/tasks.ts" }),
          offset: Type.Optional(Type.Number({ description: "起始行号，默认 1" })),
          limit: Type.Optional(Type.Number({ description: "读多少行" })),
        }),
        execute: async (_id, params) => {
          const t0 = Date.now();
          try {
            const out = projectRead(params.path, params.offset, params.limit);
            ctx.logTool("read", params.path, true, Date.now() - t0, out.slice(0, 300));
            return textResult(trunc(out));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.logTool("read", params.path, false, Date.now() - t0, msg);
            return textResult(`读失败：${msg}`);
          }
        },
      }),
      defineTool({
        name: "write",
        label: "写文件",
        description: `写整个文件（路径相对于 ${PROJECT_DIR}，覆盖）。先用 read 看清再写。`,
        parameters: Type.Object({
          path: Type.String({ description: "相对路径" }),
          content: Type.String({ description: "完整文件内容" }),
        }),
        execute: async (_id, params) => {
          const t0 = Date.now();
          try {
            const out = projectWrite(params.path, params.content);
            ctx.logTool("write", params.path, true, Date.now() - t0, out);
            return textResult(out);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.logTool("write", params.path, false, Date.now() - t0, msg);
            return textResult(`写失败：${msg}`);
          }
        },
      }),
      defineTool({
        name: "edit",
        label: "精确替换",
        description: `在文件中做精确字符串替换（old_text 必须唯一匹配）。适合小改。`,
        parameters: Type.Object({
          path: Type.String({ description: "相对路径" }),
          old_text: Type.String({ description: "要被替换的原文（必须文件中唯一）" }),
          new_text: Type.String({ description: "替换后的新文本" }),
        }),
        execute: async (_id, params) => {
          const t0 = Date.now();
          try {
            const out = projectEdit(params.path, params.old_text, params.new_text);
            ctx.logTool("edit", `${params.path}: ${params.old_text.slice(0, 80)}…`, true, Date.now() - t0, out);
            return textResult(out);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.logTool("edit", params.path, false, Date.now() - t0, msg);
            return textResult(`替换失败：${msg}`);
          }
        },
      })
    );
  }
  return tools;
}
