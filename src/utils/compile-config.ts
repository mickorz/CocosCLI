'use strict';

/**
 * compile 命令配置（.cocoscli/compile.config.json）
 *
 * compile 配置的读取流程：
 *   readCompileConfig(projectPath)
 *     ├─ 定位 <工程>/.cocoscli/compile.config.json
 *     ├─ 不存在 → 写默认模板（strict:false）+ 返回默认
 *     └─ 存在 → JSON.parse + 与默认合并（新增字段有默认值）
 *
 * 配置项：
 *   - strict: 严格模式（true 全开 strict：null/类型不匹配/隐式any 全报；
 *             false 对齐编辑器工头视角，默认）
 *
 * 设计：配置文件驱动（替代命令行 --strict），每次 compile 前读取。
 *      不存在自动生成默认模板，方便用户在 .cocoscli/compile.config.json 编辑。
 *      JSON 解析失败抛错（暴露用户配置格式问题），由 compile.ts 捕获后友好提示。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 运行时全局变量声明（P2 仅 moduleExport kind；后续可扩展 namespaceAlias 等） */
export interface RuntimeGlobalModuleExport {
  kind: 'moduleExport';
  module: string;  // 模块名（如 "kiwi"），须能被工程 tsconfig paths 解析
  export: string;  // export 名（如 "pfbm"）
}

/** compile 配置（.cocoscli/compile.config.json 的字段） */
export interface CompileConfig {
  /**
   * 严格模式：true 时开启 strict 全开（null/类型不匹配/隐式any 全报，等同原 --strict）；
   * false 时对齐编辑器（务实工头视角，关 strict）。默认 false。
   */
  strict?: boolean;

  /**
   * 排除路径前缀数组（相对工程根，正斜杠，如 "assets/biz_modules"）：
   * file 以这些前缀开头的诊断不计入 real/noise，归 excluded（如第三方/子模块目录）。
   * 匹配按目录前缀（"assets/biz_modules" 匹配其下所有文件，不误伤 "assets/biz_modules_other"）。
   * 默认空（不排除）。
   */
  excludePath?: string[];

  /**
   * 包含路径前缀数组（相对工程根，正斜杠，如 ["assets/10000", "assets/scripts/testerror"]）：
   * 为空 → 检查所有（默认）；不为空 → 只检查这些路径下的，其余排除（归 excluded）。
   * 与 excludePath 互补：includePath 是白名单，excludePath 是黑名单。
   * 匹配按目录前缀（同 excludePath 规则）。
   */
  includePath?: string[];

  /**
   * 运行时全局变量声明（bridge）：告诉 cocoscli 项目真实运行环境额外提供了哪些 global。
   * cocoscli 据此生成 virtual .d.ts（declare const <name>: typeof import("<module>").<export>;），
   * 由 cocos-mcp VirtualDeclaration Host 注入 Program（仅 checker 可见，不落盘、不污染工程）。
   * 性质：补 Type Environment，不是降噪白名单。bridge 自身 diagnostics 单独报告
   * （Type Environment Resolution Error），绝不 fallback any。P2 仅 moduleExport kind。
   */
  runtimeGlobals?: Record<string, RuntimeGlobalModuleExport>;
}

/** 默认配置（工头视角：关 strict） */
export const DEFAULT_COMPILE_CONFIG: CompileConfig = {
  strict: false,
};

const CONFIG_FILENAME = 'compile.config.json';

/**
 * 读 compile 配置：.cocoscli/compile.config.json
 *
 * - 不存在：写默认模板（strict:false）到 .cocoscli/compile.config.json，返回默认值
 * - 存在：读取并与默认合并（保证新增字段有默认值）
 * - JSON 解析失败：抛 SyntaxError（compile.ts 捕获后友好报错 + exit，不吞错）
 *
 * @param projectPath 工程根目录
 * @returns 合并后的配置
 */
export function readCompileConfig(projectPath: string): CompileConfig {
  const cocoscliDir = path.join(projectPath, '.cocoscli');
  const configPath = path.join(cocoscliDir, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    // 不存在：写默认模板，方便用户编辑（.cocoscli/ 是 cocoscli 管理目录，自动生成模板合理）
    fs.mkdirSync(cocoscliDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_COMPILE_CONFIG, null, 2) + '\n', 'utf-8');
    return { ...DEFAULT_COMPILE_CONFIG };
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content) as Partial<CompileConfig>;
  return { ...DEFAULT_COMPILE_CONFIG, ...parsed };
}

/**
 * 按 excludePath 前缀过滤诊断：file 以任一前缀开头的项排除
 *
 * 匹配规则（目录前缀，避免误伤同名目录）：
 *   - 规范化前缀：转正斜杠、去前导 ./ 和 /、去尾 /
 *   - file === 前缀（精确文件）或 file 以前缀 + '/' 开头（目录下）
 *   - 例：excludePath "assets/biz_modules" 排除 "assets/biz_modules/a.ts"，不排除 "assets/biz_modules_other/b.ts"
 *
 * @param items 诊断数组（只要有 file 字段）
 * @param excludePath 配置的排除前缀
 * @returns kept 保留的；excluded 被排除的数量
 */
export function filterExcludePath<T extends { file: string }>(
  items: T[],
  excludePath?: string[]
): { kept: T[]; excluded: number } {
  if (!excludePath || excludePath.length === 0) {
    return { kept: items, excluded: 0 };
  }
  const norms = excludePath.map((p) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  );
  let excluded = 0;
  const kept = items.filter((item) => {
    const f = item.file.replace(/\\/g, '/');
    const isExcluded = norms.some((p) => f === p || f.startsWith(p + '/'));
    if (isExcluded) excluded++;
    return !isExcluded;
  });
  return { kept, excluded };
}

/**
 * 按 includePath 前缀白名单过滤诊断：includePath 为空全保留；不为空只保留 file 匹配任一前缀的
 *
 * 与 filterExcludePath 互补（includePath 白名单，excludePath 黑名单）。
 * 匹配规则同 filterExcludePath（目录前缀，不误伤同名目录）。
 *
 * @param items 诊断数组
 * @param includePath 白名单前缀（空则全保留）
 * @returns kept 保留的；excluded 被排除（不在白名单）的数量
 */
export function filterIncludePath<T extends { file: string }>(
  items: T[],
  includePath?: string[]
): { kept: T[]; excluded: number } {
  if (!includePath || includePath.length === 0) {
    return { kept: items, excluded: 0 };
  }
  const norms = includePath.map((p) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  );
  let excluded = 0;
  const kept = items.filter((item) => {
    const f = item.file.replace(/\\/g, '/');
    const isIncluded = norms.some((p) => f === p || f.startsWith(p + '/'));
    if (!isIncluded) excluded++;
    return isIncluded;
  });
  return { kept, excluded };
}

/**
 * 校验 includePath / excludePath 路径在工程里是否存在（文件或目录）
 *
 * 用于检出拼错/大小写错的配置路径，避免「静默失效」（拼错的路径过滤不到任何文件 → 漏检）。
 * compile 启动时调用，不存在的路径给警告（不阻断 compile）。
 *
 * @param projectPath 工程根目录
 * @param config compile 配置
 * @returns 不存在的路径列表（都存在则空数组）
 */
export function validatePaths(projectPath: string, config: CompileConfig): string[] {
  const missing: string[] = [];
  const check = (paths?: string[]) => {
    if (!paths) return;
    for (const p of paths) {
      const abs = path.join(projectPath, p);
      if (!fs.existsSync(abs)) {
        missing.push(p);
      }
    }
  };
  check(config.includePath);
  check(config.excludePath);
  return missing;
}
