import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { readSnippet } from './compile-log.js';

// lint 核心模块：忠实使用工程自己的 ESLint 环境做代码规范检查
//
// lint 执行流程
//
// lintProject(dir)
//   ├─> createRequire(工程 package.json)          解析工程本地 eslint（不用 cocoscli 自带）
//   ├─> new ESLint({ cwd, useEslintrc: true })    忠实工程 .eslintrc.json（不自拼 rules）
//   ├─> lintFiles(['assets/**/*.{ts,tsx}'])       ignorePatterns/overrides 由 ESLint 自己应用
//   │     └─> 抛错 → classifyEnvironmentError → environmentErrors（不混代码统计）
//   └─> 遍历 results → normalizeMessage
//         ├─> fatal + isParserProjectError → ESLINT_PARSER_PROJECT_ERROR（environmentError）
//         ├─> fatal 其他 → category=parsing（源码语法错，进 errors/warnings）
//         └─> 普通规则 → category=eslint（severity 2=error / 1=warning）
//         聚合 ruleSummary / fileSummary → LintResult（ok = 环境错 0 且 error 0）
//
// 核心原则：环境错误（配置缺失 / eslint 缺失 / plugin 加载失败）与业务 lint 问题分离，
// 全部进 environmentErrors，绝不静默吞错，由命令层统一落日志。

// ==================== 数据结构 ====================

/** 单条 lint 问题（error 或 warning），与 compile-log 的 ScriptDiagnostic 同消费风格 */
export interface LintIssue {
  file: string;            // 相对工程根，POSIX 正斜杠（如 assets/10000/foo.ts）
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  code: string;            // 统一消费入口：ruleId 或 ESLINT_PARSING_ERROR / eslint
  ruleId: string | null;   // 原始 ESLint ruleId（parsing error 时为 null）
  message: string;
  category: 'eslint' | 'parsing';
  severity: 'error' | 'warning';
  fixable: boolean;
  snippet: string;         // 错误行附近代码（上下各 1 行）
}

/** 环境错误（修环境，不碰业务代码），不计入 errorCount/warningCount */
export interface LintEnvironmentError {
  code: string;
  message: string;
  path?: string;           // 相关文件相对路径
  plugin?: string;         // 加载失败的 plugin 名（plugin 错误时有）
}

/** 规则统计（AI 一眼看出最大问题） */
export interface LintRuleSummary {
  total: number;
  bySeverity: { error: number; warning: number };
  byRule: Record<string, number>;
}

/** eslint-log JSON 顶层结构（与 compile-log 同消费风格） */
export interface LintResult {
  command: string;
  project: string;
  timestamp: string;
  eslintConfigPath: string;
  tsconfigPath: string;
  parserProject: string | null;  // .eslintrc.json 里 parserOptions.project 的实际值
  ok: boolean;
  fileCount: number;             // 实际检查文件数（被 ignore 的不在内）
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  environmentErrors: LintEnvironmentError[];
  ruleSummary: LintRuleSummary;
  fileSummary: Record<string, { errorCount: number; warningCount: number }>;
  errors: LintIssue[];
  warnings: LintIssue[];
}

// ESLint Node API 最小结构声明（不依赖 eslint 包类型，与 ESLint 8 返回结构兼容）
// cocoscli 自身不装 eslint，运行时用工程 node_modules 里的版本
interface EslintMessage {
  ruleId: string | null;
  severity: number;  // 1=warning 2=error
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fatal?: boolean;
  fix?: unknown;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
}

interface EslintClass {
  // 忠实模式：useEslintrc 读工程 .eslintrc.json，不传 overrideConfig/rules；
  // errorOnUnmatchedPattern:false 让 assets 不存在时不炸（如实返回空结果）
  new (options: { cwd: string; useEslintrc?: boolean; errorOnUnmatchedPattern?: boolean }): {
    lintFiles(patterns: string[]): Promise<EslintFileResult[]>;
  };
}

// ==================== 环境错误码 ====================

/** 环境错误码常量（集中定义，命令层/测试引用同一份） */
export const LINT_ENV_ERRORS = {
  ESLINT_NOT_FOUND: 'ESLINT_NOT_FOUND',
  ESLINT_CONFIG_NOT_FOUND: 'ESLINT_CONFIG_NOT_FOUND',
  ESLINT_CONFIG_PARSE_ERROR: 'ESLINT_CONFIG_PARSE_ERROR',
  ESLINT_TSCONFIG_NOT_FOUND: 'ESLINT_TSCONFIG_NOT_FOUND',
  ESLINT_PLUGIN_LOAD_ERROR: 'ESLINT_PLUGIN_LOAD_ERROR',
  ESLINT_PARSER_LOAD_ERROR: 'ESLINT_PARSER_LOAD_ERROR',
  ESLINT_PARSER_PROJECT_ERROR: 'ESLINT_PARSER_PROJECT_ERROR',
  ESLINT_RUN_ERROR: 'ESLINT_RUN_ERROR',
} as const;

// ==================== 纯函数（零 mock 单测覆盖） ====================

/** parser project 错误匹配模式（多正则，不绑死单一英文串，兼容不同 @typescript-eslint 版本） */
const PARSER_PROJECT_ERROR_PATTERNS: RegExp[] = [
  /must be included in at least one of the projects provided/i,
  /TSConfig does not include this file/i,
  /does not match your project config/i,
  /parserOptions\.project/i,
  // tsconfig 读不到（parserOptions.project 相对路径解析失败）也是环境问题，不是源码语法错
  /Parsing error: Cannot read file/i,
];

/**
 * 判定 message 是否为「文件不在 parserOptions.project 的 tsconfig 里」类错误
 * （环境/配置问题，应归 environmentErrors 而不是业务代码错误）
 */
export function isParserProjectError(message: string): boolean {
  return PARSER_PROJECT_ERROR_PATTERNS.some((p) => p.test(message));
}

/** 提取错误的 message 字符串（Error 取 .message，其他转字符串） */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把 lintFiles 抛出的异常归类为环境错误（不吞错，未知异常走 ESLINT_RUN_ERROR 兜底）
 *
 * 匹配顺序：plugin 错误优先（plugin 错误的 message 里常同时含 Cannot find module）
 */
export function classifyEnvironmentError(err: unknown): LintEnvironmentError {
  const msg = errorMessage(err);
  const pluginMatch = msg.match(/Failed to load plugin '(.+?)'/);
  if (pluginMatch) {
    return {
      code: LINT_ENV_ERRORS.ESLINT_PLUGIN_LOAD_ERROR,
      plugin: pluginMatch[1],
      message: msg,
    };
  }
  // parser 模块解析失败（如 Cannot find module '@typescript-eslint/parser'）
  if (/Cannot find module/.test(msg) && /parser/i.test(msg)) {
    return { code: LINT_ENV_ERRORS.ESLINT_PARSER_LOAD_ERROR, message: msg };
  }
  return { code: LINT_ENV_ERRORS.ESLINT_RUN_ERROR, message: msg };
}

/**
 * 读工程 .eslintrc.json 的 parserOptions.project（ESLint 实际用的 TypeScript Project）
 *
 * 用于日志对照「cocoscli 预期 tsconfig.eslint.json vs ESLint 实际配置」，
 * 工程改成别的 project 时立刻可见。无该字段返回 null。
 * JSON 解析失败抛错（暴露配置格式问题，由 checkLintEnvironment 捕获转环境错误）
 */
export function readParserProject(dir: string): string | null {
  const configPath = path.join(dir, '.eslintrc.json');
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    parserOptions?: { project?: string };
  };
  return parsed.parserOptions?.project ?? null;
}

/**
 * lint 前置环境检查：返回环境错误数组（不直接 exit，由命令层统一落日志）
 *
 * 检查项：
 *   1. .eslintrc.json 存在且 JSON 可解析
 *   2. tsconfig.eslint.json 存在
 *   3. 工程本地 eslint 可解析（createRequire 以工程为基准，不用 cocoscli 自带）
 */
export function checkLintEnvironment(dir: string): LintEnvironmentError[] {
  const errors: LintEnvironmentError[] = [];

  // 检查1：.eslintrc.json
  const configPath = path.join(dir, '.eslintrc.json');
  if (!fs.existsSync(configPath)) {
    errors.push({
      code: LINT_ENV_ERRORS.ESLINT_CONFIG_NOT_FOUND,
      message: '.eslintrc.json not found',
      path: '.eslintrc.json',
    });
  } else {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      // 不吞错：配置文件写坏要如实暴露
      errors.push({
        code: LINT_ENV_ERRORS.ESLINT_CONFIG_PARSE_ERROR,
        message: `.eslintrc.json 解析失败：${errorMessage(e)}`,
        path: '.eslintrc.json',
      });
    }
  }

  // 检查2：tsconfig.eslint.json（不 fallback 到 tsconfig.json，避免 cocoscli 猜工程环境）
  const tsconfigPath = path.join(dir, 'tsconfig.eslint.json');
  if (!fs.existsSync(tsconfigPath)) {
    errors.push({
      code: LINT_ENV_ERRORS.ESLINT_TSCONFIG_NOT_FOUND,
      message: 'tsconfig.eslint.json not found',
      path: 'tsconfig.eslint.json',
    });
  }

  // 检查3：工程本地 eslint（解析不到直接报环境错误，不 fallback cocoscli 自带）
  try {
    const projectRequire = createRequire(path.join(dir, 'package.json'));
    projectRequire.resolve('eslint');
  } catch (e) {
    errors.push({
      code: LINT_ENV_ERRORS.ESLINT_NOT_FOUND,
      message: `工程本地 eslint 不可解析（${errorMessage(e)}）。请在工程里 npm install eslint。`,
    });
  }

  return errors;
}

/** 绝对路径转相对工程根的 POSIX 路径（与 compile-log 的 file 字段风格一致） */
function toRelativePosix(dir: string, absFile: string): string {
  return path.relative(dir, absFile).replace(/\\/g, '/');
}

/**
 * 标准化单条 ESLint message 为 LintIssue 或环境错误
 *
 * 返回二选一：
 *   - environmentError：fatal 且匹配 parser project 模式（文件不在 tsconfig project 里，环境问题）
 *   - issue：其余全部（fatal → category=parsing；普通规则 → category=eslint）
 */
export function normalizeMessage(
  msg: EslintMessage,
  absFile: string,
  relFile: string
): { issue?: LintIssue; environmentError?: LintEnvironmentError } {
  // 环境问题：文件不在 parserOptions.project 的 tsconfig 里（配置问题，不是业务代码问题）
  if (msg.fatal && isParserProjectError(msg.message)) {
    return {
      environmentError: {
        code: LINT_ENV_ERRORS.ESLINT_PARSER_PROJECT_ERROR,
        message: `${relFile}: ${msg.message}`,
        path: relFile,
      },
    };
  }

  const severity: 'error' | 'warning' = msg.severity === 2 ? 'error' : 'warning';
  const isParsing = msg.fatal === true;
  return {
    issue: {
      file: relFile,
      line: msg.line,
      column: msg.column,
      endLine: msg.endLine ?? msg.line,
      endColumn: msg.endColumn ?? msg.column,
      // code 统一消费入口：parsing 错误给固定码，普通规则用 ruleId（无 ruleId 兜底 "eslint"）
      code: isParsing ? 'ESLINT_PARSING_ERROR' : (msg.ruleId ?? 'eslint'),
      ruleId: msg.ruleId,
      message: msg.message,
      category: isParsing ? 'parsing' : 'eslint',
      severity,
      fixable: msg.fix != null,
      snippet: readSnippet(absFile, msg.line),
    },
  };
}

/** 聚合规则统计：bySeverity + byRule（按 code 计数） */
export function aggregateRuleSummary(issues: LintIssue[]): LintRuleSummary {
  const bySeverity = { error: 0, warning: 0 };
  const byRule: Record<string, number> = {};
  for (const issue of issues) {
    bySeverity[issue.severity]++;
    byRule[issue.code] = (byRule[issue.code] || 0) + 1;
  }
  return { total: issues.length, bySeverity, byRule };
}

/** 聚合文件统计：per-file errorCount/warningCount（供 Agent 按文件分批修） */
export function aggregateFileSummary(
  issues: LintIssue[]
): Record<string, { errorCount: number; warningCount: number }> {
  const summary: Record<string, { errorCount: number; warningCount: number }> = {};
  for (const issue of issues) {
    const entry = summary[issue.file] ?? { errorCount: 0, warningCount: 0 };
    if (issue.severity === 'error') entry.errorCount++;
    else entry.warningCount++;
    summary[issue.file] = entry;
  }
  return summary;
}

/** 创建 lint 结果骨架（preflight 失败时也基于它落日志） */
export function createEmptyLintResult(dir: string): LintResult {
  return {
    command: 'cocoscli lint',
    project: dir,
    timestamp: new Date().toISOString(),
    eslintConfigPath: '.eslintrc.json',
    tsconfigPath: 'tsconfig.eslint.json',
    parserProject: null,
    ok: false,
    fileCount: 0,
    errorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    environmentErrors: [],
    ruleSummary: { total: 0, bySeverity: { error: 0, warning: 0 }, byRule: {} },
    fileSummary: {},
    errors: [],
    warnings: [],
  };
}

// ==================== 编排（真实工程验收） ====================

/**
 * 对 Cocos 工程执行 ESLint 检查，返回标准化 LintResult
 *
 * 保证不 throw：所有环境异常（eslint 模块加载失败、lintFiles 抛错）都转 environmentErrors。
 * 忠实模式：工程 .eslintrc.json + 工程本地 eslint，ignorePatterns/overrides 原样生效。
 */
export async function lintProject(dir: string): Promise<LintResult> {
  const result = createEmptyLintResult(dir);
  result.parserProject = readParserProject(dir);

  // 切到工程目录：@typescript-eslint/parser 解析 parserOptions.project 相对路径用进程 cwd，
  // 不受 ESLint({cwd}) 影响（ESLint 的 cwd 不传给 parser）。
  // 不 chdir 会把 './tsconfig.eslint.json' 解析到 cocoscli 进程目录 → 全量 Parsing error。
  // 这也等价于用户在工程根目录直接跑 npx eslint 的真实语义。
  process.chdir(dir);

  // 加载工程本地 eslint（preflight 已验证可解析，这里模块体执行失败也转环境错误）
  let ESLintCtor: EslintClass;
  try {
    const projectRequire = createRequire(path.join(dir, 'package.json'));
    const eslintModule = projectRequire('eslint') as { ESLint: EslintClass };
    ESLintCtor = eslintModule.ESLint;
  } catch (e) {
    result.environmentErrors.push({
      code: LINT_ENV_ERRORS.ESLINT_NOT_FOUND,
      message: `工程本地 eslint 加载失败：${errorMessage(e)}`,
    });
    return result;
  }

  // 执行 lint（plugin/parser 加载失败在此抛出）
  let results: EslintFileResult[];
  try {
    const eslint = new ESLintCtor({
      cwd: dir,
      useEslintrc: true,
      errorOnUnmatchedPattern: false,
    });
    results = await eslint.lintFiles(['assets/**/*.{ts,tsx}']);
  } catch (e) {
    result.environmentErrors.push(classifyEnvironmentError(e));
    return result;
  }

  // 标准化：遍历每个文件每条 message
  const allIssues: LintIssue[] = [];
  for (const fr of results) {
    const relFile = toRelativePosix(dir, fr.filePath);
    // fixable 计数用 ESLint 自带的（准确）
    result.fixableErrorCount += fr.fixableErrorCount;
    result.fixableWarningCount += fr.fixableWarningCount;
    for (const msg of fr.messages) {
      const { issue, environmentError } = normalizeMessage(msg, fr.filePath, relFile);
      if (environmentError) {
        result.environmentErrors.push(environmentError);
        continue;
      }
      if (!issue) continue;
      allIssues.push(issue);
      if (issue.severity === 'error') result.errors.push(issue);
      else result.warnings.push(issue);
    }
  }

  result.fileCount = results.length;
  result.errorCount = result.errors.length;
  result.warningCount = result.warnings.length;
  result.ruleSummary = aggregateRuleSummary(allIssues);
  result.fileSummary = aggregateFileSummary(allIssues);
  result.ok = result.environmentErrors.length === 0 && result.errorCount === 0;
  return result;
}
