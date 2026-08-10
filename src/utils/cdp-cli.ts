import { spawnSync, type SpawnSyncReturns, type SpawnSyncOptions } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// cdp-cli 调用工具：优先直接执行 submodule/vendor 内的 dist/index.js
// 不依赖全局 npm link 的 cdp-cli，避免多项目 link 冲突破坏版本锁定
//
// resolveCdpCliEntry()   定位 cdp-cli 入口（vendor 优先，deps 兜底）
// runCdpCliSync(args)   用 node 直接执行 cdp-cli 入口（替代 spawn cdp-cli）
//
// 调用链：
//   runCdpCliSync(['tabs'])
//        └─> spawn(node, [resolveCdpCliEntry(), 'tabs'])
//               ├─> vendor/cdp-cli/dist/index.js（发布态，prepare-package 打包）
//               └─> deps/cdp-cli/dist/index.js（开发态，npm run setup build）

/**
 * 定位 cdp-cli 入口
 *
 * 发布态优先 vendor/cdp-cli/dist/index.js（prepare-package 打包进发布包），
 * 开发态兜底 deps/cdp-cli/dist/index.js（submodule，npm run setup 构建）。
 * 两者都不存在时返回 deps 路径，调用方应 existsSync 检查并提示 npm run setup。
 */
export function resolveCdpCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/utils/cdp-cli.js → 上两级仓库根（src 运行同理）
  const root = path.resolve(here, '..', '..');
  const vendor = path.resolve(root, 'vendor', 'cdp-cli', 'dist', 'index.js');
  if (existsSync(vendor)) {
    return vendor;
  }
  return path.resolve(root, 'deps', 'cdp-cli', 'dist', 'index.js');
}

/**
 * 同步调用 cdp-cli
 *
 * 用 node（process.execPath）直接执行 cdp-cli 入口，
 * 不经过全局 PATH，不受多项目 npm link 冲突影响。
 * shell 强制 false，参数数组原样传递，不会被 shell 拆分。
 *
 * @param args cdp-cli 参数（如 ['tabs']、['console', pageId]）
 * @param options spawnSync 选项（encoding/stdio/timeout 等，透传）
 */
export function runCdpCliSync(
  args: string[],
  options: SpawnSyncOptions & { encoding: BufferEncoding }
): SpawnSyncReturns<string>;
export function runCdpCliSync(
  args: string[],
  options?: SpawnSyncOptions
): SpawnSyncReturns<Buffer>;
export function runCdpCliSync(
  args: string[],
  options: SpawnSyncOptions = {}
): SpawnSyncReturns<Buffer | string> {
  return spawnSync(process.execPath, [resolveCdpCliEntry(), ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
    shell: false,
  });
}
