import * as path from 'path';
import chalk from 'chalk';
import { findCocosProcesses, isProjectMatch, killProcess } from '../utils/process.js';

/**
 * close 命令：关闭工程对应的 CocosCreator 进程
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export function close(projectDir?: string): void {
  const target = path.resolve(projectDir ?? process.cwd());

  const procs = findCocosProcesses();
  const hits = procs.filter((p) => isProjectMatch(p.command, target));

  if (hits.length === 0) {
    console.log(chalk.yellow(`未找到对应工程的 CocosCreator 进程：${target}`));
    return;
  }

  for (const p of hits) {
    console.log(chalk.gray(`关闭进程 PID ${p.pid}`));
    try {
      killProcess(p.pid);
    } catch (e) {
      console.log(chalk.red(`关闭 PID ${p.pid} 失败：${e instanceof Error ? e.message : e}`));
    }
  }
  console.log(chalk.green(`已处理 ${hits.length} 个进程`));
}
