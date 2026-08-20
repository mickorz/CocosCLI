import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import { isCocosProject } from '../utils/project.js';
import { findCocosProcesses, isProjectMatch } from '../utils/process.js';
import { checkCocosMcpDeps } from '../utils/git.js';
import {
  readMcpPort,
  waitForMcpReady,
  describeMcpPhase,
  warnProxyIfLoopbackBlocked,
  type McpReadyPhase,
} from '../utils/verify.js';

/** 等待工程就绪的总超时（毫秒）：大工程首次打开含资源导入，300 秒兜底 */
export const MCP_READY_TIMEOUT_MS = 300_000;

/**
 * 拉起（或复用已在跑的）CocosCreator 并等待工程真正就绪
 *
 * 就绪链：扩展加载 → MCP server 启动 → 工具注册 → scene:ready → /health ready:true。
 * 旧版 CocosMCP（/health 无 ready 字段）降级为「HTTP 可达即就绪」并黄字提示升级。
 * 超时 exit(1) 并按卡住的阶段给出根因提示。
 *
 * @param dir 工程根目录（已通过 isCocosProject 校验）
 * @param creatorPath CocosCreator 可执行文件路径
 * @param noLogin 免登录启动
 * @param port CocosMCP HTTP 端口
 */
export async function openAndWaitReady(
  dir: string,
  creatorPath: string,
  noLogin: boolean,
  port: number
): Promise<void> {
  const procs = findCocosProcesses();
  const alreadyRunning = procs.some((p) => isProjectMatch(p.command, dir));
  if (alreadyRunning) {
    console.log(chalk.yellow(`工程已在 CocosCreator 中打开，等待其就绪：${dir}`));
  } else {
    openCocosProject(creatorPath, dir, noLogin);
    console.log(chalk.green(`已拉起 CocosCreator 进程${noLogin ? '（免登录）' : ''}：${dir}`));
  }

  console.log(chalk.gray(`等待工程就绪（轮询 http://127.0.0.1:${port}/health，最多 ${Math.round(MCP_READY_TIMEOUT_MS / 1000)} 秒）...`));
  const result = await waitForMcpReady(port, {
    timeoutMs: MCP_READY_TIMEOUT_MS,
    onProgress: (phase) => printPhaseProgress(phase, port),
  });

  if (result.ok) {
    const seconds = Math.round(result.elapsedMs / 1000);
    const toolsInfo = result.health?.tools !== undefined ? `，工具 ${result.health.tools} 个` : '';
    const versionInfo = result.health?.version ? `，CocosMCP ${result.health.version}` : '';
    console.log(chalk.green(`[完成] 工程已就绪：${dir}（MCP 端口 ${port}${toolsInfo}${versionInfo}，耗时 ${seconds} 秒）`));
    if (result.legacy) {
      console.log(chalk.yellow('[提示] 检测到旧版 CocosMCP（/health 无 ready 字段），已降级为「HTTP 可达即就绪」，无法确认场景是否加载完成。'));
      console.log(chalk.yellow('  建议：cocoscli remove 后重跑 cocoscli init 升级 CocosMCP（保留端口用 cocoscli list 查原端口后 -p 指定）。'));
    }
    return;
  }

  // 超时失败：打印卡住的阶段 + 根因提示
  console.log(chalk.red(`[失败] 等待工程就绪超时（${Math.round(MCP_READY_TIMEOUT_MS / 1000)} 秒），卡在阶段：${describeMcpPhase(result.phase)}`));
  printTimeoutHints(dir, result.phase);
  warnProxyIfLoopbackBlocked();
  process.exit(1);
}

/** 阶段变化时的进度输出（waitForMcpReady 只在阶段切换时回调，不刷屏） */
function printPhaseProgress(phase: McpReadyPhase, port: number): void {
  switch (phase) {
    case 'connecting':
      // 首个 tick 必然先到这里，上面已打印「等待工程就绪」标题行，此处不重复
      break;
    case 'extensionLoading':
    case 'serverStarting':
      console.log(chalk.gray(`  CocosMCP 扩展已加载，等待 server 启动（端口 ${port}）...`));
      break;
    case 'toolsRegistering':
      console.log(chalk.gray('  MCP server 已启动，等待工具注册...'));
      break;
    case 'sceneLoading':
      console.log(chalk.gray('  工具已注册，等待场景就绪（scene:ready）...'));
      break;
    case 'ready':
      break;
  }
}

/** 超时根因提示：按卡住的阶段给针对性建议 */
function printTimeoutHints(dir: string, phase: McpReadyPhase): void {
  const extDir = path.join(dir, 'extensions', 'CocosMCP');
  if (phase === 'connecting') {
    if (!fs.existsSync(extDir)) {
      console.log(chalk.yellow(`  [提示] ${extDir} 不存在，先跑 cocoscli init 安装 CocosMCP。`));
      return;
    }
    const deps = checkCocosMcpDeps(extDir);
    if (!deps.ok) {
      console.log(chalk.yellow(`  [提示] CocosMCP node_modules 缺失（${deps.missing.join(', ')}），在 ${extDir} 跑 npm install，或重跑 cocoscli init。`));
      return;
    }
    console.log(chalk.yellow('  [提示] CocosMCP 已装但 HTTP server 未起来：检查编辑器控制台是否报 EADDRINUSE（端口被其他工程占用，cocoscli list 查看已注册端口）。'));
    console.log(chalk.yellow('  也可能是编辑器仍在首次导入大工程，稍后重跑 cocoscli open 续等。'));
    return;
  }
  if (phase === 'sceneLoading') {
    console.log(chalk.yellow('  [提示] 编辑器可能仍在导入资源，或工程未自动恢复任何场景。'));
    console.log(chalk.yellow('  在编辑器手动打开任一场景（会触发 scene:ready）后重跑 cocoscli open（已开状态会继续等待就绪）。'));
    return;
  }
  console.log(chalk.yellow('  [提示] 编辑器可能仍在首次导入大工程，稍后重跑 cocoscli open 续等。'));
}

/**
 * open 命令：用 CocosCreator 打开工程并等待真正就绪
 *
 * 就绪 = CocosMCP server 启动 + 工具注册 + 场景就绪（/health ready:true），
 * 返回（exit 0）即工程可被后续 CLI / MCP 操作。
 * 未装 CocosMCP 的工程保持旧行为（spawn 后立即返回，无法等待）。
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export async function open(projectDir?: string, noLogin = true): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 未装 CocosMCP 的普通工程：无 /health 可等，保持旧行为（不能挂 300 秒）
  const extDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(extDir)) {
    const procs = findCocosProcesses();
    const alreadyRunning = procs.some((p) => isProjectMatch(p.command, dir));
    if (alreadyRunning) {
      console.log(chalk.yellow(`工程已在 CocosCreator 中打开，跳过重复启动：${dir}`));
      return;
    }
    let creatorPath: string;
    try {
      creatorPath = getCocosCreatorPath();
    } catch (e) {
      console.log(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
    openCocosProject(creatorPath, dir, noLogin);
    console.log(chalk.green(`已用 CocosCreator 打开工程：${dir}${noLogin ? '（免登录）' : ''}`));
    console.log(chalk.yellow('[提示] 未安装 CocosMCP 扩展，无法等待工程就绪（cocoscli init 可安装）。'));
    return;
  }

  let creatorPath: string;
  try {
    creatorPath = getCocosCreatorPath();
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  const port = readMcpPort(dir);
  await openAndWaitReady(dir, creatorPath, noLogin, port);
}
