# bot-teahouse

多 Agent 协作系统（"茶馆"）：用户从零设计的协作流程的第一步：只做**协作系统本身**（终端 CLI）。
不做 IM 界面、不做 Cloudflare、不做 D1/R2，数据用本地 JSON 文件。

Agent harness 用 **Pi**（`@earendil-works/pi-coding-agent` 的 TypeScript SDK），
模型用 **DeepSeek**（OpenAI-compatible `/chat/completions`）。

## 启动

```bash
./run.sh            # 进入 CLI
./run.sh accept     # 跑验收脚本（真实调用 DeepSeek）
```

`run.sh` 每次启动时从 Secure Vault 取新的 DeepSeek surrogate key，
注入 `DEEPSEEK_API_KEY` 后再启动 node 进程。注意：

- surrogate 可能过期，**长跑进程请重启 `run.sh` 刷新**；
- 绝不在日志/终端打印 surrogate 或真 key；
- 必须在项目根目录运行（`run.sh` 会自动 `cd`）。

## CLI 命令

| 命令 | 说明 |
|---|---|
| `/create <名字> --role "职责一句话" [--tools "a,b"] [--resources "a,b"] [--approve] [--spend]` | 用户创建 agent（定位卡） |
| `/agents` | 查看花名册 |
| `/dm <名字>` | 进入与指定 agent 的单聊（`/exit` 退出）；消息直达该 agent |
| `/group <消息>` | 群聊发言：广播给所有 agent，各 agent 自行判断是否响应（无关则回 `<skip>`），按顺序输出不刷屏 |
| `/spawn` | 说明 agent 如何创建子 agent |
| `/tokens` | 查看 token 消耗（分 agent + 总计） |
| `/quit` | 退出（打印本次 token 总消耗） |

## 协作设计（已实现的用户决策）

- **定位卡**：名字、职责一句话、可用工具、可访问资源、权限（审批/花钱）；存 `data/agents.json`。
- **第一性原理**：全员互相可见，只有协作关系，没有上下级（写入每个 agent 的 system prompt）。
- **派单**：用户跟谁聊任务就归谁；有全局更契合的 agent 则 `handoff` 转交；用户点名优先。
- **总原则**：不知道就问，问要找对人（先 `list_agents` 看花名册）。
- **转交交接包**（5 项推荐，不强制校验，多轮对话可补齐）：任务是什么 / 做到哪了 / 为什么转给你 / 接下来要什么 / 相关资料。
- **@** = 点名关注，不改变可见性。单聊仅双方可见；群聊全员可见。
- 每个 agent 的协作工具（Pi 自定义工具）：`list_agents`、`ask_agent`、`handoff`、`broadcast`、`create_agent`。
- `ask_agent`/`handoff` 有防死循环保护：目标 agent 正忙（在本次调用链中）或嵌套超过 4 层时拒绝。
- 群聊有 token 预算兜底：单次群聊讨论累计 token 超过预算（默认 200000，环境变量 `GROUP_TOKEN_BUDGET` 可覆盖）时提前结束。预算内不设轮数上限、不设发言顺序。
- 实验支持续跑：`RESUME_FROM=<runId> ./run.sh exp-attach` 会用纪要式开场（已定事项+未决事项）从上一轮中断处继续，而不是从头重聊。第一轮（20260916-153813）因虚拟机重启在第 9 轮中断后，用此方式续跑。

## 架构

```
src/
  cli.ts          终端交互（readline）
  accept.ts       验收脚本
  runner.ts       AgentRunner：Pi 会话管理、协作工具、token 账本、防重入
  registry.ts     data/agents.json 读写
  systemPrompt.ts 协作规范（append 到 Pi 默认 system prompt）
  types.ts / paths.ts
.pi/models.json  deepseek provider 注册（openai-completions，apiKey 用 $DEEPSEEK_API_KEY 插值）
```

- 每个 agent 一个 Pi `AgentSession`（`SessionManager.inMemory()`，进程内有效）。
- Provider 注册走官方 `models.json` 机制：`ModelRuntime.create({ modelsPath })`，
  不走 extension 工厂（SDK 的 ModelRuntime 不直接吃 extension 注册的 provider）。
- 默认模型 `deepseek-v4-pro`（`getModel` 取不到时 fallback `deepseek-flash`）。

## 验收（2026-09-16 实测通过）

`./run.sh accept` 真实调用 DeepSeek 跑通：

1. 创建 2 个 agent（调研员、写手）
2. DM 给写手派了一个更对口调研员的任务 → 写手查花名册后 `handoff` 转给调研员（记录 1 次）
3. 群聊发言后：调研员正确回 `<skip>`（与己无关），写手输出简报
4. 调研员用 `create_agent` 创建子 agent「核验员」（parent=调研员）
5. token 总消耗：input 6097 / output 4526，合计 10623

## 为跑通做的关键适配

1. **Pi 包的 `exports` 字段是裸数组**（`[".", "./rpc-entry", ...]`），tsx 的 resolver 直接报错。
   改用 `tsc` 编译成 ESM（`dist/`）+ 纯 `node` 运行，node 原生可解析。
2. `import.meta` 被 tsc 判为 CJS 输出而禁用 → 改用 `process.cwd()` 定位项目根（`run.sh` 保证 cwd）。
3. `DefaultResourceLoader` 要求传 `agentDir` → 指向项目内 `.pi/`，不污染 `~/.pi`。
4. DeepSeek 两个模型都是 reasoning 模型（`reasoning_content`），Pi 的 openai-completions
   实现原生解析该字段；`models.json` 里 `reasoning: false` + `compat.supportsDeveloperRole: false`
   即可稳定调用，`maxTokens: 8192` 避免 reasoning 吃掉输出额度。
5. `noTools: "builtin"` 关掉 Pi 内置的 read/bash/edit/write，agent 只保留 5 个协作工具。

## 实验实录（transcript）

每次启动自动在 `data/transcripts/<runId>/events.jsonl` 记录**全部协作事件**，
一行一个 JSON，同步追加写——进程被 kill（SIGTERM/SIGINT）已发生的事件也不丢：

- `run_start`（模型、花名册）/ `run_end`（token 总消耗）
- `group_user` / `group_agent` / `group_skip` / `group_error` / `group_round_start` / `group_end`
  （群聊：连谁回了 `<skip>` 都记，方便事后分析协作行为）
- `dm_user` / `dm_agent`（单聊双方原话）
- `ask` / `ask_reply`、`handoff`、`broadcast`、`create_agent`

`data/transcripts/LATEST` 指向最近一次运行。看上次群聊逐字记录：

```bash
cat data/transcripts/$(cat data/transcripts/LATEST)/events.jsonl
```

注意：Pi 会话仍是进程内内存（重启后 agent 私有历史丢失），
但**群聊/单聊/转交的全部公开事件**已有完整落盘记录。

## 待定（用户已明确暂不做）

- 任务状态机、分歧解决机制
- IM 界面、Cloudflare、D1/R2
- agent 私有会话历史持久化（当前重启进程后 agent 私有历史丢失，定位卡保留；
  公开协作事件已有 transcript 落盘）
