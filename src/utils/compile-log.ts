import * as fs from 'fs';
import * as path from 'path';

// 编译日志共用模块
//
// readSnippet：读文件指定行附近的代码片段（error 上下文）
// writeCompileLog：写 JSON 格式编译 log（文件名带时间戳）

/** 读文件指定行附近的代码片段（error 上下文，方便定位） */
export function readSnippet(filePath: string, line: number, contextLines = 1): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

/**
 * 写编译 log（JSON 格式 + 文件名带时间戳，方便 jq 筛选）
 * @param dir 工程根目录
 * @param prefix 文件名前缀（如 compile-log- / eslint-log- / build-log-）
 * @param data log 内容（JSON 序列化，任意对象）
 * @param category 可选：分类子目录名（如 compile / eval / lint / build / verify / browserlogs）
 *                 传则写到 .cocoscli/logs/<category>/，不传则写到 .cocoscli/ 根目录（向后兼容）
 * @param timestamp 可选：外部时间戳（build 用它让 build-log JSON 与 build-raw log 同名配对）
 * @returns log 文件完整路径
 */
export function writeCompileLog(
  dir: string,
  prefix: string,
  data: unknown,
  category?: string,
  timestamp?: string
): string {
  // 有 category：按命令分类归档到 .cocoscli/logs/<category>/；无 category：留 .cocoscli/ 根目录
  const logDir = category
    ? path.join(dir, '.cocoscli', 'logs', category)
    : path.join(dir, '.cocoscli');
  fs.mkdirSync(logDir, { recursive: true });
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(logDir, `${prefix}${ts}.json`);
  fs.writeFileSync(logPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return logPath;
}
