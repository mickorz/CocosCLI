import * as path from 'path';
import chalk from 'chalk';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import { isCocosProject } from '../utils/project.js';

/**
 * open 命令：用 CocosCreator 打开工程
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export function open(projectDir?: string, noLogin = true): void {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
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
}
