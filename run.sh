#!/bin/bash
# 启动 bot-teahouse：每次取新的 DeepSeek surrogate key 注入环境变量后启动。
# 注意：surrogate 可能过期，长跑进程请重启本脚本刷新。绝不在日志中打印 key。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "首次运行，安装依赖…"
  npm install
fi

echo "编译 TypeScript…"
npx tsc

# ---- 密钥来源 ----
# 本机（Hatch）实验环境：每次取新的动态短时凭证注入（防 surrogate 过期，原有行为）。
# 外部机器：从环境变量或项目根目录 .env 读取（复制 .env.example 为 .env 并填写）。
cred_bin="/opt/hatch/skills/skill-creator/bin"
if [ -d "$cred_bin" ]; then
  S=$(python3 -c "import sys; sys.path.insert(0,'$cred_bin'); from dynamic_credentials import dynamic_credential_entry; print(dynamic_credential_entry('custom.deepseek')['surrogate'])")
  export DEEPSEEK_API_KEY="$S"

  # 实验用 Cloudflare token（短时 surrogate，只进进程环境变量，不落盘）。
  # agent 的 sh 工具描述里写的"CLOUDFLARE_API_TOKEN 已注入环境变量"靠这一行兑现；
  # guardCloudflare 只放行 -c wrangler.exp.json 的实验命令，生产碰不到。
  CF=$(python3 -c "import sys; sys.path.insert(0,'$cred_bin'); from dynamic_credentials import dynamic_credential_entry; print(dynamic_credential_entry('custom.cloudflare')['surrogate'])")
  export CLOUDFLARE_API_TOKEN="$CF"
else
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
  if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    echo "ERR: 缺少 DEEPSEEK_API_KEY：复制 .env.example 为 .env 并填写你的 key，或直接 export DEEPSEEK_API_KEY" >&2
    exit 1
  fi
fi

# 崩溃取证：node 的全部 stdout/stderr 落盘到日志文件。
# 实验进程若悄无声息地死掉（如 V8 堆 OOM），实录里看不到原因，只能看这个日志。
LOGDIR="$(pwd)/data/logs"
mkdir -p "$LOGDIR"
RUN_MODE="${1:-cli}"
LOGFILE="$LOGDIR/$(date +%Y%m%d-%H%M%S)-$$-$RUN_MODE.log"
echo "运行日志：$LOGFILE"

if [ "${1:-}" = "accept" ]; then
  exec node dist/accept.js >>"$LOGFILE" 2>&1
elif [ "${1:-}" = "exp-attach" ]; then
  exec node dist/exp-attach.js >>"$LOGFILE" 2>&1
elif [ "${1:-}" = "exp-attach-real" ]; then
  exec node dist/exp-attach-real.js >>"$LOGFILE" 2>&1
elif [ "${1:-}" = "exp-room" ]; then
  exec node dist/exp-room.js >>"$LOGFILE" 2>&1
else
  exec node dist/cli.js "$@" >>"$LOGFILE" 2>&1
fi
