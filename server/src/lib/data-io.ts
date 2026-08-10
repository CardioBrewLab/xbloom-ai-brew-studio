/**
 * 数据文件 IO 公共工具（recipes / beans / session 共用）：
 * - atomicWriteJson：写临时文件 + rename 原子替换，杜绝半截文件；
 * - loadJsonArray：区分 ENOENT（首次运行，正常为空）与 JSON 损坏
 *   （console.warn 并备份为 *.corrupt-<ts> 后返回空，不吞 IO 异常）。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 原子写 JSON：先写 xxx.tmp 再 rename 覆盖目标。
 * Windows 上 rename 目标已存在时通常可直接覆盖；若失败则先 unlink 目标再重试。
 */
export function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 目标本就不存在 */
    }
    fs.renameSync(tmp, file);
  }
}

/**
 * 读取 JSON 数组数据文件：
 * - ENOENT → 空数组（首次运行的正常状态）；
 * - JSON 损坏 → console.warn 并备份为 *.corrupt-<ts>，返回空数组；
 * - 其他 IO 错误 → 原样抛出（不静默吞掉）。
 */
export function loadJsonArray<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    console.warn(`[data] 数据文件损坏，已备份为 ${backup} 并按空库处理：${file}`);
    try {
      fs.renameSync(file, backup);
    } catch {
      /* 备份失败尽力而为，不阻塞读取 */
    }
    return [];
  }
}
