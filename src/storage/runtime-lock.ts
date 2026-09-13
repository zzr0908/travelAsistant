import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
export function assertStopped(directory: string) {
  const file = join(directory, ".app.lock");
  if (!existsSync(file)) return;
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(file, "utf8")).pid;
  } catch {
    throw new Error("运行锁无法读取，请检查应用状态。");
  }
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("运行锁无效，请检查应用状态。");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      unlinkSync(file);
      return;
    }
    throw error;
  }
  throw new Error("应用正在使用这个数据目录，请先停止应用。");
}
export function acquireLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertStopped(directory);
  const file = join(directory, ".app.lock");
  writeFileSync(file, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  return () => {
    if (
      existsSync(file) &&
      JSON.parse(readFileSync(file, "utf8")).pid === process.pid
    )
      unlinkSync(file);
  };
}
