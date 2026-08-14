import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isParserProjectError,
  classifyEnvironmentError,
  checkLintEnvironment,
  readParserProject,
  normalizeMessage,
  aggregateRuleSummary,
  aggregateFileSummary,
  createEmptyLintResult,
  LINT_ENV_ERRORS,
  LintIssue,
} from '../../utils/lint.js';

// lint 核心纯函数单测（零 mock：纯函数内联字面量，碰文件系统用 mkdtemp 真实临时目录）

/** 构造一条 ESLint message（测试辅助） */
const mkMsg = (overrides: Record<string, unknown> = {}) => ({
  ruleId: '@typescript-eslint/no-explicit-any',
  severity: 2,
  message: 'Unexpected any. Specify a different type.',
  line: 3,
  column: 5,
  endLine: 3,
  endColumn: 8,
  ...overrides,
});

/** 构造一条 LintIssue（聚合函数测试辅助） */
const mkIssue = (file: string, severity: 'error' | 'warning', code: string): LintIssue => ({
  file,
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  code,
  ruleId: code,
  message: 'msg',
  category: 'eslint',
  severity,
  fixable: false,
  snippet: '',
});

// ---------- isParserProjectError ----------

describe('isParserProjectError', () => {
  it('匹配官方错误信息 must be included in at least one of the projects provided', () => {
    expect(
      isParserProjectError('The file must be included in at least one of the projects provided')
    ).toBe(true);
  });

  it('匹配 TSConfig does not include this file 变体', () => {
    expect(isParserProjectError('TSConfig does not include this file.')).toBe(true);
  });

  it('匹配 does not match your project config 变体', () => {
    expect(isParserProjectError('was not found by the parserOptions.project does not match your project config')).toBe(true);
  });

  it('匹配 parserOptions.project 关键词', () => {
    expect(isParserProjectError('parserOptions.project has been set for @typescript-eslint/parser.')).toBe(true);
  });

  it('匹配 tsconfig 读不到（parserOptions.project 相对路径解析失败，环境问题）', () => {
    expect(
      isParserProjectError("Parsing error: Cannot read file 'e:\\proj\\tsconfig.eslint.json'.")
    ).toBe(true);
  });

  it('不匹配普通 parsing error', () => {
    expect(isParserProjectError("Parsing error: ',' expected")).toBe(false);
  });

  it('不匹配普通规则消息', () => {
    expect(isParserProjectError('Unexpected any. Specify a different type.')).toBe(false);
  });
});

// ---------- classifyEnvironmentError ----------

describe('classifyEnvironmentError', () => {
  it('plugin 加载失败 → ESLINT_PLUGIN_LOAD_ERROR 并提取 plugin 名', () => {
    const err = classifyEnvironmentError(
      new Error(`Failed to load plugin 'bf-eslint-plugin' declared in '.eslintrc.json'`)
    );
    expect(err.code).toBe(LINT_ENV_ERRORS.ESLINT_PLUGIN_LOAD_ERROR);
    expect(err.plugin).toBe('bf-eslint-plugin');
  });

  it('Cannot find module 且含 parser → ESLINT_PARSER_LOAD_ERROR', () => {
    const err = classifyEnvironmentError(new Error(`Cannot find module '@typescript-eslint/parser'`));
    expect(err.code).toBe(LINT_ENV_ERRORS.ESLINT_PARSER_LOAD_ERROR);
    expect(err.plugin).toBeUndefined();
  });

  it('plugin 错误优先于 parser 模块匹配（message 同时含两种模式）', () => {
    const err = classifyEnvironmentError(
      new Error(`Failed to load plugin 'eslint-plugin-unicorn': Cannot find module 'eslint-plugin-unicorn/parser'`)
    );
    expect(err.code).toBe(LINT_ENV_ERRORS.ESLINT_PLUGIN_LOAD_ERROR);
    expect(err.plugin).toBe('eslint-plugin-unicorn');
  });

  it('未知异常兜底 ESLINT_RUN_ERROR（不吞错，message 保留）', () => {
    const err = classifyEnvironmentError(new Error('some unexpected failure'));
    expect(err.code).toBe(LINT_ENV_ERRORS.ESLINT_RUN_ERROR);
    expect(err.message).toContain('some unexpected failure');
  });

  it('非 Error 值转字符串处理', () => {
    const err = classifyEnvironmentError('plain string error');
    expect(err.code).toBe(LINT_ENV_ERRORS.ESLINT_RUN_ERROR);
    expect(err.message).toBe('plain string error');
  });
});

// ---------- normalizeMessage ----------

describe('normalizeMessage', () => {
  it('severity 2 → error', () => {
    const { issue } = normalizeMessage(mkMsg({ severity: 2 }), 'x.ts', 'x.ts');
    expect(issue?.severity).toBe('error');
  });

  it('severity 1 → warning', () => {
    const { issue } = normalizeMessage(mkMsg({ severity: 1 }), 'x.ts', 'x.ts');
    expect(issue?.severity).toBe('warning');
  });

  it('普通规则 → category=eslint，code/ruleId 取 ruleId', () => {
    const { issue } = normalizeMessage(mkMsg(), 'x.ts', 'x.ts');
    expect(issue?.category).toBe('eslint');
    expect(issue?.code).toBe('@typescript-eslint/no-explicit-any');
    expect(issue?.ruleId).toBe('@typescript-eslint/no-explicit-any');
  });

  it('ruleId 为 null 的非 fatal message → code 回退 eslint', () => {
    const { issue } = normalizeMessage(mkMsg({ ruleId: null }), 'x.ts', 'x.ts');
    expect(issue?.code).toBe('eslint');
    expect(issue?.ruleId).toBeNull();
  });

  it('fatal 普通语法错 → category=parsing，code=ESLINT_PARSING_ERROR', () => {
    const { issue, environmentError } = normalizeMessage(
      mkMsg({ fatal: true, ruleId: null, message: "Parsing error: ',' expected" }),
      'x.ts',
      'x.ts'
    );
    expect(environmentError).toBeUndefined();
    expect(issue?.category).toBe('parsing');
    expect(issue?.code).toBe('ESLINT_PARSING_ERROR');
    expect(issue?.severity).toBe('error');
  });

  it('fatal + parser project 模式 → environmentError（ESLINT_PARSER_PROJECT_ERROR），不产生 issue', () => {
    const { issue, environmentError } = normalizeMessage(
      mkMsg({
        fatal: true,
        ruleId: null,
        message: 'The file must be included in at least one of the projects provided',
      }),
      'x.ts',
      'assets/a.ts'
    );
    expect(issue).toBeUndefined();
    expect(environmentError?.code).toBe(LINT_ENV_ERRORS.ESLINT_PARSER_PROJECT_ERROR);
    expect(environmentError?.path).toBe('assets/a.ts');
    expect(environmentError?.message).toContain('assets/a.ts');
  });

  it('endLine/endColumn 缺省回退 line/column', () => {
    const msg = mkMsg();
    delete (msg as Record<string, unknown>).endLine;
    delete (msg as Record<string, unknown>).endColumn;
    const { issue } = normalizeMessage(msg, 'x.ts', 'x.ts');
    expect(issue?.endLine).toBe(3);
    expect(issue?.endColumn).toBe(5);
  });

  it('有 fix → fixable=true；无 fix → false', () => {
    const withFix = normalizeMessage(mkMsg({ fix: { range: [0, 1], text: '' } }), 'x.ts', 'x.ts');
    const noFix = normalizeMessage(mkMsg(), 'x.ts', 'x.ts');
    expect(withFix.issue?.fixable).toBe(true);
    expect(noFix.issue?.fixable).toBe(false);
  });
});

// ---------- aggregateRuleSummary / aggregateFileSummary ----------

describe('aggregateRuleSummary', () => {
  it('聚合 total/bySeverity/byRule', () => {
    const issues = [
      mkIssue('a.ts', 'error', 'no-unused-vars'),
      mkIssue('a.ts', 'error', 'no-unused-vars'),
      mkIssue('b.ts', 'error', 'naming-convention'),
      mkIssue('b.ts', 'warning', 'no-for-loop'),
      mkIssue('c.ts', 'warning', 'no-for-loop'),
    ];
    expect(aggregateRuleSummary(issues)).toEqual({
      total: 5,
      bySeverity: { error: 3, warning: 2 },
      byRule: { 'no-unused-vars': 2, 'naming-convention': 1, 'no-for-loop': 2 },
    });
  });

  it('空数组 → 全零', () => {
    expect(aggregateRuleSummary([])).toEqual({
      total: 0,
      bySeverity: { error: 0, warning: 0 },
      byRule: {},
    });
  });
});

describe('aggregateFileSummary', () => {
  it('按文件聚合 error/warning 计数', () => {
    const issues = [
      mkIssue('assets/a.ts', 'error', 'r1'),
      mkIssue('assets/a.ts', 'error', 'r2'),
      mkIssue('assets/a.ts', 'warning', 'r3'),
      mkIssue('assets/b.ts', 'warning', 'r3'),
    ];
    expect(aggregateFileSummary(issues)).toEqual({
      'assets/a.ts': { errorCount: 2, warningCount: 1 },
      'assets/b.ts': { errorCount: 0, warningCount: 1 },
    });
  });
});

// ---------- createEmptyLintResult ----------

describe('createEmptyLintResult', () => {
  it('骨架字段完整且 ok=false、计数为零', () => {
    const result = createEmptyLintResult('E:\\proj');
    expect(result.command).toBe('cocoscli lint');
    expect(result.project).toBe('E:\\proj');
    expect(result.ok).toBe(false);
    expect(result.eslintConfigPath).toBe('.eslintrc.json');
    expect(result.tsconfigPath).toBe('tsconfig.eslint.json');
    expect(result.parserProject).toBeNull();
    expect(result.fileCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.environmentErrors).toEqual([]);
    expect(result.ruleSummary.byRule).toEqual({});
    expect(result.fileSummary).toEqual({});
  });
});

// ---------- checkLintEnvironment / readParserProject / snippet（真实临时目录） ----------

const dirs: string[] = [];

/** 建真实临时目录（afterEach 统一清理） */
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-lint-'));
  dirs.push(dir);
  return dir;
}

/** 写 .eslintrc.json 到目录 */
function writeEslintrc(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '.eslintrc.json'), content, 'utf-8');
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('checkLintEnvironment（真实临时目录）', () => {
  it('空目录 → 报 CONFIG_NOT_FOUND + TSCONFIG_NOT_FOUND', () => {
    const errors = checkLintEnvironment(tmpDir());
    const codes = errors.map((e) => e.code);
    expect(codes).toContain(LINT_ENV_ERRORS.ESLINT_CONFIG_NOT_FOUND);
    expect(codes).toContain(LINT_ENV_ERRORS.ESLINT_TSCONFIG_NOT_FOUND);
  });

  it('只放合法 .eslintrc.json → CONFIG 错误消失，TSCONFIG 仍在', () => {
    const dir = tmpDir();
    writeEslintrc(dir, JSON.stringify({ root: true }));
    const codes = checkLintEnvironment(dir).map((e) => e.code);
    expect(codes).not.toContain(LINT_ENV_ERRORS.ESLINT_CONFIG_NOT_FOUND);
    expect(codes).toContain(LINT_ENV_ERRORS.ESLINT_TSCONFIG_NOT_FOUND);
  });

  it('.eslintrc.json 非法 JSON → ESLINT_CONFIG_PARSE_ERROR（不吞错）', () => {
    const dir = tmpDir();
    writeEslintrc(dir, '{ not valid json');
    const errors = checkLintEnvironment(dir);
    const parseError = errors.find((e) => e.code === LINT_ENV_ERRORS.ESLINT_CONFIG_PARSE_ERROR);
    expect(parseError).toBeDefined();
    expect(parseError?.message).toContain('.eslintrc.json');
  });

  it('补齐 .eslintrc.json + tsconfig.eslint.json → 只剩 ESLINT_NOT_FOUND（临时目录无 node_modules）', () => {
    const dir = tmpDir();
    writeEslintrc(dir, JSON.stringify({ root: true }));
    fs.writeFileSync(path.join(dir, 'tsconfig.eslint.json'), '{}', 'utf-8');
    const codes = checkLintEnvironment(dir).map((e) => e.code);
    // eslint 解析沿目录树向上查找，临时目录树上通常没有 node_modules；
    // 该断言依赖此环境事实，若 CI 环境祖先恰好装了 eslint 会失败——此时应改为不含 TSCONFIG 断言
    expect(codes).toEqual([LINT_ENV_ERRORS.ESLINT_NOT_FOUND]);
  });
});

describe('readParserProject（真实临时目录）', () => {
  it('读出 parserOptions.project', () => {
    const dir = tmpDir();
    writeEslintrc(
      dir,
      JSON.stringify({ parserOptions: { project: './tsconfig.eslint.json' } })
    );
    expect(readParserProject(dir)).toBe('./tsconfig.eslint.json');
  });

  it('无 parserOptions → null', () => {
    const dir = tmpDir();
    writeEslintrc(dir, JSON.stringify({ root: true }));
    expect(readParserProject(dir)).toBeNull();
  });

  it('非法 JSON → 抛错（暴露配置格式问题，不吞）', () => {
    const dir = tmpDir();
    writeEslintrc(dir, 'not json');
    expect(() => readParserProject(dir)).toThrow();
  });
});

describe('normalizeMessage snippet（真实临时文件）', () => {
  it('snippet 读取错误行上下文（错误行在中间）', () => {
    const dir = tmpDir();
    const absFile = path.join(dir, 'a.ts');
    fs.writeFileSync(absFile, 'line1\nline2\nline3\nline4\n', 'utf-8');
    // 错误在第 3 行 → snippet 应含 line2/line3/line4
    const { issue } = normalizeMessage(mkMsg({ line: 3, endLine: 3 }), absFile, 'a.ts');
    expect(issue?.snippet).toBe('line2\nline3\nline4');
  });

  it('文件不存在 → snippet 空串（不炸）', () => {
    const { issue } = normalizeMessage(mkMsg(), path.join(tmpDir(), 'missing.ts'), 'missing.ts');
    expect(issue?.snippet).toBe('');
  });
});
