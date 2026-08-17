import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { createSpinner, spinnerSucceed, spinnerFail } from '../utils/spinner.js';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import { isCocosProject } from '../utils/project.js';
import {
  cloneCocosMcp,
  buildCocosMcp,
  checkCocosMcpDeps,
  readCocosMcpVersion,
  COCOS_MCP_DIR,
  writeDefaultMcpServerConfig,
  writeOpencodePermission,
} from '../utils/git.js';
import { getRegistryPath, upsertProject, findPortOccupant, findAvailablePort } from '../utils/registry.js';

/**
 * 读工程已有 settings/mcp-server.json 的端口
 *
 * 与 readMcpPort 的区别：这里要区分「文件不存在/没有端口」（返回 null，
 * 触发端口决策）与「有端口」（以文件为准），readMcpPort 会吞错并 fallback 3001。
 *
 * @returns 端口号；文件不存在或没有有效 port 字段返回 null
 */
function readExistingMcpPort(dir: string): number | null {
  const cfgPath = path.join(dir, 'settings', 'mcp-server.json');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as { port?: unknown };
    if (typeof cfg.port === 'number' && cfg.port > 0) {
      return cfg.port;
    }
  } catch {
    // 坏 JSON 交给 writeDefaultMcpServerConfig 的 exists 分支之外处理不了，
    // 这里当无端口走决策，写入时 exists 跳过不会碰它（用户手工修复）
  }
  return null;
}

/**
 * init 命令：为指定 Cocos 工程安装 CocosMCP 扩展并打开
 *
 * 八步流程：
 *   1. 定位 CocosCreator（5 级查找，找不到则报错退出）
 *   2. 判定目标目录是否 Cocos 3.x 工程（不是则中止）
 *   3. 安装 CocosMCP 到 extensions/CocosMCP（优先 vendor/deps copy，fallback 远端）
 *   4. 构建 CocosMCP（npm install + build，生成 dist；全新安装或依赖/dist 缺失才跑，按需构建）
 *   5. 写入默认 mcp-server.json 到 settings/（已存在则跳过）
 *   6. 写入默认 opencode.json 到工程根（放开 external_directory 权限，供 verify 使用）
 *   7. 打开工程（复用 open 的核心函数）
 *   8. 登记到全局工程列表（~/.cocoscli/projects.json，cocoscli list 读取）
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param port CocosMCP 端口；省略时自动错开（读全局注册表挑空闲口，首个工程 3001），
 *             显式指定撞已注册工程时直接中断并推荐空闲端口
 */
export function init(projectDir?: string, port?: number, noLogin = true): void {
  const dir = path.resolve(projectDir ?? process.cwd());

  // 第一步：定位 CocosCreator
  let creatorPath: string;
  try {
    creatorPath = getCocosCreatorPath();
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第二步：判定 Cocos 工程
  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 第三步：安装 CocosMCP 到 extensions（优先 vendor/deps copy，fallback git clone）
  const spinner = createSpinner('安装 CocosMCP 扩展...').start();
  let installStatus: 'cloned' | 'exists';
  try {
    const result = cloneCocosMcp(dir);
    installStatus = result.status;
    const msg = result.status === 'cloned' ? 'CocosMCP 安装完成（来自 vendor/deps copy）' : 'CocosMCP 已存在（如需更新跑 cocoscli remove + init）';
    spinnerSucceed(spinner, msg);
  } catch (e) {
    spinnerFail(spinner, '安装 CocosMCP 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    console.log(chalk.gray('  优先从 vendor/deps 复制（submodule），不存在时 fallback 远端 git clone。submodule 未初始化请跑：git submodule update --init --recursive'));
    process.exit(1);
  }

  // 第四步：构建 CocosMCP（npm install + build，生成 dist）——按需构建
  // 全新安装（cloned）、或已存在但 node_modules/dist 缺失（上次构建中断 / 手动复制漏装）才跑，
  // 避免「上次 init 构建失败 exit 后残留半成品，重跑走 exists 分支永远不补 install」的死角
  const extDir = path.join(dir, 'extensions', COCOS_MCP_DIR);
  const depsOk = checkCocosMcpDeps(extDir).ok;
  const distReady = fs.existsSync(path.join(extDir, 'dist', 'main.js'));
  if (installStatus === 'cloned' || !depsOk || !distReady) {
    if (installStatus === 'exists' && (!depsOk || !distReady)) {
      console.log(chalk.yellow('检测到 CocosMCP node_modules 或 dist 缺失（上次构建未完成或手动复制漏装），补跑构建...'));
    }
    console.log(chalk.cyan('构建 CocosMCP 扩展（npm install + build，可能需要 1-2 分钟）...'));
    try {
      buildCocosMcp(dir);
      console.log(chalk.green('[完成] CocosMCP 构建成功'));
    } catch (e) {
      console.log(chalk.red('[失败] CocosMCP 构建失败'));
      console.log(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  } else {
    console.log(chalk.gray('CocosMCP 已构建且依赖齐全，跳过 npm install + build（更新走 cocoscli remove + init）'));
  }

  // 第五步：写入默认 mcp-server.json（CocosMCP 服务器配置，已存在则跳过）
  // 端口优先级：mcp-server.json 已存在 > 显式 -p > 自动错开（全局注册表挑空闲口）
  //   - 已存在：以文件为准（重复 init 不覆盖，改端口走 cocoscli remove + init）
  //   - 显式 -p：撞已注册工程时直接中断（红字报端口冲突 + 推荐空闲端口）
  //   - 未传 -p：findAvailablePort 从 3001 起跳过全局注册表已占用端口，避免多工程撞车
  const registryPath = getRegistryPath();
  const existingPort = readExistingMcpPort(dir);
  let portToWrite: number;
  if (existingPort !== null) {
    portToWrite = existingPort;
    console.log(chalk.gray(`mcp-server.json 已有端口配置（${existingPort}），以文件为准`));
  } else if (port !== undefined) {
    const occupant = findPortOccupant(registryPath, port, dir);
    if (occupant) {
      const suggest = findAvailablePort(registryPath, dir);
      console.log(chalk.red(`端口冲突：${port} 已被工程 ${occupant.dir} 注册占用（cocoscli list 查看）`));
      console.log(chalk.gray('  两工程同开时后启动的 CocosMCP 会起不来，已中断 init。'));
      console.log(chalk.gray(`  推荐端口：${suggest}，重跑：cocoscli init ${dir} -p ${suggest}`));
      console.log(chalk.gray('  或不带 -p 重跑（自动分配空闲端口）'));
      process.exit(1);
    }
    portToWrite = port;
  } else {
    portToWrite = findAvailablePort(registryPath, dir);
    console.log(chalk.gray(`自动分配端口：${portToWrite}（已跳过全局注册表占用口，cocoscli list 查看）`));
  }
  const configSpinner = createSpinner('配置默认 mcp-server.json...').start();
  try {
    const cfg = writeDefaultMcpServerConfig(dir, portToWrite);
    spinnerSucceed(configSpinner, cfg === 'exists' ? 'mcp-server.json 已存在，跳过' : `默认 mcp-server.json 已写入 settings/（端口 ${portToWrite}）`);
  } catch (e) {
    spinnerFail(configSpinner, '写入 mcp-server.json 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第六步：写入默认 opencode.json（放开 external_directory 权限，供 verify 使用）
  const permSpinner = createSpinner('配置默认 opencode.json...').start();
  try {
    const perm = writeOpencodePermission(dir);
    spinnerSucceed(permSpinner, perm === 'exists' ? 'opencode.json 已存在，跳过' : '默认 opencode.json 已写入（放开 external_directory 权限）');
  } catch (e) {
    spinnerFail(permSpinner, '写入 opencode.json 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第七步：打开工程
  openCocosProject(creatorPath, dir, noLogin);
  console.log(chalk.green(`已用 CocosCreator 打开工程：${dir}${noLogin ? '（免登录）' : ''}`));
  console.log(chalk.gray('提示：extensions/CocosMCP 未纳入父仓库管理，如需忽略请在 .gitignore 添加'));

  // 第八步：登记到全局工程列表（cocoscli list 读取）
  // 放在最后：所有 exit(1) 失败点都已过去，失败不留半条记录。
  // 端口用实际写入/生效值（第五步决策结果），不重新读文件。
  // 登记失败不 exit（工程已装好，登记是附加动作），红字提示配置文件路径
  try {
    const result = upsertProject(registryPath, {
      dir,
      cocosMcpVersion: readCocosMcpVersion(extDir),
      port: portToWrite,
      initAt: new Date().toISOString(),
    });
    console.log(
      result === 'added'
        ? chalk.gray('已登记到全局工程列表（cocoscli list 查看）')
        : chalk.gray('全局工程列表记录已更新（cocoscli list 查看）')
    );
  } catch (e) {
    console.log(chalk.red('登记到全局工程列表失败'));
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
  }
}
