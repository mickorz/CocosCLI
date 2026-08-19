import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { checkCocosMcpDeps } from '../utils/git.js';
import {
  buildEvalRequest,
  executeScriptViaMcp,
  readMcpPort,
  verifyMcpConnection,
  warnProxyIfLoopbackBlocked,
} from '../utils/verify.js';
import { writeCompileLog } from '../utils/compile-log.js';

// eval 命令：在编辑器内执行任意 JS（CocosMCP execute_script 工具，scene/editor 双上下文）
//
// evalScript(code, dir, options)
//        ├─> 读代码来源   readEvalSource（-f 文件优先，其次 code 参数）
//        ├─> 构建请求体   buildEvalRequest（context 归一化 + args JSON 校验）
//        ├─> 第一步 检查 CocosMCP 已装（extensions/CocosMCP）
//        ├─> 第二步 检查已 build（dist/tools/script-tools.js + node_modules）
//        ├─> 第三步 检查 MCP server 在跑（GET /health）
//        ├─> 第四步 真正执行（ran=false 即工具不可用，含"需重启编辑器"提示）
//        ├─> 打印结果     ok -> green + JSON；失败 -> red + exitCode 1
//        └─> 写 eval-log  .cocoscli/eval-log-<时间戳>.json（代码来源/args/耗时/结果）

/** eval 命令选项（commander 透传） */
export interface EvalOptions {
  context?: string;
  args?: string;
  file?: string;
  timeout?: number;
}

/**
 * 读 eval 代码来源（纯函数 + 一次文件读）
 *
 * -f 存在则从文件读（UTF-8），否则用命令行 code 参数；两者都空报错。
 * source 记录来源（'cli' 或 'file:<绝对路径>'）写入 eval-log 便于回溯。
 */
export function readEvalSource(
  codeArg: string | undefined,
  filePath: string | undefined
): { code: string; source: string } | { error: string } {
  if (filePath !== undefined && filePath !== '') {
    const abs = path.resolve(filePath);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch (e) {
      return { error: `读取代码文件失败：${abs}（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (!content.trim()) {
      return { error: `代码文件为空：${abs}` };
    }
    return { code: content, source: `file:${abs}` };
  }
  if (codeArg !== undefined && codeArg.trim() !== '') {
    return { code: codeArg, source: 'cli' };
  }
  return { error: '缺少代码：传 <code> 参数或 -f <文件路径>（长脚本推荐 -f 规避引号转义）' };
}

/**
 * eval 命令：在编辑器内执行任意 JS，写 eval-log
 *
 * scene 上下文注入 require/cc/Editor/scene/director/args（操作活场景树）；
 * editor 上下文注入 require/Editor/args/fs/path/os（Editor API 与文件操作）。
 * 用户代码三出口：直接 return / 定义 run(env) / module.exports 导出。
 *
 * @param codeArg 命令行代码串（与 -f 二选一，-f 优先）
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param options context/args/file/timeout
 */
export async function evalScript(codeArg: string | undefined, projectDir?: string, options?: EvalOptions): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 读代码来源（-f 文件优先）
  const sourceResult = readEvalSource(codeArg, options?.file);
  if ('error' in sourceResult) {
    console.log(chalk.red(sourceResult.error));
    process.exit(1);
  }
  const { code, source } = sourceResult;

  // 构建请求体（context 归一化 + args JSON 校验）
  const request = buildEvalRequest(options?.context, code, options?.args);
  if ('error' in request) {
    console.log(chalk.red(request.error));
    process.exit(1);
  }
  const timeoutMs = options?.timeout && options.timeout > 0 ? options.timeout : 120000;

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan('执行任意 JS（cocos-mcp execute_script）'));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}`));
  console.log(chalk.gray(`上下文：${request.context}（${request.context === 'scene' ? '注入 require/cc/Editor/scene/director/args' : '注入 require/Editor/args/fs/path/os'}）`));
  console.log(chalk.gray(`代码来源：${source}（${code.length} 字符）`));
  if (Object.keys(request.args).length > 0) {
    console.log(chalk.gray(`args：${JSON.stringify(request.args)}`));
  }
  console.log(chalk.gray(`超时：${timeoutMs}ms\n`));

  // ===== 前置检查（四条链路，任一失败中断 + 提示修复）=====

  // 第一步：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[第一步] CocosMCP 未安装'));
    console.log(chalk.gray(`  ${cocosMcpDir} 不存在，先跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[第一步] CocosMCP 已安装'));

  // 第二步：CocosMCP 已 build 且含 execute_script 工具（script-tools.js 是本功能的文件级指纹）
  const scriptToolsJs = path.join(cocosMcpDir, 'dist', 'tools', 'script-tools.js');
  if (!fs.existsSync(scriptToolsJs)) {
    console.log(chalk.red('[第二步] CocosMCP 版本过旧（无 execute_script 工具）'));
    console.log(chalk.gray('  升级：cocoscli remove [dir] 后重跑 cocoscli init [dir]（package.json 场景方法清单也变了，需整目录替换）。'));
    console.log(chalk.gray('  升级后需重启 CocosCreator 加载新 scene 方法（executeCode）。'));
    process.exit(1);
  }
  const deps = checkCocosMcpDeps(cocosMcpDir);
  if (!deps.ok) {
    console.log(chalk.red(`[第二步] CocosMCP node_modules 缺失（${deps.missing.join(', ')}）`));
    console.log(chalk.gray(`  在 ${cocosMcpDir} 跑 npm install，或重跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[第二步] CocosMCP 已 build 且含 execute_script（dist/tools/script-tools.js）'));

  // 第三步：CocosCreator 已开（MCP HTTP server 在跑）
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[第三步] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  CocosCreator 可能没开，或 CocosMCP 扩展没加载。先跑 cocoscli open。'));
    warnProxyIfLoopbackBlocked();
    process.exit(1);
  }
  console.log(chalk.gray(`[第三步] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 第四步：真正执行（即工具可用性检查；ran=false 表示工具没注册上或链路断）
  const startedAt = Date.now();
  const outcome = await executeScriptViaMcp(mcpPort, code, request.context, request.args, timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (!outcome.ran) {
    console.log(chalk.red('[第四步] execute_script 工具不可用'));
    console.log(chalk.gray(`  ${outcome.error ?? ''}`));
    console.log(chalk.gray('  若刚升级 CocosMCP：重启 CocosCreator 加载新 scene 方法（executeCode）后再试。'));
    writeEvalLog(dir, {
      project: dir, mcpPort, context: request.context, source, args: request.args,
      ok: false, durationMs, result: null, error: outcome.error ?? 'execute_script 工具不可用',
    });
    process.exit(1);
  }
  console.log(chalk.gray(`[第四步] 执行完成（耗时 ${durationMs}ms）\n`));

  // 结果打印 + 落盘
  if (outcome.ok) {
    if (outcome.message) {
      console.log(chalk.green(outcome.message));
    }
    console.log(chalk.green('执行成功，返回值：'));
    console.log(JSON.stringify(outcome.data ?? null, null, 2));
  } else {
    console.log(chalk.red(`执行失败：${outcome.error}`));
    process.exitCode = 1;
  }

  writeEvalLog(dir, {
    project: dir, mcpPort, context: request.context, source, args: request.args,
    ok: outcome.ok, durationMs,
    result: outcome.ok ? (outcome.data ?? null) : null,
    error: outcome.ok ? null : (outcome.error ?? null),
  });
}

/** 写 eval-log（复用 writeCompileLog 的 .cocoscli 目录与时间戳命名） */
function writeEvalLog(
  dir: string,
  detail: {
    project: string; mcpPort: number; context: string; source: string;
    args: Record<string, unknown>; ok: boolean; durationMs: number;
    result: unknown; error: string | null;
  }
): void {
  const logData = {
    command: 'cocoscli eval',
    project: detail.project,
    timestamp: new Date().toISOString(),
    mcpPort: detail.mcpPort,
    context: detail.context,
    source: detail.source,
    args: detail.args,
    ok: detail.ok,
    durationMs: detail.durationMs,
    result: detail.result,
    error: detail.error,
  };
  try {
    const logPath = writeCompileLog(dir, 'eval-log-', logData, 'eval');
    console.log(chalk.gray(`\neval-log 已写入：${logPath}`));
  } catch (e) {
    // log 落盘失败不吞：红字暴露路径与原因，但不影响已打印的执行结果
    console.log(chalk.red(`eval-log 写入失败：${e instanceof Error ? e.message : String(e)}`));
  }
}
