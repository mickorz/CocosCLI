'use strict';

/**
 * 运行时全局变量 bridge 生成（P2）
 *
 * 根据 compile.config.json 的 runtimeGlobals 配置，生成 virtual .d.ts content，
 * 由 cocos-mcp VirtualDeclaration Host 注入 Program（仅 checker 可见，不落盘）。
 *
 * P2 仅支持 moduleExport kind：declare const <name>: typeof import("<module>").<export>;
 * 可证明条件：bridge 自身 diagnostics 由 cocos-mcp 单独收集（environmentErrors），
 * 若 module/export 无法解析 → Type Environment Resolution Error，绝不 fallback any。
 *
 * 生成后交给 cocos-mcp 通用 VirtualDeclaration 接口：
 *   cocoscli 负责 runtimeGlobals 语义 + bridge 内容生成 + resolver/invariant
 *   cocos-mcp 只负责「给我一份 virtual .d.ts，加入 Program」（不含 pfbm/业务知识）
 */

import type { RuntimeGlobal } from './compile-config.js';

/**
 * cocoscli 侧的 virtual declaration
 *（与 cocos-mcp 侧 VirtualDeclaration 结构一致，HTTP JSON 传递）
 */
export interface VirtualDeclaration {
  fileName: string;
  content: string;
}

/** virtual runtime-globals 文件名（cocos-mcp 侧据此识别并做 diagnostics 分层） */
export const RUNTIME_GLOBALS_VIRTUAL_FILENAME = '__cocoscli_runtime_globals__.d.ts';

/**
 * 根据 runtimeGlobals 生成 virtual declaration
 *
 * @param runtimeGlobals compile.config.json 的 runtimeGlobals（空则返回 null，不注入）
 * @returns VirtualDeclaration 或 null（无 runtimeGlobals 时不注入）
 */
export function buildRuntimeGlobalsDeclaration(
  runtimeGlobals?: Record<string, RuntimeGlobal>
): VirtualDeclaration | null {
  if (!runtimeGlobals) return null;
  const entries = Object.entries(runtimeGlobals);
  if (entries.length === 0) return null;

  const lines: string[] = [
    '// cocoscli runtime globals bridge（virtual，不落盘，仅 checker 可见）',
    '// 由 compile.config.json 的 runtimeGlobals 生成；补 Type Environment，非降噪',
    '',
  ];
  for (const [name, g] of entries) {
    if (g.kind === 'moduleExport') {
      // 强类型 bridge：保留整条类型链（写错方法名仍能 TS2339 抓到），绝不 any fallback
      lines.push(`declare const ${name}: typeof import("${g.module}").${g.export};`);
    } else if (g.kind === 'namespaceAlias') {
      // P3 namespace alias：import <name> = <target>（保留完整 namespace，value + type）
      lines.push(`import ${name} = ${g.target};`);
    }
  }
  return { fileName: RUNTIME_GLOBALS_VIRTUAL_FILENAME, content: lines.join('\n') + '\n' };
}
