import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// CocosMCP 扩展安装与构建
//
// cloneCocosMcp(projectPath)
//        ├─> 确保 extensions/ 存在
//        ├─> extensions/CocosMCP 已存在  返回 exists（跳过，更新走 remove + init）
//        └─> 否则 优先从 deps/CocosMCP（submodule 锁定版本）clone
//                 deps 不存在（全局安装无 submodule）时 fallback 远端 URL
//
// resolveDepsCocosMcp()
//        └─> 基于 import.meta.url 定位仓库内 deps/CocosMCP
//
// buildCocosMcp(projectPath)
//        └─> npm install + npm run build（生成 dist，否则 CocosCreator 加载报错）

/** CocosMCP 扩展仓库地址（fallback：deps 不存在时用，本地 Gitea） */
export const COCOS_MCP_URL = 'http://127.0.0.1:3000/mickorz/CocosMCP.git';

/** extensions 子目录下 CocosMCP 的目标目录名 */
export const COCOS_MCP_DIR = 'CocosMCP';

/** 安装结果 */
export interface CloneResult {
  status: 'cloned' | 'exists';
}

/**
 * 定位 CocosCLI 仓库内的 deps/CocosMCP（submodule）
 *
 * git.ts 编译到 dist/utils/git.js，import.meta.url 指向 dist/utils，
 * 上两级到仓库根再进 deps/CocosMCP。src 运行（tsx dev）时同理。
 *
 * 全局 npm 安装（package files 不含 deps）时此路径不存在，
 * 调用方应 fallback 远端 clone。
 */
export function resolveDepsCocosMcp(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'deps', 'CocosMCP');
}

/**
 * 把 CocosMCP 装到 <project>/extensions/CocosMCP
 *
 * 优先从 deps/CocosMCP（submodule 锁定版本）clone 到目标工程，
 * deps 不存在（全局安装无 submodule）时 fallback 远端 COCOS_MCP_URL。
 * 已存在则跳过（submodule 版本锁定，更新走 cocoscli remove + init）。
 *
 * @returns cloned 成功克隆 / exists 已存在跳过
 * @throws git clone 失败时抛错（命令层捕获提示）
 */
export function cloneCocosMcp(projectPath: string): CloneResult {
  const extensionsDir = path.join(projectPath, 'extensions');
  const targetDir = path.join(extensionsDir, COCOS_MCP_DIR);

  fs.mkdirSync(extensionsDir, { recursive: true });

  if (fs.existsSync(targetDir)) {
    // 已存在 → 跳过（submodule 版本锁定，git pull 无意义，更新走 remove + init）
    return { status: 'exists' };
  }

  // 优先从本地 deps/CocosMCP（submodule）clone，版本锁定到当前 commit
  const depsCocosMcp = resolveDepsCocosMcp();
  const src = fs.existsSync(depsCocosMcp) ? depsCocosMcp : COCOS_MCP_URL;

  execSync(`git clone "${src}" "${targetDir}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: 'cloned' };
}

/**
 * 构建 CocosMCP 扩展（npm install + npm run build）
 *
 * CocosMCP 是 TypeScript 源码扩展，clone 下来没有 dist，
 * 必须 build 才会生成 dist/main.js、dist/scene.js 等，否则 CocosCreator 加载报错。
 *
 * @throws 目录不存在或 npm install/build 失败时抛错
 */
export function buildCocosMcp(projectPath: string): void {
  const extDir = path.join(projectPath, 'extensions', COCOS_MCP_DIR);
  if (!fs.existsSync(extDir)) {
    throw new Error(`CocosMCP 目录不存在：${extDir}`);
  }
  execSync('npm install --no-fund --no-audit', { cwd: extDir, stdio: 'inherit' });
  execSync('npm run build', { cwd: extDir, stdio: 'inherit' });
}

/** 默认 mcp-server.json 配置（CocosMCP 扩展服务器设置） */
const DEFAULT_MCP_SERVER_CONFIG = {
  port: 3001,
  autoStart: true,
  debugLog: false,
  maxConnections: 10,
};

/** CocosMCP 在 settings/ 下读取的配置文件名（init 写默认，remove 删除） */
export const MCP_SERVER_FILE = 'mcp-server.json';

/** CocosMCP 工具管理器配置文件名（扩展自动生成，remove 清理） */
export const TOOL_MANAGER_FILE = 'tool-manager.json';

/**
 * 写入默认 mcp-server.json 到 <project>/settings/
 * 已存在则跳过（不覆盖用户已改的配置）
 *
 * @returns written 已写入 / exists 已存在跳过
 */
export function writeDefaultMcpServerConfig(projectPath: string, port = 3001): 'written' | 'exists' {
  const settingsDir = path.join(projectPath, 'settings');
  const filePath = path.join(settingsDir, MCP_SERVER_FILE);
  fs.mkdirSync(settingsDir, { recursive: true });
  if (fs.existsSync(filePath)) {
    return 'exists';
  }
  fs.writeFileSync(filePath, JSON.stringify({ ...DEFAULT_MCP_SERVER_CONFIG, port }, null, 2) + '\n', 'utf-8');
  return 'written';
}

/** 工程根 opencode.json 文件名（opencode 项目配置） */
const OPENCODE_CONFIG_FILE = 'opencode.json';

/** 默认 opencode.json 配置：放开 external_directory 权限，避免 opencode 访问工程外目录时被 auto-reject */
const DEFAULT_OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    external_directory: 'allow',
  },
};

/**
 * 写默认 opencode.json 到工程根（放开 external_directory 权限，供 verify 使用）
 * 已存在则跳过（不覆盖用户配置）
 *
 * @returns written 已写入 / exists 已存在跳过
 */
export function writeOpencodePermission(projectPath: string): 'written' | 'exists' {
  const filePath = path.join(projectPath, OPENCODE_CONFIG_FILE);
  if (fs.existsSync(filePath)) {
    return 'exists';
  }
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_OPENCODE_CONFIG, null, 2) + '\n', 'utf-8');
  return 'written';
}
