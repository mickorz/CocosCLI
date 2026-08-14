import * as path from 'path';
import chalk from 'chalk';
import { buildProject, BuildResult, BuildErrorItem } from '../utils/build.js';
import { isCocosProject } from '../utils/project.js';

// build 命令：构建工程到指定平台（输出 tee 终端 + 落盘 build-log）
//
// build(projectDir, platform)
//   ├─> isCocosProject 失败 → 红字 + exit(1)（唯一不落日志的分支）
//   ├─> buildProject（异步 spawn，输出实时 tee 终端）
//   │     ├─> 报错提取（syntax/module/runtime/editor 分类去重）
//   │     ├─> 落盘 .cocoscli/build-raw-<ts>.log（原始全文）
//   │     └─> 落盘 .cocoscli/build-log-<ts>.json（结构化）
//   └─> 终端摘要
//         ├─> 成功：产物目录 + 耗时（构建成功但日志有报错也如实列出，exit 0）
//         └─> 失败：红字原因 + exit(1)
//
// 注意：Cocos 构建不做类型检查，类型错误需另跑 cocoscli compile。

/**
 * 打印构建报错摘要（按重复次数降序取前 5 类，完整结果看 log JSON）
 */
function printErrorSummary(errors: BuildErrorItem[], errorLineCount: number): void {
  console.log(chalk.yellow(`[构建日志报错] 命中 ${errorLineCount} 行，去重 ${errors.length} 类（完整见 build-log JSON）：`));
  const sorted = [...errors].sort((a, b) => b.count - a.count);
  sorted.slice(0, 5).forEach((e) => {
    const msg = e.message.length > 120 ? e.message.slice(0, 120) + '...' : e.message;
    console.log(chalk.yellow(`  [${e.category}] x${e.count}  ${msg}`));
  });
  if (sorted.length > 5) {
    console.log(chalk.gray(`  ... 其余 ${sorted.length - 5} 类见 log JSON`));
  }
  console.log(chalk.gray('  （提示：类型错误不在构建日志里，请跑 cocoscli compile 检查类型）'));
}

/**
 * build 命令：构建工程到指定平台
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param platform 打包平台（web-desktop/web-mobile/wechat/douyin 等，支持简称）
 */
export async function build(projectDir: string | undefined, platform: string): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  const sec = (ms: number) => (ms / 1000).toFixed(1);
  console.log(chalk.cyan(`开始构建 ${dir}（平台 ${platform}），输出将保存到 .cocoscli/ 目录\n`));

  let result: BuildResult;
  try {
    result = await buildProject(dir, platform);
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  console.log(chalk.gray(`\n耗时：${sec(result.durationMs)} 秒（CocosCreator 退出码 ${result.exitCode}）`));
  if (result.errors.length > 0) {
    printErrorSummary(result.errors, result.errorLineCount);
  }

  if (result.success) {
    console.log(chalk.green(`\n构建完成，产物目录：${result.outputDir}`));
  } else {
    console.log(chalk.red(`\n${result.message}`));
  }
  if (result.logPath) {
    console.log(chalk.green(`构建报告已写入：${result.logPath}`));
    console.log(chalk.gray(`原始日志：${result.rawLogPath}`));
  }
  if (!result.success) {
    process.exit(1);
  }
}
