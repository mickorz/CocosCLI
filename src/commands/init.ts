import chalk from 'chalk';
import { createSpinner, spinnerSucceed, spinnerFail } from '../utils/spinner.js';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import { isCocosProject } from '../utils/project.js';
import { cloneCocosMcp, buildCocosMcp, writeDefaultMcpServerConfig, writeOpencodePermission } from '../utils/git.js';

/**
 * init 命令：为当前 Cocos 工程安装 CocosMCP 扩展并打开
 *
 * 七步流程：
 *   1. 定位 CocosCreator（5 级查找，找不到则报错退出）
 *   2. 判定当前目录是否 Cocos 3.x 工程（不是则中止）
 *   3. 克隆 CocosMCP 到 extensions/CocosMCP（优先 deps submodule，fallback 远端）
 *   4. 构建 CocosMCP（npm install + build，生成 dist，否则 CocosCreator 加载报错）
 *   5. 写入默认 mcp-server.json 到 settings/（已存在则跳过）
 *   6. 写入默认 opencode.json 到工程根（放开 external_directory 权限，供 verify 使用）
 *   7. 打开工程（复用 open 的核心函数）
 */
export function init(port = 3001, noLogin = true): void {
  const cwd = process.cwd();

  // 第一步：定位 CocosCreator
  let creatorPath: string;
  try {
    creatorPath = getCocosCreatorPath();
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第二步：判定 Cocos 工程
  if (!isCocosProject(cwd)) {
    console.log(chalk.red(`当前目录不是 Cocos 3.x 工程：${cwd}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 第三步：克隆 CocosMCP 到 extensions（普通 git clone）
  const spinner = createSpinner('克隆 CocosMCP 扩展...').start();
  try {
    const result = cloneCocosMcp(cwd);
    const msg = result.status === 'cloned' ? 'CocosMCP 克隆完成（来自 deps/CocosMCP submodule）' : 'CocosMCP 已存在（如需更新跑 cocoscli remove + init）';
    spinnerSucceed(spinner, msg);
  } catch (e) {
    spinnerFail(spinner, '克隆 CocosMCP 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    console.log(chalk.gray('  优先从 deps/CocosMCP 克隆（submodule），不存在时 fallback 远端。submodule 未初始化请跑：git submodule update --init --recursive'));
    process.exit(1);
  }

  // 第四步：构建 CocosMCP（npm install + build，生成 dist）
  console.log(chalk.cyan('构建 CocosMCP 扩展（npm install + build，可能需要 1-2 分钟）...'));
  try {
    buildCocosMcp(cwd);
    console.log(chalk.green('[完成] CocosMCP 构建成功'));
  } catch (e) {
    console.log(chalk.red('[失败] CocosMCP 构建失败'));
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第五步：写入默认 mcp-server.json（CocosMCP 服务器配置，已存在则跳过）
  const configSpinner = createSpinner('配置默认 mcp-server.json...').start();
  try {
    const cfg = writeDefaultMcpServerConfig(cwd, port);
    spinnerSucceed(configSpinner, cfg === 'exists' ? 'mcp-server.json 已存在，跳过' : '默认 mcp-server.json 已写入 settings/');
  } catch (e) {
    spinnerFail(configSpinner, '写入 mcp-server.json 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第六步：写入默认 opencode.json（放开 external_directory 权限，供 verify 使用）
  const permSpinner = createSpinner('配置默认 opencode.json...').start();
  try {
    const perm = writeOpencodePermission(cwd);
    spinnerSucceed(permSpinner, perm === 'exists' ? 'opencode.json 已存在，跳过' : '默认 opencode.json 已写入（放开 external_directory 权限）');
  } catch (e) {
    spinnerFail(permSpinner, '写入 opencode.json 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  // 第七步：打开工程
  openCocosProject(creatorPath, cwd, noLogin);
  console.log(chalk.green(`已用 CocosCreator 打开工程：${cwd}${noLogin ? '（免登录）' : ''}`));
  console.log(chalk.gray('提示：extensions/CocosMCP 未纳入父仓库管理，如需忽略请在 .gitignore 添加'));
}
