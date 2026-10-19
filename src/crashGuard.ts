/** 崩溃兜底：进程异常死亡前，把最后一条"临终事件"同步写进实录。
 *  下次实验中途再中断，直接看实录尾部就知道死因，不用猜。
 *  能捕获：未捕获异常、未处理的 Promise 拒绝、SIGTERM。
 *  捕获不了：SIGKILL / V8 堆 OOM abort / 机器断电 —— 这类靠 run.sh 的日志文件 + 心跳事件定位。 */

import type { Transcript } from "./transcript.js";

export function memMB(): { rssMB: number; heapUsedMB: number; heapTotalMB: number } {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal) };
}

export function installCrashGuard(transcript: Transcript): void {
  let dying = false;
  const lastWords = (kind: string, message: string, exitCode: number) => {
    if (dying) return;
    dying = true;
    try {
      transcript.log({
        type: "crash",
        kind,
        message: message.slice(0, 4000),
        ...memMB(),
      });
    } catch {
      /* 临终写入失败也认了 */
    }
    // 同步写已经落盘，稍候按原语义退出（unref，不拖住进程）
    setTimeout(() => process.exit(exitCode), 100).unref();
  };

  process.on("uncaughtException", (e) => {
    const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    console.error(`[crash-guard] uncaughtException:\n${msg}`);
    lastWords("uncaughtException", msg, 1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}` : String(reason);
    console.error(`[crash-guard] unhandledRejection:\n${msg}`);
    lastWords("unhandledRejection", msg, 1);
  });
  process.on("SIGTERM", () => {
    console.error("[crash-guard] 收到 SIGTERM，记录后退出");
    lastWords("SIGTERM", "收到 SIGTERM，进程即将退出", 143);
  });
}
