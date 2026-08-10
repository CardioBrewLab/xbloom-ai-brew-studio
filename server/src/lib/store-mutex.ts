/**
 * 文件级进程内互斥串行队列（任务 #50 豆仓库存）。
 *
 * withFileLock(file, fn)：同一文件路径的所有 fn 按调用顺序串行执行，
 * 保证「读-改-写」复合操作在并发请求下不丢更新（如 consume 扣减库存）。
 *
 * 事务语义与局限（务必知悉）：
 * - 仅对**单进程**有效：锁表是模块内 Map，多进程/多实例部署无法互斥，
 *   本项目后端为单进程 tsx watch，故足够；横向扩展时需换成文件锁/数据库。
 * - 锁粒度是「文件路径」：不同文件之间完全并行，同一文件严格串行。
 * - fn 抛错只影响本次调用的调用方（promise reject），不会毒化队列，
 *   后续任务照常执行；锁本身不提供回滚，事务性由 fn 内配合
 *   atomicWriteJson（写临时文件 + rename 原子替换）共同达成。
 * - 队列空闲时自动回收 Map 条目，避免长尾路径无限增长。
 */
import path from "node:path";

/** 锁表：文件绝对路径 → 该文件当前队尾任务（settled promise） */
const locks = new Map<string, Promise<void>>();

/**
 * 在指定文件的串行队列内执行 fn。
 * 同一文件的调用按 FIFO 顺序逐个执行；fn 的返回值/异常原样透传给调用方。
 */
export function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = locks.get(key) ?? Promise.resolve();
  // 前置任务无论成功失败，都不应阻塞后续任务（reject 只传递给它自己的调用方）
  const run = prev.then(fn, fn);
  // 队尾登记一个永settled的 promise，作为下一个任务的「前置」
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  // 队列空闲（队尾仍是自己）时回收条目，防止 Map 无限增长
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}
