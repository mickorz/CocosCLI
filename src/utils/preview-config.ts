'use strict';

/**
 * 预览地址 query 参数配置（.cocoscli/preview.config.json）
 *
 * previewscene 命令运行时读取，拿到 previewUrl 后拼接参数（如 ?ui=10000&gameid=42272）。
 * 不存在则写默认模板，方便用户编辑。
 *
 * 优先级（高 → 低）：
 *   1. 命令行 --query 参数（临时覆盖，调试换参不用改文件）
 *   2. config.scenes[场景名]（场景级覆盖，不同场景不同参数）
 *   3. config.default（工程级默认，所有场景共用）
 *   4. 空（不加参数，行为同旧版）
 *
 * 设计：配置文件驱动，previewscene 每次运行前读取。
 *      JSON 解析失败抛错（暴露用户配置格式问题），由命令层捕获后友好提示。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 预览参数配置（对应 .cocoscli/preview.config.json 的业务字段） */
export interface PreviewConfig {
  /** 工程级默认 query（不含 ? 前缀，如 "ui=10000&gameid=42272"），空则不加参数 */
  default?: string;
  /** 场景级 query 覆盖（key 为场景名，如 { "loading": "gameid=42272" }） */
  scenes?: Record<string, string>;
}

const CONFIG_FILENAME = 'preview.config.json';

/** 默认配置（模板示例，用户按工程实际情况编辑） */
export const DEFAULT_PREVIEW_CONFIG: PreviewConfig = {
  default: 'ui=10000&gameid=42272',
  scenes: {
    loading: 'ui=10000&gameid=42272',
  },
};

/**
 * 默认模板 JSON 文本（带 $schema 注释字段，方便用户理解结构）
 */
function stringifyDefaultTemplate(): string {
  const template = {
    $schema:
      'previewscene 预览地址参数配置。优先级：命令行 --query > scenes[场景名] > default > 不加参数。query 值不含 ? 前缀，多个参数用 & 连接。',
    ...DEFAULT_PREVIEW_CONFIG,
  };
  return JSON.stringify(template, null, 2) + '\n';
}

/**
 * 读预览参数配置：.cocoscli/preview.config.json
 *
 * - 不存在：写默认模板到 .cocoscli/preview.config.json，返回默认值（返回 true 表示新生成）
 * - 存在：JSON.parse 返回（保留用户编辑的 default/scenes 字段）
 * - JSON 解析失败：抛 SyntaxError（命令层捕获后友好报错 + exit，不吞错）
 *
 * @param projectPath 工程根目录
 * @returns { config, created } config 配置对象，created 是否本次新生成模板
 */
export function readPreviewConfig(projectPath: string): { config: PreviewConfig; created: boolean } {
  const cocoscliDir = path.join(projectPath, '.cocoscli');
  const configPath = path.join(cocoscliDir, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    // 不存在：写默认模板，方便用户编辑
    fs.mkdirSync(cocoscliDir, { recursive: true });
    fs.writeFileSync(configPath, stringifyDefaultTemplate(), 'utf-8');
    return { config: JSON.parse(JSON.stringify(DEFAULT_PREVIEW_CONFIG)), created: true };
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content) as PreviewConfig;
  return { config: parsed, created: false };
}

/**
 * 按优先级解析最终 query：--query > scenes[场景名] > default > 空
 *
 * @param scene 场景名（previewscene 第一个参数，用户输入原样）
 * @param config 预览参数配置（null 则视为空配置）
 * @param cliQuery 命令行 --query 值（未传则 undefined）
 * @returns 最终 query 字符串（不含 ? / & 前缀），空字符串表示不加参数
 */
export function resolvePreviewQuery(
  scene: string,
  config: PreviewConfig | null | undefined,
  cliQuery?: string
): string {
  if (cliQuery && cliQuery.trim()) return cliQuery.trim();
  const sceneQuery = config?.scenes?.[scene];
  if (sceneQuery && sceneQuery.trim()) return sceneQuery.trim();
  const defaultQuery = config?.default;
  if (defaultQuery && defaultQuery.trim()) return defaultQuery.trim();
  return '';
}

/**
 * 拼接 previewUrl + query
 *
 * previewUrl 可能已带 query（如 http://localhost:7456/?x=1），此时用 & 衔接；
 * query 已 trim 且非空才拼，空则原样返回。
 *
 * @param previewUrl CocosMCP 返回的预览地址（如 http://localhost:7456）
 * @param query 不含 ? / & 前缀的参数串，空则不加
 */
export function appendPreviewQuery(previewUrl: string, query: string): string {
  const q = query.trim();
  if (!q) return previewUrl;
  return previewUrl.includes('?') ? `${previewUrl}&${q}` : `${previewUrl}/?${q}`;
}
