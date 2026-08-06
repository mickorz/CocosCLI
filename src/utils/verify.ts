import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import http from 'http';

// verify 命令的工具集
//
// 三部分：
//   1. tsc 编译检查（runTscCheck + parseTscErrors）
//   2. MCP / preview HTTP 验证（httpOk + verifyMcpConnection + verifyPreviewUrl）
//   3. opencode run --format json 事件流监控（runOpencodeMonitored + 状态机）
//
// 状态判断的完整说明见 Docs/cocoscli-verify-opencode状态监控.md

// ==================== tsc 编译检查 ====================

/** 一条 tsc error */
export interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/**
 * 解析 tsc 输出，提取 error 行
 * 行格式：file(line,col): error TSxxxx: message
 */
export function parseTscErrors(output: string): TscError[] {
  const errors: TscError[] = [];
  const re = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      errors.push({
        file: m[1],
        line: parseInt(m[2], 10),
        col: parseInt(m[3], 10),
        code: m[4],
        message: m[5],
      });
    }
  }
  return errors;
}

/**
 * 跑 npx tsc --noEmit，返回 error 列表
 * 无 tsconfig.json 则跳过（ran=false）
 */
export function runTscCheck(
  projectPath: string
): { errors: TscError[]; raw: string; ran: boolean } {
  const tsconfig = path.join(projectPath, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    return { errors: [], raw: '', ran: false };
  }
  const result = spawnSync('npx', ['tsc', '--noEmit', '--project', tsconfig], {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  return { errors: parseTscErrors(combined), raw: combined, ran: true };
}

// ==================== HTTP 验证 ====================

/** HTTP GET，返回是否可访问（状态码 < 400） */
export function httpOk(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 验证 CocosMCP 扩展的 health 端点（默认 3001） */
export function verifyMcpConnection(port = 3001): Promise<boolean> {
  return httpOk(`http://127.0.0.1:${port}/health`);
}

/** 验证 CocosCreator preview server（默认 7456） */
export function verifyPreviewUrl(port = 7456): Promise<boolean> {
  return httpOk(`http://localhost:${port}`);
}

// ==================== opencode 事件流监控 ====================

/** opencode 任务状态 */
export type OpencodeState =
  | 'STARTING'
  | 'BUSY'
  | 'RUNNING_TOOL'
  | 'IDLE'
  | 'SUCCEEDED'
  | 'FAILED';

/** opencode 任务结果 */
export interface OpencodeResult {
  state: OpencodeState;
  exitCode: number;
  toolsCalled: string[];
  todos: { content: string; status: string }[];
  error?: string;
}

/** 解析一行 opencode 事件 JSON（非 JSON 行返回 null） */
export function parseOpencodeEvent(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 根据事件更新状态机
 *
 * opencode 真实事件（debug 确认，非二手资料）：
 *   step_start  → 步骤开始
 *   text        → 文本输出（part.text）
 *   tool_use    → 工具调用（part.tool、part.state.status: running/completed）
 *   step_finish → 步骤结束（part.reason: stop）
 *
 * 返回新状态 + 附带信息（工具名）
 */
export function updateStateFromEvent(
  event: Record<string, unknown>,
  current: OpencodeState
): { state: OpencodeState; tool?: string } {
  const type = event.type as string | undefined;
  const part = (event.part ?? {}) as Record<string, unknown>;

  if (type === 'step_start') {
    return { state: 'BUSY' };
  }
  if (type === 'step_finish') {
    return { state: 'IDLE' };
  }
  if (type === 'tool_use') {
    const partState = (part.state ?? {}) as Record<string, unknown>;
    const status = partState.status as string | undefined;
    const tool = part.tool as string | undefined;
    if (status === 'running') {
      return { state: 'RUNNING_TOOL', tool };
    }
    // completed 等状态：记录工具名，状态不变
    return { state: current, tool };
  }
  // text 及未知事件：不改状态
  return { state: current };
}

/**
 * 跑 opencode run --format json，逐行解析事件，维护状态机
 *
 * @param prompt 传给 opencode 的 message
 * @param cwd 工程目录
 * @param onProgress 状态变化回调（实时打印进度）
 * @returns 任务结果（状态、退出码、调用过的工具、todo、错误）
 */
export function runOpencodeMonitored(
  prompt: string,
  cwd: string,
  onProgress?: (state: OpencodeState, info: string) => void
): Promise<OpencodeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'opencode',
      ['run', '--format', 'json', '--title', 'cocoscli-verify', prompt],
      // env 必须带 PWD：opencode.exe 靠 PWD 环境变量定位项目根并加载 .opencode/skills，
      // Windows 的 cmd / Node spawn 默认不设 PWD，不带则项目 skill 加载不到
      { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: true, env: { ...process.env, PWD: cwd } }
    );

    let state: OpencodeState = 'STARTING';
    let sawStepStart = false;
    const toolsCalled: string[] = [];
    const todos: { content: string; status: string }[] = [];
    let errorMsg: string | undefined;
    let buf = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const event = parseOpencodeEvent(line);
        if (!event) continue;

        // 记录是否真正开始执行（用于最终严格判定）
        if (event.type === 'step_start') sawStepStart = true;

        const upd = updateStateFromEvent(event, state);
        if (upd.state !== state) {
          state = upd.state;
        }
        if (upd.tool && !toolsCalled.includes(upd.tool)) {
          toolsCalled.push(upd.tool);
        }

        onProgress?.(state, upd.tool ?? '');
      }
    });

    child.on('close', (code: number | null) => {
      const exitCode = code ?? 0;
      // 严格判定：必须看到 step_start（证明 opencode 真正执行过）+ 退出码 0 才算成功
      let finalState: OpencodeState;
      if (exitCode !== 0 || !sawStepStart) {
        finalState = 'FAILED';
        if (!errorMsg) {
          errorMsg = sawStepStart
            ? `opencode 退出码 ${exitCode}`
            : 'opencode 未执行任何步骤（未收到 step_start 事件，可能权限被拒）';
        }
      } else {
        finalState = 'SUCCEEDED';
      }
      resolve({ state: finalState, exitCode, toolsCalled, todos, error: errorMsg });
    });

    child.on('error', () => {
      resolve({
        state: 'FAILED',
        exitCode: -1,
        toolsCalled,
        todos,
        error: 'opencode 启动失败（未安装或不在 PATH？）',
      });
    });
  });
}
