import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { buildCollabPrompt } from "./systemPrompt.js";
import { loadRegistry, saveRegistry, slugify } from "./registry.js";
import { Transcript } from "./transcript.js";
import type { AgentCard, HandoffRecord, TokenUsage } from "./types.js";
import {
  PROJECT_DIR,
  EXP_WRANGLER_CONFIG,
  projectSh,
  projectRead,
  projectWrite,
  projectEdit,
} from "./projectTools.js";

const MODELS_PATH = join(ROOT, ".pi", "models.json");

export const DEFAULT_MODEL_ID = "deepseek-flash";
const FALLBACK_MODEL_ID = "deepseek-v4-pro";

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
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

export interface CreateAgentInput {
  name: string;
  role: string;
  tools?: string[];
  resources?: string[];
  approve?: boolean;
  spend?: boolean;
  parent?: string;
}

export class AgentRunner {
  private modelRuntime!: ModelRuntime;
  private model: any;
  private sessions = new Map<string, AgentSession>();
  private cards = new Map<string, AgentCard>();
  private ledger = new Map<string, TokenUsage>();
  private busy = new Set<string>();
  private askDepth = 0;
  handoffs: HandoffRecord[] = [];
  groupLog: { who: string; text: string }[] = [];
  /** 本次运行的全量事件记录（实时落盘） */
  readonly transcript = new Transcript();

  async init(): Promise<void> {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error("缺少 DEEPSEEK_API_KEY 环境变量（用 run.sh 启动）");
    }
    this.modelRuntime = await ModelRuntime.create({
      modelsPath: MODELS_PATH,
      refreshOnCreate: false,
    });
    this.model =
      this.modelRuntime.getModel("deepseek", DEFAULT_MODEL_ID) ??
      this.modelRuntime.getModel("deepseek", FALLBACK_MODEL_ID);
    if (!this.model) throw new Error("deepseek 模型未注册，检查 .pi/models.json");
    console.log(`[runner] 模型: deepseek/${this.model.id}`);

    for (const card of loadRegistry()) {
      this.cards.set(card.id, card);
    }
    this.transcript.log({
      type: "run_start",
      model: `deepseek/${this.model.id}`,
      agents: this.listCards().map((c) => ({ id: c.id, name: c.name, role: c.role })),
    });
    console.log(`[runner] 实录写入：data/transcripts/${this.transcript.runId}/events.jsonl`);
  }

  listCards(): AgentCard[] {
    return [...this.cards.values()];
  }

  getCard(idOrName: string): AgentCard | undefined {
    const key = slugify(idOrName);
    return (
      this.cards.get(key) ??
      [...this.cards.values()].find((c) => c.name === idOrName)
    );
  }

  private rosterText(): string {
    return this.listCards()
      .map(
        (c) =>
          `- ${c.name}（id: ${c.id})：${c.role}；工具：${c.tools.join("、") || "未限定"}；` +
          `权限：审批${c.permissions.approve ? "可" : "不可"}/花钱${c.permissions.spend ? "可" : "不可"}` +
          (c.parent && c.parent !== "user" ? `；由 ${c.parent} 创建` : "")
      )
      .join("\n");
  }

  private buildTools(callerId: string) {
    const runner = this;
    const callerName = () => runner.cards.get(callerId)?.name ?? callerId;
    const logTool = (tool: string, args: string, ok: boolean, ms: number, output: string) => {
      runner.transcript.log({
        type: "tool_call",
        who: callerName(),
        tool,
        args: args.slice(0, 500),
        ok,
        ms,
        output: output.slice(0, 1500),
      });
    };
    const tools = [
      defineTool({
        name: "list_agents",
        label: "查看花名册",
        description: "查看所有 agent 的花名册（含每张定位卡：名字、职责、工具、资源、权限）。不知道该问谁时先看这个。",
        parameters: Type.Object({}),
        execute: async () => textResult(runner.rosterText() || "(暂无 agent)"),
      }),
      defineTool({
        name: "ask_agent",
        label: "向指定 agent 提问",
        description:
          "向另一个 agent 提问。不知道答案时用这个问对的人，不要瞎编。\n" +
          "默认：对方的回答作为工具结果返回给你，由你转述或继续处理。\n" +
          "如果这个问题是替用户问的、用户想直接看到对方的回答，设 direct_to_user=true，对方的回答会直接显示给用户，不经过你转述。",
        parameters: Type.Object({
          to: Type.String({ description: "对方 agent 的名字或 id" }),
          question: Type.String({ description: "要问的问题，带上必要的上下文" }),
          direct_to_user: Type.Optional(
            Type.Boolean({ description: "对方是否直接回复用户，默认 false" })
          ),
        }),
        execute: async (_id, params) => {
          const target = runner.getCard(params.to);
          if (!target) return textResult(`找不到 agent「${params.to}」，先用 list_agents 确认名字。`);
          if (target.id === callerId) return textResult("不能问自己。");
          if (runner.busy.has(target.id))
            return textResult(`「${target.name}」正忙（在其调用链中），为避免死循环本次拒绝，请稍后或换人问。`);
          if (runner.askDepth >= 4) return textResult("嵌套提问过深，已拒绝。");
          const fromName = runner.cards.get(callerId)?.name ?? callerId;
          const direct = params.direct_to_user === true;
          runner.transcript.log({ type: "ask", from: fromName, to: target.name, question: params.question, direct });
          runner.busy.add(target.id);
          runner.askDepth++;
          try {
            const reply = await runner.promptAgent(
              target.id,
              direct
                ? `[协作提问] 「${fromName}」替用户问你：${params.question}\n你的回答会直接显示给用户看，请直接回复用户，简洁明了。`
                : `[协作提问] 「${fromName}」问你：${params.question}\n请直接回答他的问题，简洁明了。`
            );
            runner.transcript.log({ type: "ask_reply", from: target.name, to: fromName, direct, text: reply });
            if (direct) {
              console.log(`\n[${target.name}] ${reply}\n`);
              return textResult(`「${target.name}」已直接回复用户，无需你转述。`);
            }
            return textResult(`「${target.name}」的回答：\n${reply}`);
          } finally {
            runner.busy.delete(target.id);
            runner.askDepth--;
          }
        },
      }),
      defineTool({
        name: "handoff",
        label: "转交任务",
        description:
          "把当前任务转交给更契合的 agent。交接包 5 项：任务是什么、做到哪了、为什么转给他、接下来要什么、相关资料；写不全没关系，对方会多轮追问补齐。",
        parameters: Type.Object({
          to: Type.String({ description: "接收 agent 的名字或 id" }),
          task: Type.String({ description: "任务是什么" }),
          progress: Type.String({ description: "已经做到哪了" }),
          reason: Type.String({ description: "为什么转给他（契合点）" }),
          next_step: Type.String({ description: "接下来期望他交付什么" }),
          context: Type.Optional(Type.String({ description: "相关资料/上下文" })),
        }),
        execute: async (_id, params) => {
          const target = runner.getCard(params.to);
          if (!target) return textResult(`找不到 agent「${params.to}」，先用 list_agents 确认名字。`);
          if (target.id === callerId) return textResult("不能转交给自己。");
          if (runner.busy.has(target.id))
            return textResult(`「${target.name}」正忙，为避免死循环本次转交被拒绝，请稍后或换人。`);
          const fromName = runner.cards.get(callerId)?.name ?? callerId;
          runner.handoffs.push({
            from: fromName,
            to: target.name,
            task: params.task,
            progress: params.progress,
            reason: params.reason,
            nextStep: params.next_step,
            at: new Date().toISOString(),
          });
          runner.transcript.log({
            type: "handoff",
            from: fromName,
            to: target.name,
            task: params.task,
            progress: params.progress,
            reason: params.reason,
            nextStep: params.next_step,
            context: params.context,
          });
          runner.busy.add(target.id);
          try {
            const reply = await runner.promptAgent(
              target.id,
              `[任务转交] 「${fromName}」把任务转交给你：\n` +
                `1) 任务是什么：${params.task}\n` +
                `2) 做到哪了：${params.progress}\n` +
                `3) 为什么转给你：${params.reason}\n` +
                `4) 接下来要什么：${params.next_step}\n` +
                (params.context ? `5) 相关资料：${params.context}\n` : "") +
                `请接手继续。如有不清楚的，直接在对话中追问。`
            );
            return textResult(`已转交给「${target.name}」，他的回复：\n${reply}`);
          } finally {
            runner.busy.delete(target.id);
          }
        },
      }),
      defineTool({
        name: "broadcast",
        label: "群里广播",
        description: "在群聊里广播一句话，所有 agent 都能看到（@某人可点名引起其关注）。",
        parameters: Type.Object({
          message: Type.String({ description: "要广播的内容" }),
        }),
        execute: async (_id, params) => {
          const name = runner.cards.get(callerId)?.name ?? callerId;
          runner.groupLog.push({ who: name, text: params.message });
          runner.transcript.log({ type: "broadcast", from: name, text: params.message });
          return textResult(`已广播到群聊（${runner.groupLog.length} 条记录）。`);
        },
      }),
      defineTool({
        name: "create_agent",
        label: "创建子 agent",
        description:
          "创建一个新的 agent（记录你是创建者 parent）。新 agent 会获得自己的定位卡和协作规范。适用于需要专人负责的子任务。",
        parameters: Type.Object({
          name: Type.String({ description: "新 agent 的名字" }),
          role: Type.String({ description: "职责一句话" }),
          tools: Type.Optional(Type.String({ description: "可用工具，逗号分隔" })),
          resources: Type.Optional(Type.String({ description: "可访问资源，逗号分隔" })),
          approve: Type.Optional(Type.Boolean({ description: "能否审批，默认 false" })),
          spend: Type.Optional(Type.Boolean({ description: "能否花钱，默认 false" })),
        }),
        execute: async (_id, params) => {
          const card = await runner.createAgent({
            name: params.name,
            role: params.role,
            tools: params.tools?.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean),
            resources: params.resources?.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean),
            approve: params.approve,
            spend: params.spend,
            parent: callerId,
          });
          return textResult(`已创建 agent「${card.name}」（id: ${card.id}），定位：${card.role}。可用 list_agents 查看。`);
        },
      }),
    ];

    // 真实场景项目工具（PROJECT_TOOLS=1 时启用）：直接操作 gtd 实验仓库
    if (process.env.PROJECT_TOOLS === "1") {
      const trunc = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…(截断)" : s);
      tools.push(
        defineTool({
          name: "sh",
          label: "执行 shell",
          description:
            `在项目目录 ${PROJECT_DIR} 执行 shell 命令（timeout 180s）。` +
            `可跑 pnpm test/build、git、wrangler 等。Cloudflare 实验资源配置在 ${EXP_WRANGLER_CONFIG}，` +
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
              logTool("sh", params.command, r.ok, Date.now() - t0, out);
              return textResult(trunc(out));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logTool("sh", params.command, false, Date.now() - t0, msg);
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
              logTool("read", params.path, true, Date.now() - t0, out.slice(0, 300));
              return textResult(trunc(out));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logTool("read", params.path, false, Date.now() - t0, msg);
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
              logTool("write", params.path, true, Date.now() - t0, out);
              return textResult(out);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logTool("write", params.path, false, Date.now() - t0, msg);
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
              logTool("edit", `${params.path}: ${params.old_text.slice(0, 80)}…`, true, Date.now() - t0, out);
              return textResult(out);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logTool("edit", params.path, false, Date.now() - t0, msg);
              return textResult(`替换失败：${msg}`);
            }
          },
        })
      );
    }
    return tools;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentCard> {
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
    const loader = new DefaultResourceLoader({
      cwd: ROOT,
      agentDir: join(ROOT, ".pi"),
      appendSystemPromptOverride: (base) => [...base, buildCollabPrompt(card)],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      model: this.model,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      customTools: this.buildTools(id),
    });
    this.sessions.set(id, session);
    this.cards.set(id, card);
    this.ledger.set(id, { input: 0, output: 0 });
    this.transcript.log({
      type: "create_agent",
      name: card.name,
      id: card.id,
      role: card.role,
      parent: this.cards.get(input.parent ?? "user")?.name ?? input.parent ?? "user",
    });
    saveRegistry(this.listCards());
    return card;
  }

  /** 向指定 agent 发一句话，返回它的文本回复，并记 token 账 */
  async promptAgent(id: string, text: string): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`agent 会话不存在: ${id}`);
    const before = sessionTokens(session);
    await session.prompt(text);
    const reply = lastAssistantText(session);
    const after = sessionTokens(session);
    const cur = this.ledger.get(id) ?? { input: 0, output: 0 };
    cur.input += Math.max(0, after.input - before.input);
    cur.output += Math.max(0, after.output - before.output);
    this.ledger.set(id, cur);
    return reply;
  }

  tokenReport(): { perAgent: Record<string, TokenUsage & { name: string }>; total: TokenUsage } {
    const perAgent: Record<string, TokenUsage & { name: string }> = {};
    const total = { input: 0, output: 0 };
    for (const [id, u] of this.ledger) {
      perAgent[id] = { ...u, name: this.cards.get(id)?.name ?? id };
      total.input += u.input;
      total.output += u.output;
    }
    return { perAgent, total };
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      try {
        s.dispose();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}
