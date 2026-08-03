import { execFileSync } from 'child_process';
import { isWindows, isMac } from './platform.js';
import { normalizePath } from './project.js';

// CocosCreator 进程枚举与终止（跨平台）
//
// findCocosProcesses()
//        ├─> Windows  PowerShell Get-CimInstance Win32_Process
//        ├─> macOS    ps -ax -o pid=,command=
//        └─> Linux    ps -e -o pid=,args=
// isProjectMatch(cmd, target)
//        └─> 解析 --project 值，normalizePath 精确比对（防 D:\A 误杀 D:\AB）
// killProcess(pid)
//        ├─> Windows  taskkill /PID pid /T /F
//        └─> 类 Unix  process.kill(pid, SIGKILL)

/** 一个 CocosCreator 进程 */
export interface CocosProcess {
  pid: number;
  command: string;
}

/** CocosCreator 进程名标记（用于 ps 输出过滤） */
const CREATOR_MARKER = 'CocosCreator';

/**
 * 枚举本机所有 CocosCreator 进程（跨平台）
 */
export function findCocosProcesses(): CocosProcess[] {
  if (isWindows()) return findOnWindows();
  if (isMac()) return findOnUnix(['-ax', '-o', 'pid=,command=']);
  return findOnUnix(['-e', '-o', 'pid=,args=']); // Linux
}

/** Windows：通过 PowerShell Get-CimInstance 查询（wmic 在 Win11 逐步弃用） */
function findOnWindows(): CocosProcess[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"name='CocosCreator.exe'\" | " +
    'ForEach-Object { "$($_.ProcessId)|||$($_.CommandLine)" }';
  let out: string;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return parseWindowsOutput(out);
}

/** 解析 Windows PowerShell 的 PID|||CommandLine 输出 */
export function parseWindowsOutput(out: string): CocosProcess[] {
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('|||');
      if (idx < 0) return null;
      const pid = parseInt(line.slice(0, idx), 10);
      const command = line.slice(idx + 3);
      if (Number.isNaN(pid) || !command) return null;
      return { pid, command };
    })
    .filter((p): p is CocosProcess => p !== null);
}

/** macOS / Linux：通过 ps 查询，过滤含 CocosCreator 的行 */
function findOnUnix(psArgs: string[]): CocosProcess[] {
  let out: string;
  try {
    out = execFileSync('ps', psArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(.*)$/);
      return m ? { pid: parseInt(m[1], 10), command: m[2] } : null;
    })
    .filter((p): p is CocosProcess => p !== null)
    .filter((p) => p.command.includes(CREATOR_MARKER));
}

/**
 * 从命令行提取 --project（或 -project）的值
 * 支持带引号和不带引号两种形式
 */
export function extractProjectFromCommand(cmd: string): string | null {
  const quoted = cmd.match(/--?project\s+"([^"]+)"/);
  if (quoted) return quoted[1];
  const unquoted = cmd.match(/--?project\s+([^\s]+)/);
  return unquoted ? unquoted[1] : null;
}

/**
 * 判断进程命令行是否对应目标工程（防误伤核心）
 * 用 normalizePath 精确比对，D:\A 不会误匹配 D:\AB
 */
export function isProjectMatch(cmd: string, targetProject: string): boolean {
  const p = extractProjectFromCommand(cmd);
  return !!p && normalizePath(p) === normalizePath(targetProject);
}

/**
 * 终止进程（跨平台）
 * Windows: taskkill /PID /T /F（连同子进程）
 * 类 Unix: process.kill 发送 SIGKILL
 */
export function killProcess(pid: number): void {
  if (isWindows()) {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}
