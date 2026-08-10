import chalk from 'chalk';
import { hasCommand, cdpCliReady } from '../utils/dep-check.js';
import { resolveCdpCliEntry } from '../utils/cdp-cli.js';

// doctor 命令：cocoscli 运行所需关键依赖体检
//
// 检查项：
//   必需：git / node / npm / cdp-cli runtime（入口文件存在，browserlogs/previewscene 调用用）
//   可选：cdp-cli global（全局 cdp-cli 命令，npm link cocoscli 后由 bin wrapper 提供）
// 必需项失败时提示 npm run setup 并退出；可选项失败只提示不退出

interface CheckItem {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

/**
 * doctor 命令：环境依赖体检
 */
export async function doctor(): Promise<void> {
  console.log(chalk.cyan('cocoscli 依赖体检'));

  const gitOk = hasCommand('git');
  const npmOk = hasCommand('npm');
  const cdpRuntimeOk = cdpCliReady();
  const cdpGlobalOk = hasCommand('cdp-cli');
  const cdpEntry = resolveCdpCliEntry();

  const items: CheckItem[] = [
    { name: 'git', ok: gitOk, required: true, detail: gitOk ? 'git 可用' : 'git 不在 PATH' },
    { name: 'node', ok: true, required: true, detail: process.version },
    { name: 'npm', ok: npmOk, required: true, detail: npmOk ? 'npm 可用' : 'npm 不在 PATH' },
    {
      name: 'cdp-cli runtime',
      ok: cdpRuntimeOk,
      required: true,
      detail: cdpRuntimeOk ? cdpEntry : '入口不存在（npm run setup 构建）',
    },
    {
      name: 'cdp-cli global',
      ok: cdpGlobalOk,
      required: false,
      detail: cdpGlobalOk ? 'cdp-cli 命令可用' : '全局不可用（可选，npm link cocoscli 后由 wrapper 提供）',
    },
  ];

  items.forEach((it) => {
    const tag = it.ok ? chalk.green('[完成]') : it.required ? chalk.red('[失败]') : chalk.yellow('[可选]');
    console.log(`${tag} ${it.name.padEnd(20)} ${chalk.gray(it.detail)}`);
  });

  const requiredItems = items.filter((it) => it.required);
  const failedRequired = requiredItems.filter((it) => !it.ok);
  console.log('');
  if (failedRequired.length === 0) {
    console.log(chalk.green(`[完成] 必需依赖就绪（${requiredItems.filter((i) => i.ok).length}/${requiredItems.length}）`));
  } else {
    console.log(chalk.red(`[失败] ${failedRequired.length} 项必需依赖缺失`));
    console.log(chalk.gray('  缺失依赖请跑：npm run setup'));
    process.exit(1);
  }
}
