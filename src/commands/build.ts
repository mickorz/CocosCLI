import * as path from 'path';
import chalk from 'chalk';
import { buildProject, BuildResult } from '../utils/build.js';
import { isCocosProject } from '../utils/project.js';

/**
 * build 命令：构建工程到指定平台
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param platform 打包平台（web-desktop/web-mobile/wechat/douyin 等，支持简称）
 */
export function build(projectDir: string | undefined, platform: string): void {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  console.log(chalk.cyan(`开始构建 ${dir}（平台 ${platform}）\n`));

  let result: BuildResult;
  try {
    result = buildProject(dir, platform);
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  if (result.success) {
    console.log(chalk.green(`\n构建完成，产物目录：${result.outputDir}`));
  } else {
    console.log(chalk.red(`\n${result.message}`));
    process.exit(1);
  }
}
