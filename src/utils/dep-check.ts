import { execFileSync } from 'child_process';
import chalk from 'chalk';

// 依赖检查工具：判断命令是否在 PATH 可用
//
// 供 cocoscli doctor 与 browserlogs/previewscene 调用 cdp-cli 前置检查使用
//
// hasCommand(command)   判断命令是否在 PATH（where.exe / which）
// cdpCliReady()         cdp-cli 是否可用（不退出，doctor 探测用）
// ensureCdpCli()        cdp-cli 不可用时报错 + 提示 npm run setup 并退出
//                        （避免调用方拿到难分析的 spawn ENOENT）

/**
 * 判断命令是否在 PATH 中可用
 *
 * Windows 用 where.exe，类 Unix 用 which。
 * where 会按 PATHEXT 查找（含 .cmd/.bat），npm link 创建的全局命令可被找到。
 *
 * @param command 命令名（如 'cdp-cli'、'git'、'npm'）
 * @returns true 可用 / false 不可用
 */
export function hasCommand(command: string): boolean {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    execFileSync(finder, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * cdp-cli 是否可用（不退出）
 *
 * 供 doctor 体检探测，不触发退出。
 */
export function cdpCliReady(): boolean {
  return hasCommand('cdp-cli');
}

/**
 * cdp-cli 缺失时的统一修复提示
 */
export function cdpCliMissingHint(): string {
  return ['cdp-cli 未安装或未 link。', '', '请执行：', '    npm run setup'].join('\n');
}

/**
 * 前置检查：确保 cdp-cli 可用，不可用则报错并退出
 *
 * 供 browserlogs 等直接 spawn cdp-cli 的命令在调用前检查，
 * 避免得到难分析的 `spawn cdp-cli ENOENT`。
 */
export function ensureCdpCli(): void {
  if (cdpCliReady()) {
    console.log(chalk.gray('[检查3] cdp-cli 可用'));
    return;
  }
  console.log(chalk.red('[检查3] cdp-cli 不可用（不在 PATH）'));
  console.log(chalk.gray(cdpCliMissingHint()));
  process.exit(1);
}
