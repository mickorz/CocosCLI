import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { writeCompileLog } from '../utils/compile-log.js';
import { createSpinner, spinnerSucceed } from '../utils/spinner.js';
import {
  checkLintEnvironment,
  createEmptyLintResult,
  lintProject,
  readParserProject,
  LintEnvironmentError,
  LintResult,
} from '../utils/lint.js';

// lint 命令：忠实使用工程自己的 ESLint 环境做代码规范检查，生成 eslint-log
//
// lint 命令执行流程
//
// lint(dir)
//   ├─> isCocosProject 失败 → 红字 + exit(1)（唯一不落日志的分支）
//   ├─> createEmptyLintResult + readParserProject
//   ├─> checkLintEnvironment 前置检查
//   │     └─> 有环境错误 → 落日志 → 红字逐条 → exit(1)（环境错误也进日志）
//   ├─> lintProject（工程本地 ESLint，不经 CocosMCP，无需开编辑器）
//   ├─> 落日志 .cocoscli/eslint-log-{timestamp}.json
//   └─> 终端摘要（环境错误优先 + 计数 + top rules，不打印全部错误）
//         └─> ok ? 自然返回 : exit(1)
//
// 核心原则：只要已确认是 Cocos 工程，就尽最大可能产生一份 eslint-log，
// 环境问题绝不裸 exit（自动化 Agent 统一读日志，不解析 CLI stderr）。

/**
 * 打印环境错误块（红字逐条 + 灰字说明，与 compile 的环境错误块风格一致）
 *
 * 原始 message 可能是多行（如 parser project 错误带 typescript-eslint 排障指引），
 * 终端只取第一行保可读，完整原文在 log JSON 的 environmentErrors 里
 */
function printEnvironmentErrors(errors: LintEnvironmentError[]): void {
  console.log(chalk.red(`[Environment Error] lint 环境问题 ${errors.length} 个（修环境，不计入代码统计）：`));
  errors.forEach((e) => {
    const plugin = e.plugin ? ` (plugin: ${e.plugin})` : '';
    const filePath = e.path ? ` (path: ${e.path})` : '';
    const firstLine = e.message.split('\n')[0];
    console.log(chalk.red(`  ${e.code}${plugin}${filePath}: ${firstLine}`));
  });
  console.log(chalk.gray('  （完整 message 详见 log JSON 的 environmentErrors 字段）'));
}

/**
 * 打印 lint 摘要（终端只给摘要 + top rules，完整结果看 log JSON）
 */
function printSummary(result: LintResult): void {
  if (result.environmentErrors.length > 0) {
    printEnvironmentErrors(result.environmentErrors);
  }
  if (result.errorCount === 0 && result.warningCount === 0 && result.environmentErrors.length === 0) {
    console.log(chalk.green('无 lint 问题'));
  } else {
    console.log(
      chalk.red(
        `发现 ${result.errorCount} 个 error / ${result.warningCount} 个 warning` +
          `（可修复 error ${result.fixableErrorCount} / warning ${result.fixableWarningCount}）：`
      )
    );
    // top rules：按规则计数排序取前 10（不打印几百条错误，完整列表见 log）
    const ruleEntries = Object.entries(result.ruleSummary.byRule).sort((a, b) => b[1] - a[1]);
    if (ruleEntries.length > 0) {
      console.log(chalk.gray('  Top rules:'));
      ruleEntries.slice(0, 10).forEach(([rule, n]) => {
        console.log(chalk.gray(`    ${String(n).padStart(5)}  ${rule}`));
      });
    }
  }
}

/**
 * lint 命令：ESLint 代码规范检查 + 生成 log
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export async function lint(projectDir?: string): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  // 唯一不落日志的分支：连 Cocos 工程都不是（无 project 上下文）
  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  console.log(chalk.cyan('ESLint 代码规范检查（cocoscli lint）'));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray('配置：.eslintrc.json + tsconfig.eslint.json（忠实工程 ESLint 环境，不自拼规则）'));
  console.log(chalk.gray('执行：工程本地 ESLint（不经 CocosMCP，无需打开 CocosCreator）\n'));

  // ===== 前置环境检查（有错误也落日志，不裸 exit）=====
  const result = createEmptyLintResult(dir);
  result.parserProject = readParserProjectSafe(dir);
  const preflightErrors = checkLintEnvironment(dir);
  if (preflightErrors.length > 0) {
    result.environmentErrors.push(...preflightErrors);
    result.ok = false;
    const logPath = writeCompileLog(dir, 'eslint-log-', result, 'lint');
    printEnvironmentErrors(result.environmentErrors);
    console.log(chalk.gray('  请补齐环境后重跑（.eslintrc.json / tsconfig.eslint.json / 工程本地 npm install eslint）'));
    console.log(chalk.green(`\nLint 报告已写入：${logPath}`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] .eslintrc.json 存在且可解析'));
  console.log(chalk.gray('[检查2] tsconfig.eslint.json 存在'));
  console.log(chalk.gray('[检查3] 工程本地 ESLint 可解析\n'));

  // ===== 执行 lint（长耗时，spinner 提示）=====
  const spinner = createSpinner('lint 中（工程本地 ESLint，文件多时较慢请稍候）...').start();
  const linted = await lintProject(dir);
  spinnerSucceed(spinner, `lint 完成（检查 ${linted.fileCount} 个文件）`);

  // ===== 落日志 + 终端摘要 =====
  const logPath = writeCompileLog(dir, 'eslint-log-', linted, 'lint');
  if (linted.parserProject) {
    console.log(chalk.gray(`ESLint TypeScript Project（parserOptions.project）：${linted.parserProject}`));
  }
  printSummary(linted);
  if (linted.ok) {
    console.log(chalk.green('Lint 通过'));
  } else {
    console.log(chalk.red('Lint 失败'));
  }
  console.log(chalk.green(`\nLint 报告已写入：${logPath}`));
  if (!linted.ok) {
    process.exit(1);
  }
}

/**
 * 安全读 parserProject：.eslintrc.json 解析失败时返回 null 不炸
 * （解析失败本身已在 checkLintEnvironment 里作为环境错误报告，这里只取值，不重复报）
 */
function readParserProjectSafe(dir: string): string | null {
  try {
    return readParserProject(dir);
  } catch {
    return null;
  }
}
