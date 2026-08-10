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
 * 跑 npx tsc --noEmit 检查 assets 下的 TypeScript 源码，返回 error 列表
 *
 * 关键：CocosCreator 的 temp/tsconfig.cocos.json 没有 include 字段（只给 IDE 用 paths 映射），
 * 直接 --project 它不会检查 assets 源码。所以这里构造一个临时 tsconfig：
 *   extends temp/tsconfig.cocos.json（复用 cc 类型声明 / db://assets 路径映射）
 *   include assets 下所有 ts 文件（显式把源码纳入检查）
 *
 * 无 temp/tsconfig.cocos.json（编辑器未生成）则跳过（ran=false）
 */
export function runTscCheck(
  projectPath: string
): { errors: TscError[]; raw: string; ran: boolean } {
  const cocosTsconfig = path.join(projectPath, 'temp', 'tsconfig.cocos.json');
  if (!fs.existsSync(cocosTsconfig)) {
    return { errors: [], raw: '', ran: false };
  }
  // 构造临时 tsconfig 到 .cocoscli/（不入库，gitignore 已含 .cocoscli）
  const verifyDir = path.join(projectPath, '.cocoscli');
  fs.mkdirSync(verifyDir, { recursive: true });
  const verifyTsconfig = path.join(verifyDir, 'tsconfig.verify.json');
  fs.writeFileSync(
    verifyTsconfig,
    JSON.stringify(
      {
        extends: '../temp/tsconfig.cocos.json',
        include: ['../assets/**/*.ts'],
      },
      null,
      2
    ),
    'utf-8'
  );
  // 用 npx -y -p typescript tsc：CocosCreator 工程默认不在 node_modules 装 typescript，
  // 直接 npx tsc 会失败（"not the tsc command"），需显式指定 typescript 包让 npx 拉取
  const result = spawnSync(
    'npx',
    ['-y', '-p', 'typescript', 'tsc', '--noEmit', '--project', verifyTsconfig],
    {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    }
  );
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

/** POST JSON，返回解析后的对象（失败返回 null） */
export function httpPostJson(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks) as Record<string, unknown>);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

/**
 * 调 cocos-mcp server_information get_comprehensive_status，取真实 previewUrl
 * preview 端口是动态的（多工程递增 7456/7457...），不能写死 7456
 * @returns previewUrl（如 http://localhost:7456），失败返回 null
 */
export async function fetchPreviewUrl(mcpPort = 3001): Promise<string | null> {
  const resp = await httpPostJson(`http://127.0.0.1:${mcpPort}/api/server/server_information`, {
    action: 'get_comprehensive_status',
  });
  const result = (resp?.result ?? {}) as Record<string, unknown>;
  const data = (result.data ?? {}) as Record<string, unknown>;
  const previewUrl = data.previewUrl;
  return typeof previewUrl === 'string' && previewUrl ? previewUrl : null;
}

// ==================== cocos-mcp run_script_diagnostics（编译检查） ====================

/** 一条脚本编译 error（cocos-mcp run_script_diagnostics 返回） */
export interface ScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/**
 * 调 cocos-mcp run_script_diagnostics 检查 assets 编译 error
 *
 * 用 CocosCreator 编辑器内置 tsc（版本和 CocosCreator 一致，无 typescript 版本/cc 声明兼容坑），
 * 替代之前的 npx tsc（坑2 找不到 typescript + 坑3 版本/cc 声明不兼容）。
 * 端点：POST http://127.0.0.1:{mcpPort}/api/debug/run_script_diagnostics
 *
 * @returns errors 诊断列表 / ran 是否成功调用（false 表示 cocos-mcp 不可用）
 */
export async function runScriptDiagnosticsViaMcp(
  mcpPort = 3001
): Promise<{ errors: ScriptDiagnostic[]; ran: boolean }> {
  // run_script_diagnostics 调编辑器内置 tsc 编译 assets，耗时较长（可能 >5 秒），timeout 给 60 秒
  const resp = await httpPostJson(
    `http://127.0.0.1:${mcpPort}/api/debug/run_script_diagnostics`,
    {},
    60000
  );
  if (!resp) {
    return { errors: [], ran: false };
  }
  const result = (resp.result ?? {}) as Record<string, unknown>;
  const data = (result.data ?? {}) as Record<string, unknown>;
  // 检查 diagnostics 是数组（工具不存在/响应异常时没有，如 "Unknown tool"）
  if (!Array.isArray(data.diagnostics)) {
    return { errors: [], ran: false };
  }
  const diagnostics = data.diagnostics as ScriptDiagnostic[];
  return { errors: diagnostics, ran: true };
}

/**
 * 读目标工程 settings/mcp-server.json 的 port
 * 多工程时 CocosMCP 端口可能不是 3001（init 错开或手改），不能写死
 * @returns port（默认 3001）
 */
export function readMcpPort(projectPath: string): number {
  try {
    const mcpConfig = path.join(projectPath, 'settings', 'mcp-server.json');
    if (fs.existsSync(mcpConfig)) {
      const cfg = JSON.parse(fs.readFileSync(mcpConfig, 'utf-8')) as { port?: unknown };
      if (typeof cfg.port === 'number' && cfg.port > 0) return cfg.port;
    }
  } catch {
    // 忽略，返回默认
  }
  return 3001;
}

let _opencodePath: string | null | undefined;

/**
 * 找 opencode 可执行文件路径（带缓存）：
 * 1. 先试 PATH（spawnSync opencode --version）
 * 2. PATH 找不到 → 查 npm 全局 prefix（npm prefix -g）下的 opencode.cmd / opencode
 * @returns opencode 路径（PATH 可用时返回 'opencode'），找不到返回 null
 */
export function resolveOpencodePath(): string | null {
  if (_opencodePath !== undefined) return _opencodePath;

  // 方法1：PATH
  try {
    const result = spawnSync('opencode', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
    });
    if (result.status === 0) {
      _opencodePath = 'opencode';
      return _opencodePath;
    }
  } catch {
    // PATH 不可用
  }

  // 方法2：npm 全局 prefix（应对 PATH 没配好但 npm 全局装了的情况）
  try {
    const prefixResult = spawnSync('npm', ['prefix', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    });
    const prefix = (prefixResult.stdout || '').trim();
    if (prefix) {
      const isWin = process.platform === 'win32';
      const candidates = isWin
        ? [
            path.join(prefix, 'opencode.cmd'),
            path.join(prefix, 'opencode.exe'),
            path.join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
          ]
        : [
            path.join(prefix, 'opencode'),
            path.join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode'),
          ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          _opencodePath = c;
          return _opencodePath;
        }
      }
    }
  } catch {
    // npm 不可用
  }

  _opencodePath = null;
  return _opencodePath;
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
    const opencodePath = resolveOpencodePath();
    if (!opencodePath) {
      resolve({
        state: 'FAILED',
        exitCode: -1,
        toolsCalled: [],
        todos: [],
        error: 'opencode 未找到（不在 PATH，npm 全局也没找到）',
      });
      return;
    }
    const child = spawn(
      opencodePath,
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
