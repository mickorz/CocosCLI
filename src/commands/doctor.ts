import chalk from 'chalk';
import { hasCommand, cdpCliReady } from '../utils/dep-check.js';

// doctor 命令：cocoscli 运行所需关键依赖体检
//
// 检查项：git / node / npm / cdp-cli（submodule 依赖，browserlogs/previewscene 用）
// 输出每项 [完成] / [失败]，末尾汇总，失败时提示 npm run setup 并退出
//
// 目的：AI / opencode 调 cocoscli 时，环境缺依赖先明确报出来，
//       而不是在具体命令里拿到难分析的 ENOENT

/**
 * doctor 命令：环境依赖体检
 */
export async function doctor(): Promise<void> {
  console.log(chalk.cyan('cocoscli 依赖体检'));

  // 每项只探测一次，避免重复 where/which
  const gitOk = hasCommand('git');
  const npmOk = hasCommand('npm');
  const cdpOk = cdpCliReady();

  const items = [
    { name: 'git', ok: gitOk, detail: gitOk ? 'git 可用' : 'git 不在 PATH' },
    { name: 'node', ok: true, detail: process.version },
    { name: 'npm', ok: npmOk, detail: npmOk ? 'npm 可用' : 'npm 不在 PATH' },
    {
      name: 'cdp-cli',
      ok: cdpOk,
      detail: cdpOk ? 'cdp-cli 入口可用（deps/vendor build）' : 'cdp-cli 入口不存在（npm run setup 构建）',
    },
  ];

  items.forEach((it) => {
    const tag = it.ok ? chalk.green('[完成]') : chalk.red('[失败]');
    console.log(`${tag} ${it.name.padEnd(10)} ${chalk.gray(it.detail)}`);
  });

  const failed = items.filter((it) => !it.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(chalk.green(`[完成] 全部依赖就绪（${items.length}/${items.length}）`));
  } else {
    console.log(chalk.red(`[失败] ${failed.length} 项缺失（${items.length - failed.length}/${items.length} 就绪）`));
    console.log(chalk.gray('  缺失依赖请跑：npm run setup'));
    process.exit(1);
  }
}
