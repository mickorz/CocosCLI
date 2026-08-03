import * as fs from 'fs';
import * as path from 'path';
import { isWindows } from './platform.js';

// Cocos 工程判定与路径规范化
//
// isCocosProject(dir)
//        └─> 检查 assets/ + settings/ 双标志（Cocos 3.x 工程根目录特征）
//
// normalizePath(p)
//        └─> path.resolve -> 统一正斜杠 -> 去尾部分隔符
//             Windows 额外 toLowerCase（文件系统大小写不敏感）
//             用于 close 命令的 --project 精确比对，防止 D:\A 误杀 D:\AB

/**
 * 判定目录是否为 Cocos Creator 3.x 工程
 * 判定标准：同时存在 assets/ 与 settings/ 目录
 * （Cocos 2.x 也有 assets/，但 settings/ 结构不同；本工具面向 3.7.x，双标志足够）
 */
export function isCocosProject(dir: string): boolean {
  if (!dir || !fs.existsSync(dir)) return false;
  const assetsDir = path.join(dir, 'assets');
  const settingsDir = path.join(dir, 'settings');
  return fs.existsSync(assetsDir) && fs.existsSync(settingsDir);
}

/**
 * 路径规范化：统一为正斜杠、去掉尾部分隔符；Windows 下额外转小写
 * 用于进程命令行 --project 参数的精确比对，避免前缀子串误匹配
 */
export function normalizePath(p: string): string {
  let n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWindows()) n = n.toLowerCase();
  return n;
}
