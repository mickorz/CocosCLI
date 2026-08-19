'use strict';

/**
 * 已知非阻断错误配置（.cocoscli/known_nonblocking_errors.json）
 *
 * compile/browserlogs 命令运行时读取，命中的 error/log 过滤掉（归为优化问题，不影响 ok 判定）。
 * 不存在则写默认模板（参考 7-test-verify 流程的已知非阻断清单），方便用户编辑。
 *
 * 匹配规则（与 generate_report_html.py 的 is_nonblocking_* 一致）：
 *   compile:     error.code 精确匹配 rule.code（rule.code 为空忽略 code 检查），
 *                可选 file/message_contains 细化（子串匹配，空字段忽略）
 *   browserlogs: log.text 包含 rule.message_contains（子串匹配）
 *
 * 设计：配置文件驱动，compile/browserlogs 每次运行前读取。
 *      JSON 解析失败抛错（暴露用户配置格式问题），由命令层捕获后友好提示。
 */

import * as fs from 'fs';
import * as path from 'path';

/** compile 非阻断规则 */
export interface CompileNonblockingRule {
  /** TS 错误码，精确匹配（空则忽略 code 检查） */
  code?: string;
  /** 文件路径子串匹配，空忽略 */
  file?: string;
  /** 消息子串匹配，空忽略 */
  message_contains?: string;
  /** 标注原因（展示用） */
  reason?: string;
}

/** browserlogs 非阻断规则 */
export interface BrowserlogsNonblockingRule {
  /** 日志 text 子串匹配（必填） */
  message_contains: string;
  /** 标注原因（展示用） */
  reason?: string;
}

/** 配置顶层（对应 .cocoscli/known_nonblocking_errors.json 的业务字段） */
export interface KnownNonblockingConfig {
  compile?: CompileNonblockingRule[];
  browserlogs?: BrowserlogsNonblockingRule[];
}

const CONFIG_FILENAME = 'known_nonblocking_errors.json';

/**
 * 默认配置（参考 7-test-verify 流程的已知非阻断清单）
 *
 * 写文件时会带 $schema/$matching 注释字段，方便用户理解；返回值只含业务字段。
 */
export const DEFAULT_NONBLOCKING_CONFIG: KnownNonblockingConfig = {
  compile: [
    { code: 'TS2345', reason: '类型不兼容 (GObject→GComponent 等), esbuild 转译忽略类型, 运行时不阻断' },
    { code: 'TS2531', reason: 'Object possibly null, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS18047', reason: 'possibly null, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS2724', reason: 'proto 无导出成员, esbuild 转译忽略, 当前测试路径未触发, 运行时不阻断' },
    { code: 'TS2694', reason: '命名空间无导出成员, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS2339', reason: '属性不存在, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS2300', reason: '重复标识符, esbuild 取后者, 运行时不阻断' },
    { code: 'TS2393', reason: '重复函数实现, esbuild 取后者, 运行时不阻断' },
    { code: 'TS2341', reason: '私有成员访问, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS2352', reason: '类型转换可能错误, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS2430', reason: '接口扩展不兼容 (.d.ts 声明), 运行时不阻断' },
    { code: 'TS2551', reason: '属性不存在, 当前测试路径未触发, 运行时不阻断' },
    { code: 'TS2550', reason: '.at 不存在 (lib 配置), 当前测试路径未触发, 运行时不阻断' },
    { code: 'TS2322', reason: '类型不兼容, esbuild 转译忽略, 运行时不阻断' },
    { code: 'TS7034', reason: '隐式 any, 运行时不阻断' },
  ],
  browserlogs: [
    {
      message_contains: 'download failed: https://res.gameabc.com/picad/202412/head1.png',
      reason: '外部 CDN 头像图本地预览不可达, 环境问题非代码 bug',
    },
  ],
};

/**
 * 默认模板 JSON 文本（带 $schema/$matching 注释字段，方便用户理解规则）
 */
function stringifyDefaultTemplate(): string {
  const template = {
    $schema:
      '7-test-verify 已知非阻断错误配置。compile/browserlogs 命令运行时命中即过滤（归优化问题，不影响 ok 判定）。',
    $matching: {
      compile: 'error.code 精确匹配 config.code (可选 file/message_contains 细化, 空字段忽略)',
      browserlogs: 'error.text 包含 config.message_contains (子串匹配)',
    },
    ...DEFAULT_NONBLOCKING_CONFIG,
  };
  return JSON.stringify(template, null, 2) + '\n';
}

/**
 * 读非阻断配置：.cocoscli/known_nonblocking_errors.json
 *
 * - 不存在：写默认模板到 .cocoscli/known_nonblocking_errors.json，返回默认值（返回 true 表示新生成）
 * - 存在：JSON.parse 返回（保留用户编辑的 compile/browserlogs 字段）
 * - JSON 解析失败：抛 SyntaxError（命令层捕获后友好报错 + exit，不吞错）
 *
 * @param projectPath 工程根目录
 * @returns { config, created } config 配置对象，created 是否本次新生成模板
 */
export function readNonblockingConfig(
  projectPath: string
): { config: KnownNonblockingConfig; created: boolean } {
  const cocoscliDir = path.join(projectPath, '.cocoscli');
  const configPath = path.join(cocoscliDir, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    // 不存在：写默认模板，方便用户编辑
    fs.mkdirSync(cocoscliDir, { recursive: true });
    fs.writeFileSync(configPath, stringifyDefaultTemplate(), 'utf-8');
    return { config: JSON.parse(JSON.stringify(DEFAULT_NONBLOCKING_CONFIG)), created: true };
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content) as KnownNonblockingConfig;
  return { config: parsed, created: false };
}

/** compile error 的最小匹配形状 */
interface CompileErrorLike {
  code?: string;
  file?: string;
  message?: string;
}

/**
 * 判断单条 compile error 是否命中已知非阻断规则
 *
 * 规则（与 generate_report_html.py is_nonblocking_compile 一致）：
 *   rule.code 存在则须 === error.code；rule.file 存在则须是 error.file 子串；
 *   rule.message_contains 存在则须是 error.message 子串。任一 rule 全满足即命中。
 *
 * @returns { matched, reason } matched 是否命中，reason 命中规则的标注原因
 */
export function matchNonblockingCompile(
  error: CompileErrorLike,
  config: KnownNonblockingConfig | null | undefined
): { matched: boolean; reason?: string } {
  if (!config?.compile || config.compile.length === 0) return { matched: false };
  for (const r of config.compile) {
    if (r.code && r.code !== (error.code ?? '')) continue;
    if (r.file && !(error.file ?? '').includes(r.file)) continue;
    if (r.message_contains && !(error.message ?? '').includes(r.message_contains)) continue;
    return { matched: true, reason: r.reason };
  }
  return { matched: false };
}

/** browserlogs log 的最小匹配形状 */
interface BrowserlogsLogLike {
  text?: string;
  message?: string;
}

/**
 * 判断单条 browserlogs log 是否命中已知非阻断规则
 *
 * 规则（与 generate_report_html.py is_nonblocking_browserlogs 一致）：
 *   log.text（取 text 或 message）包含 rule.message_contains 子串即命中。
 */
export function matchNonblockingBrowserlogs(
  log: BrowserlogsLogLike,
  config: KnownNonblockingConfig | null | undefined
): { matched: boolean; reason?: string } {
  if (!config?.browserlogs || config.browserlogs.length === 0) return { matched: false };
  const text = log.text ?? log.message ?? '';
  for (const r of config.browserlogs) {
    if (r.message_contains && text.includes(r.message_contains)) {
      return { matched: true, reason: r.reason };
    }
  }
  return { matched: false };
}

/**
 * 过滤 compile errors：命中已知非阻断的移入 filtered（带 reason），其余留 kept
 *
 * @param errors 待过滤的 error 数组
 * @param config 非阻断配置（null/空配置则不过滤，全留 kept）
 * @returns { kept, filtered } kept 保留的；filtered 被过滤的（每项附 reason）
 */
export function filterNonblockingCompile<T extends CompileErrorLike>(
  errors: T[],
  config: KnownNonblockingConfig | null | undefined
): { kept: T[]; filtered: Array<T & { reason?: string }> } {
  const filtered: Array<T & { reason?: string }> = [];
  if (!config?.compile || config.compile.length === 0) {
    return { kept: errors, filtered };
  }
  const kept = errors.filter((e) => {
    const m = matchNonblockingCompile(e, config);
    if (m.matched) {
      filtered.push({ ...e, reason: m.reason });
      return false;
    }
    return true;
  });
  return { kept, filtered };
}

/**
 * 过滤 browserlogs logs：命中已知非阻断的移入 filtered（带 reason），其余留 kept
 */
export function filterNonblockingBrowserlogs<T extends BrowserlogsLogLike>(
  logs: T[],
  config: KnownNonblockingConfig | null | undefined
): { kept: T[]; filtered: Array<T & { reason?: string }> } {
  const filtered: Array<T & { reason?: string }> = [];
  if (!config?.browserlogs || config.browserlogs.length === 0) {
    return { kept: logs, filtered };
  }
  const kept = logs.filter((l) => {
    const m = matchNonblockingBrowserlogs(l, config);
    if (m.matched) {
      filtered.push({ ...l, reason: m.reason });
      return false;
    }
    return true;
  });
  return { kept, filtered };
}
