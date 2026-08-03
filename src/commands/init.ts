import chalk from 'chalk';
import ora from 'ora';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import { isCocosProject } from '../utils/project.js';
import { cloneCocosMcp, COCOS_MCP_URL } from '../utils/git.js';

/**
 * init 命令：为当前 Cocos 工程安装 CocosMCP 扩展并打开
 *
 * 四步流程：
 *   1. 定位 CocosCreator（5 级查找，找不到则报错退出）
 *   2. 判定当前目录是否 Cocos 3.x 工程（不是则中止）
 *   3. 克隆 CocosMCP 到 extensions/CocosMCP
 *   4. 打开工程（复用 open 的核心函数）
 */
export function init(): void {
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

  // 第三步：克隆 CocosMCP 到 extensions
  const spinner = ora('克隆 CocosMCP 扩展...').start();
  try {
    const result = cloneCocosMcp(cwd);
    spinner.succeed(result === 'exists' ? 'CocosMCP 已存在，跳过克隆' : 'CocosMCP 克隆完成');
  } catch (e) {
    spinner.fail('克隆 CocosMCP 失败');
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    console.log(chalk.gray(`请确认本地 Gitea 服务在运行：${COCOS_MCP_URL}`));
    process.exit(1);
  }

  // 第四步：打开工程
  openCocosProject(creatorPath, cwd);
  console.log(chalk.green(`已用 CocosCreator 打开工程：${cwd}`));
  console.log(chalk.gray('提示：extensions/CocosMCP 未纳入父仓库管理，如需忽略请在 .gitignore 添加'));
}
