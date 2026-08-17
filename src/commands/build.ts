import * as path from 'path';
import chalk from 'chalk';
import {
  buildProject,
  BuildResult,
  BuildErrorItem,
  BUILD_ERROR_CATEGORIES,
  BuildErrorCategory,
} from '../utils/build.js';
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
 * 解析 --ignore-category 参数（逗号分隔），非法分类直接报错退出（不静默忽略输入错误）
 */
function parseIgnoreCategories(input: string | undefined): Set<BuildErrorCategory> {
  if (!input) return new Set();
  // 兼容逗号/空格混合分隔（PowerShell 未加引号时逗号会被拆成空格分隔的多个参数）
  const cats = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bad = cats.filter((c) => !BUILD_ERROR_CATEGORIES.includes(c as BuildErrorCategory));
  if (bad.length > 0) {
    console.log(chalk.red(`--ignore-category 含非法分类：${bad.join(', ')}`));
    console.log(chalk.gray(`合法分类：${BUILD_ERROR_CATEGORIES.join(', ')}`));
    process.exit(1);
  }
  return new Set(cats as BuildErrorCategory[]);
}

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
 * @param fast 快速模式：只检查脚本编译，脚本阶段结束后提前终止，不产出构建产物
 * @param ignoreCategories 显式忽略的报错分类（逗号分隔，如 "runtime,editor"），只影响摘要与退出码
 */
export async function build(
  projectDir: string | undefined,
  platform: string,
  fast = false,
  ignoreCategories?: string
): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 显式筛选：--ignore-category runtime,editor 只影响终端摘要与退出码，log JSON 仍全量保留
  const ignore = parseIgnoreCategories(ignoreCategories);

  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const modeText = fast
    ? 'fast 模式：只检查脚本编译（语法/模块/运行时），脚本阶段结束后提前终止，不产出构建产物'
    : '输出将保存到 .cocoscli/ 目录';
  console.log(chalk.cyan(`开始构建 ${dir}（平台 ${platform}），${modeText}\n`));

  let result: BuildResult;
  try {
    result = await buildProject(dir, platform, { fast, ignoreCategories: [...ignore] });
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  console.log(chalk.gray(`\n耗时：${sec(result.durationMs)} 秒（CocosCreator 退出码 ${result.exitCode ?? '被提前终止'}）`));

  // result.errors 已在 utils 层按 --ignore-category 过滤（log JSON 的 errors 数组同样过滤），
  // 这里直接展示；被过滤行数单独一行留痕
  if (result.errors.length > 0) {
    printErrorSummary(result.errors, result.errorLineCount);
  }
  if (ignore.size > 0 && result.ignoredErrorCount > 0) {
    console.log(chalk.gray(`[已过滤] ${[...ignore].join(',')} 类报错 ${result.ignoredErrorCount} 行（--ignore-category 指定，errors 数组已不含这些分类，原始全文见 build-raw log）`));
  }

  if (result.success) {
    console.log(chalk.green(`\n${result.message}${result.outputDir ? `\n产物目录：${result.outputDir}` : ''}`));
  } else {
    console.log(chalk.red(`\n${result.message}`));
  }
  if (result.logPath) {
    console.log(chalk.green(`构建报告已写入：${result.logPath}`));
    console.log(chalk.gray(`原始日志：${result.rawLogPath}`));
  }
  // fast 模式的语义是"检查命令"：发现报错即非零退出（对齐 lint/compile 的退出码语义）；
  // --ignore-category 的分类已在 utils 层从 result.errors 剔除，天然不参与退出码判定；
  // 普通构建语义是"出产物"：日志有报错但产物成功仍算完成，退出码 0
  if (!result.success || (fast && result.errorLineCount > 0)) {
    process.exit(1);
  }
}
