/** Hub <-> Worker IPC 协议。
 *
 * 定位（用户拍板）：
 * - room = 共享上下文空间：append-only 消息日志 + 成员列表，所有成员平权，没有主从。
 * - hub = dumb pipe：只存消息、广播投递、记账、supervision（崩溃重启）。不做任何发言决策。
 * - agent = 独立个体：独立进程、私有会话，收到外部消息后自己决定回不回、回什么。
 * - agent 之间直接在 room 里沟通，不经过任何中间人转达；私聊 = 2 个人的 room。
 */

export interface RoomMsg {
  seq: number;
  roomId: string;
  roomName: string;
  from: string; // agent 名或 "用户"
  fromId: string; // agent id 或 "user"
  text: string;
  ts: string;
  /** 可选：明确在回哪条消息（填那条的 seq）。纯信封元数据，hub 只存、只原样投递，不做任何语义判断。 */
  replyTo?: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  /** 成员名（展示用） */
  members: string[];
}

/** worker 发起的请求（hub 必须回 resp；reqId 由 worker 侧分配） */
export type W2HRequest =
  | { kind: "room_send"; room: string; text: string; replyTo?: number }
  | { kind: "room_create"; name: string }
  | { kind: "room_invite"; room: string; who: string }
  | { kind: "room_list" }
  | { kind: "agent_list" }
  | { kind: "agent_create"; name: string; role: string; room: string };

/** worker -> hub */
export type W2H =
  | { kind: "register"; agentId: string; cursor: Record<string, number> }
  | { kind: "heartbeat"; rssMB: number; heapUsedMB: number; heapTotalMB: number }
  | { kind: "busy"; busy: boolean }
  | { kind: "cursor_ack"; roomId: string; seq: number }
  | { kind: "tokens"; input: number; output: number }
  | {
      kind: "tool_call";
      who: string;
      tool: string;
      args: string;
      ok: boolean;
      ms: number;
      output: string;
    }
  /** 回合制：worker 本轮回复（发了言或 <skip>），hub 据此判断本轮屏障是否完成 */
  | { kind: "turn_done"; roomId: string; spoke: boolean }
  | (W2HRequest & { reqId: number });

/** hub -> worker */
export type H2W =
  | { kind: "registered"; rooms: RoomInfo[] }
  | { kind: "room_deliver"; msg: RoomMsg }
  | { kind: "room_joined"; room: RoomInfo; history: RoomMsg[] }
  | { kind: "resp"; reqId: number; ok: boolean; text: string; room?: RoomInfo }
  | { kind: "shutdown" }
  /**
   * 回合制：屏障同步——每轮开始时，hub 把自该 agent 上次 ack 以来本 room 的所有新消息
   * （按 seq 升序）同时投递给所有存活成员：无先后顺序、无指定顺序，回复速度决定落盘顺序。
   * hub 只做屏障同步（等所有人回复完再开下一轮），不读内容、不做发言决策。
   */
  | {
      kind: "turn_grant";
      room: RoomInfo;
      batch: RoomMsg[];
      round: number;
      /** 本轮参与的成员数（所有人同时收到） */
      total: number;
      /** 断点续跑时的提示（宿主重启后恢复），worker 拼进 wake prompt */
      resumeNote?: string;
    };

/** fork worker 时通过环境变量 WORKER_CONFIG 传入的配置 */
export interface WorkerConfig {
  agentId: string;
  name: string;
  role: string;
  tools: string[];
  resources: string[];
  permissions: { approve: boolean; spend: boolean };
  /** 会话落盘目录：data/sessions/<runId>/<agentId>/（崩溃重启靠它恢复） */
  sessionDir: string;
  projectTools: boolean;
  /** 实验开始时间（ISO），只做"墙上的钟"：让 agent 感知已进行多久，自主判断进展。不做任何判定。 */
  runStartedAt: string;
}
