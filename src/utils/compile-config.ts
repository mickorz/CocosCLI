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

/** compile 配置（.cocoscli/compile.config.json 的字段） */
export interface CompileConfig {
  /**
   * 严格模式：true 时开启 strict 全开（null/类型不匹配/隐式any 全报，等同原 --strict）；
   * false 时对齐编辑器（务实工头视角，关 strict）。默认 false。
   */
  strict?: boolean;
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
