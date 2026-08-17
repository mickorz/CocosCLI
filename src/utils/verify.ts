import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import chalk from 'chalk';

// verify 命令的工具集
//
// 四部分：
//   1. tsc 编译检查（runTscCheck + parseTscErrors）
//   2. MCP / preview HTTP 验证（httpOk + verifyMcpConnection + verifyPreviewUrl
//      + detectLoopbackProxy / warnProxyIfLoopbackBlocked 代理旁证提示）
//   3. opencode run --format json 事件流监控（runOpencodeMonitored + 状态机）
//   4. 诊断降噪（judgeNoise + classifyDiagnostics）
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

/** 命中的代理环境变量 */
export interface ProxyEnvHit {
  varName: string;  // 如 'http_proxy' / 'HTTP_PROXY'
  value: string;
}

/**
 * 检测代理环境变量是否可能拦截本机回环访问（127.0.0.1/localhost）
 *
 * 背景：全局 gitconfig / 环境变量 http_proxy=127.0.0.1:7897 会让外部 curl /
 * puppeteer / opencode 访问 127.0.0.1:3001 被代理拦截（http_code=000 /
 * Navigation timeout）。cocoscli 自身用 Node 内置 http 直连，不读代理环境
 * 变量，CLI 检测不受影响——所以此函数只用于失败分支的旁证提示，不参与成败判定。
 *
 * @param env 环境变量表（注入 process.env 便于单测）
 * @returns 命中返回变量名与值；未设代理、或 no_proxy 已豁免回环（* / 127.0.0.1 / localhost）时返回 null
 */
export function detectLoopbackProxy(env: Record<string, string | undefined>): ProxyEnvHit | null {
  const names = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];
  const hit = names
    .map((n) => ({ n, v: env[n] }))
    .find((x) => x.v !== undefined && x.v.trim() !== '');
  if (!hit) return null;
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
  const entries = noProxy
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const loopbackExempt =
    entries.includes('*') || entries.includes('127.0.0.1') || entries.includes('localhost');
  return loopbackExempt ? null : { varName: hit.n, value: (hit.v ?? '').trim() };
}

/**
 * MCP 不可达时的代理旁证提示（黄字，不改变退出逻辑）
 *
 * 检测到 http_proxy/https_proxy 且 no_proxy 未覆盖 127.0.0.1/localhost 时打印，
 * 只提示不判定（cocoscli 自身不受影响，受影响的是外部工具的回环验证）。
 */
export function warnProxyIfLoopbackBlocked(): void {
  const hit = detectLoopbackProxy(process.env as Record<string, string | undefined>);
  if (!hit) return;
  console.log(
    chalk.yellow(
      `[提示] 检测到代理环境变量 ${hit.varName}=${hit.value}，且 no_proxy 未覆盖 127.0.0.1/localhost，外部工具访问本机回环端口可能被代理拦截。`
    )
  );
  console.log(
    chalk.yellow(
      '  cocoscli 自身的 HTTP 检查不走代理环境变量，不受影响；受影响的是 curl/puppeteer/opencode 等外部工具。'
    )
  );
  console.log(
    chalk.yellow(
      '  建议：设置 no_proxy=127.0.0.1,localhost（PowerShell：$env:NO_PROXY="127.0.0.1,localhost"），或临时清空代理变量后重试。'
    )
  );
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
  snippet?: string;  // cocos-mcp 已自带（error 行附近代码），优先用此字段
  category?: 'syntactic' | 'semantic';  // Compiler API 天然分类（语法 / 语义）
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
  mcpPort = 3001,
  tsconfigPath?: string,
  virtualDeclarations?: { fileName: string; content: string }[]
): Promise<{ errors: ScriptDiagnostic[]; environmentErrors: ScriptDiagnostic[]; ran: boolean }> {
  // run_script_diagnostics 调编辑器内置 tsc 编译 assets，耗时较长（可能 >5 秒），timeout 给 60 秒
  // P1: tsconfigPath 省略 → cocos-mcp 用工程 tsconfig.json（忠实模式，不自拼 verify tsconfig）
  // P2: virtualDeclarations → cocos-mcp VirtualDeclaration Host 注入 runtime globals bridge（不落盘）
  const body: Record<string, unknown> = {};
  if (tsconfigPath) body.tsconfigPath = tsconfigPath;
  if (virtualDeclarations && virtualDeclarations.length > 0) body.virtualDeclarations = virtualDeclarations;
  const resp = await httpPostJson(
    `http://127.0.0.1:${mcpPort}/api/debug/run_script_diagnostics`,
    body,
    60000
  );
  if (!resp) {
    return { errors: [], environmentErrors: [], ran: false };
  }
  const result = (resp.result ?? {}) as Record<string, unknown>;
  const data = (result.data ?? {}) as Record<string, unknown>;
  // 检查 diagnostics 是数组（工具不存在/响应异常时没有，如 "Unknown tool"）
  if (!Array.isArray(data.diagnostics)) {
    return { errors: [], environmentErrors: [], ran: false };
  }
  const diagnostics = data.diagnostics as ScriptDiagnostic[];
  // P2: virtual declaration 自身 diagnostics（bridge 解析失败等），单独返回，不混业务 real
  const environmentErrors = Array.isArray(data.environmentErrors) ? (data.environmentErrors as ScriptDiagnostic[]) : [];
  return { errors: diagnostics, environmentErrors, ran: true };
}

// ==================== verify tsconfig 构造（让 tsc 真正检查 assets） ====================

export interface VerifyTsconfigSetup {
  tsconfigPath: string;  // 相对 projectPath 的 POSIX 串；written=false 时为 ''
  written: boolean;
  reason?: string;       // written=false 时的兜底说明
}

/**
 * 在 .cocoscli/tsconfig.verify.json 构造临时 tsconfig，给 cocos-mcp run_script_diagnostics 用
 *
 * 背景：temp/tsconfig.cocos.json 没有 include 字段，tsc -p 它只编译 temp/ 下文件，不碰 assets，
 *      导致 compile 检不出 assets 脚本错误。这里构造一个 extends 它 + 显式 include assets 的临时配置。
 *
 * 关键：
 *   - 清空 types：原 tsconfig 的 types 用相对路径 './temp/declarations/cc'，命令行 tsc 按 tsconfig
 *     所在目录解析会拼成 temp/temp/... 找不到，报 TS2688 让类型系统崩溃、跳过类型检查；
 *     清空 types + 显式 include declarations 解决
 *   - dts/ 是工程自有第三方库声明目录（存在才 include）
 *
 * @returns tsconfigPath 给 cocos-mcp findTsConfig join 用（POSIX 相对路径，跨平台一致）
 *          written=false 表示 temp/tsconfig.cocos.json 不存在，调用方应拦截（避免假阳性）
 */
export function ensureVerifyTsconfig(projectPath: string, opts: { strict?: boolean } = {}): VerifyTsconfigSetup {
  const cocosTsconfig = path.join(projectPath, 'temp', 'tsconfig.cocos.json');
  if (!fs.existsSync(cocosTsconfig)) {
    return {
      tsconfigPath: '',
      written: false,
      reason: 'temp/tsconfig.cocos.json 不存在（编辑器未生成），无法构造 verify tsconfig',
    };
  }
  const dtsDir = path.join(projectPath, 'dts');
  const hasDts = fs.existsSync(dtsDir) && fs.statSync(dtsDir).isDirectory();

  const include = ['../temp/declarations/**/*.d.ts'];
  if (hasDts) include.push('../dts/**/*.d.ts');
  include.push('../assets/**/*.ts');

  // compilerOptions 单独构造：默认（非 strict）关 strict（务实工头视角，不管 null/类型不匹配/隐式any）
  const compilerOptions: Record<string, unknown> = {
    types: [],
    skipLibCheck: true, // 跳过 .d.ts 语义检查，避免引擎 @types（jsb.d.ts 等）声明噪音
    // 升级 lib：base 的 target ES2015 不含 includes/values/entries（ES2016/2017），工程大量用
    lib: ['ES2017', 'DOM'],
    // 还原 Cocos biz_modules / node_modules 的 *Module 裸模块别名
    // 编辑器用 cc 模块系统认这些别名，纯 tsc 不认 → import 解析失败 → TS2307/TS2503/TS2339 连锁
    baseUrl: '.',
    paths: {
      '*Module': ['../assets/biz_modules/*Module', '../assets/node_modules/*Module'],
      '*Module/*': ['../assets/biz_modules/*Module/*', '../assets/node_modules/*Module/*'],
    },
  };
  // --strict 时保持 base 的 strict:true 全开；默认覆盖为 false（对齐编辑器，不管 null/类型严格性）
  if (!opts.strict) {
    compilerOptions.strict = false;
  }

  const tsconfig = {
    extends: '../temp/tsconfig.cocos.json',
    compilerOptions,
    include,
  };

  const verifyDir = path.join(projectPath, '.cocoscli');
  fs.mkdirSync(verifyDir, { recursive: true });
  const verifyTsconfig = path.join(verifyDir, 'tsconfig.verify.json');
  fs.writeFileSync(verifyTsconfig, JSON.stringify(tsconfig, null, 2), 'utf-8');

  // path.relative 动态生成，避免目录改名时不跟随；统一正斜杠跨平台
  const rel = path.relative(projectPath, verifyTsconfig).replace(/\\/g, '/');
  return { tsconfigPath: rel, written: true };
}

// ==================== 诊断降噪（折叠第三方库声明噪音） ====================

export interface NoiseVerdict {
  noise: boolean;
  ns?: string;  // 归因（namespace / module / 全局名 / type），用于摘要
}

/**
 * 单条降噪判定（层 1 明确规则，export 便于单测逐 code 覆盖）
 *
 * 归 noise：TS2503(找不到ns) / TS1192(无默认导出) / TS7006+TS7005(隐式any) /
 *          TS2307(非相对模块) / TS2304(首字母大写的全局名)
 * 归 real：TS2304(小写名，局部变量) / TS2307(相对路径) / 其他未列出 code
 * 注：TS2339/TS2551（属性不存在）不在此处理，交给 classifyDiagnostics 的频次阈值法
 */
export function judgeNoise(e: ScriptDiagnostic): NoiseVerdict {
  const msg = e.message;
  switch (e.code) {
    case 'TS2503': {  // Cannot find namespace 'gf'.
      const m = msg.match(/^Cannot find namespace ['"]([^'"]+)['"]/);
      return { noise: true, ns: m?.[1] };
    }
    case 'TS1192': {  // Module '"proto_cm_protocol"' has no default export.（message 是 '"x"' 双层引号，['"]+ 兼容）
      const m = msg.match(/^Module ['"]+([^'"]+)['"]/);
      return { noise: true, ns: m?.[1] };
    }
    case 'TS7006':    // Parameter implicitly any
    case 'TS7005':    // Variable implicitly any
      return { noise: true };
    case 'TS2307': {  // Cannot find module 'gamePlatformModule' or its type declarations.
      const m = msg.match(/^Cannot find module ['"]([^'"]+)['"]/);
      const modPath = m?.[1] ?? '';
      // 非相对路径（不以 . 开头，含 bare specifier / @/ alias）→ noise；相对路径(./xxx) → real
      if (modPath && !modPath.startsWith('.')) {
        return { noise: true, ns: modPath };
      }
      return { noise: false };
    }
    case 'TS2304': {  // Cannot find name 'RoomPlayerData'.
      const m = msg.match(/^Cannot find name ['"]([^'"]+)['"]/);
      const name = m?.[1] ?? '';
      // 首字母大写（类型/全局类缺失）→ noise；小写（局部变量未定义）→ real
      if (name && /^[A-Z]/.test(name)) {
        return { noise: true, ns: name };
      }
      return { noise: false };
    }
    default:
      return { noise: false };
  }
}

export interface NoiseSummary {
  total: number;
  byCode: Record<string, number>;       // { TS2339: 9636, TS7006: 3954, ... }
  byNamespace: Record<string, number>;  // 层1 明确规则的归因（namespace/module/全局名）
  byType: Record<string, number>;       // 层2 频次噪音的 type（TS2339/TS2551 on type）
}

export interface ClassifiedDiagnostics {
  real: ScriptDiagnostic[];
  noise: ScriptDiagnostic[];
  noiseSummary: NoiseSummary;
  syntacticCount: number;  // real 里的语法错误数
  semanticCount: number;   // real 里的语义（类型）错误数
}

/**
 * 诊断分类：层1 judgeNoise 明确规则 + 层2 TS2339/TS2551 频次阈值
 *
 * 频次阈值：属性不存在类错误若同一 type 出现 > threshold 次，判为声明不全噪音
 * （声明完整时同一类型不会有成片属性错误；testerror 的 Player(2 条) 等低频 type 自动归 real）
 *
 * 实测（game-mahjong 工程）：TS2339+TS2551 共 13010 条 → 噪音 12839 / real 171
 *
 * @param threshold 同一 type 超过此次数归 noise（默认 5）
 */
export function classifyDiagnostics(
  errors: ScriptDiagnostic[],
  threshold = 5
): ClassifiedDiagnostics {
  // 第一遍：层 1 明确规则（syntactic 错误不降噪，必须看）
  const candidates: ScriptDiagnostic[] = [];
  const noise: ScriptDiagnostic[] = [];
  const byCode: Record<string, number> = {};
  const byNamespace: Record<string, number> = {};
  for (const e of errors) {
    if (e.category === 'syntactic') {
      candidates.push(e);  // 语法错误必须看，不降噪
      continue;
    }
    const v = judgeNoise(e);
    if (v.noise) {
      noise.push(e);
      byCode[e.code] = (byCode[e.code] || 0) + 1;
      if (v.ns) byNamespace[v.ns] = (byNamespace[v.ns] || 0) + 1;
    } else {
      candidates.push(e);
    }
  }

  // 第二遍：候选里的 TS2339/TS2551 按 on type 频次
  // 按外层引号类型匹配到同类型下一个引号，避免 type 内部嵌套引号被截断：
  //   on type 'typeof import("E:/.../proto")'  外层单引号、内部双引号
  // 原 [^'"]+ 会在内部双引号处截断成 'typeof import('，导致不同 import type 错误合并
  const typeOf = (e: ScriptDiagnostic): string => {
    const m = e.message.match(/on type '([^']+)'/) ?? e.message.match(/on type "([^"]+)"/);
    return m?.[1] ?? '';
  };
  const freq: Record<string, number> = {};
  for (const e of candidates) {
    if (e.code === 'TS2339' || e.code === 'TS2551') {
      const t = typeOf(e);
      if (t) freq[t] = (freq[t] || 0) + 1;
    }
  }
  const byType: Record<string, number> = {};
  const real: ScriptDiagnostic[] = [];
  for (const e of candidates) {
    if (e.code === 'TS2339' || e.code === 'TS2551') {
      const t = typeOf(e);
      if (t && (freq[t] || 0) > threshold) {
        noise.push(e);
        byCode[e.code] = (byCode[e.code] || 0) + 1;
        byType[t] = (byType[t] || 0) + 1;
        continue;
      }
    }
    real.push(e);
  }

  const syntacticCount = real.filter((e) => e.category === 'syntactic').length;
  return {
    real,
    noise,
    noiseSummary: { total: noise.length, byCode, byNamespace, byType },
    syntacticCount,
    semanticCount: real.length - syntacticCount,
  };
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

// ==================== 场景管理 ====================

/** 场景列表项 */
export interface SceneInfo {
  name: string;
  path: string;
  uuid: string;
}

/**
 * 调 cocos-mcp scene_management get_list，返回场景列表
 */
export async function sceneManagementGetList(mcpPort: number): Promise<SceneInfo[]> {
  const resp = await httpPostJson(
    `http://127.0.0.1:${mcpPort}/api/scene/scene_management`,
    { action: 'get_list' },
    10000
  );
  const result = (resp?.result ?? {}) as Record<string, unknown>;
  const data = result.data;
  return Array.isArray(data) ? (data as SceneInfo[]) : [];
}

/** scene_management open 的结果 */
export type SceneOpenResult = 'success' | 'timeout' | 'failed';

/**
 * 调 cocos-mcp scene_management open，切换到指定场景
 *
 * 切场景可能很慢（大场景 / 编辑器卡顿），HTTP 会长时间不响应，导致 CLI 卡死在
 * 「切换场景...」这一步。用 Promise.race 强制 timeoutMs 超时兜底（与 httpPostJson
 * 内部 req.timeout 双保险），超时返回 'timeout'，让上层明确提示并中断，而非模糊地
 * 「场景切换失败」让用户傻等。
 *
 * 注：httpPostJson 超时 / 网络异常 / JSON 解析失败都返回 null；前置 verifyMcpConnection
 * 已确认 HTTP 可达，切场景期间 null 基本即「编辑器无响应」，统一归为超时。
 *
 * @returns 'success' 切换成功 / 'timeout' 超时或无响应 / 'failed' 编辑器明确返回失败
 */
export async function sceneManagementOpen(
  mcpPort: number,
  scenePath: string,
  timeoutMs = 10000
): Promise<SceneOpenResult> {
  const resp = await Promise.race([
    httpPostJson(
      `http://127.0.0.1:${mcpPort}/api/scene/scene_management`,
      { action: 'open', scenePath },
      timeoutMs
    ),
    // 超时兜底：到点强制返回 null（httpPostJson 内部 req.timeout 也会触发，此处双保险）
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (resp === null) return 'timeout';
  return resp?.success === true ? 'success' : 'failed';
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
