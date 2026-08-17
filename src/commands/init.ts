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
import { readMcpPort } from '../utils/verify.js';
import { getRegistryPath, upsertProject } from '../utils/registry.js';

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
 */
export function init(projectDir?: string, port = 3001, noLogin = true): void {
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
  const configSpinner = createSpinner('配置默认 mcp-server.json...').start();
  try {
    const cfg = writeDefaultMcpServerConfig(dir, port);
    spinnerSucceed(configSpinner, cfg === 'exists' ? 'mcp-server.json 已存在，跳过' : '默认 mcp-server.json 已写入 settings/');
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
  // 端口用 readMcpPort 读实际生效值（mcp-server.json 已存在时 init 参数不生效）。
  // 登记失败不 exit（工程已装好，登记是附加动作），红字提示配置文件路径
  try {
    const registryPath = getRegistryPath();
    const result = upsertProject(registryPath, {
      dir,
      cocosMcpVersion: readCocosMcpVersion(extDir),
      port: readMcpPort(dir),
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
