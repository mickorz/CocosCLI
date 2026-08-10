import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// CocosMCP 扩展安装与构建
//
// cloneCocosMcp(projectPath)
//        ├─> 确保 extensions/ 存在
//        ├─> extensions/CocosMCP 已存在  返回 exists（跳过，更新走 remove + init）
//        ├─> vendor/CocosMCP 存在  → copy（发布态，prepare-package 打包）
//        ├─> deps/CocosMCP 存在   → copy（开发态，submodule 锁定版本）
//        └─> 都不存在            → fallback git clone GitHub
//
// resolveCocosMcpSource()
//        └─> vendor 优先，deps 兜底，都不存在返回 null
//
// buildCocosMcp(projectPath)
//        └─> npm install + npm run build（生成 dist，否则 CocosCreator 加载报错）

/** CocosMCP 扩展仓库地址（fallback：vendor/deps 都不存在时用，GitHub） */
export const COCOS_MCP_URL = 'https://github.com/mickorz/CocosMCP.git';

/** extensions 子目录下 CocosMCP 的目标目录名 */
export const COCOS_MCP_DIR = 'CocosMCP';

/** 安装结果 */
export interface CloneResult {
  status: 'cloned' | 'exists';
}

/** copy 时排除的顶层目录（.git 锁定无关，node_modules/dist 目标工程重建） */
const COPY_EXCLUDE = /^(\.git|node_modules|dist)([\\/]|$)/;

/**
 * 定位 CocosMCP 源（发布态 vendor 优先，开发态 deps 兜底）
 *
 * git.ts 编译到 dist/utils/git.js，import.meta.url 指向 dist/utils，
 * 上两级到仓库根。src 运行（tsx dev）时同理。
 * 用 package.json 存在性判断源是否就绪（submodule 未初始化时 deps 无 package.json）。
 *
 * @returns 源目录路径，vendor/deps 都不存在时返回 null（调用方 fallback git clone）
 */
export function resolveCocosMcpSource(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  const vendor = path.resolve(root, 'vendor', 'CocosMCP');
  if (fs.existsSync(path.join(vendor, 'package.json'))) {
    return vendor;
  }
  const deps = path.resolve(root, 'deps', 'CocosMCP');
  if (fs.existsSync(path.join(deps, 'package.json'))) {
    return deps;
  }
  return null;
}

/**
 * 把 CocosMCP 装到 <project>/extensions/CocosMCP
 *
 * 优先从 vendor/CocosMCP（发布态）或 deps/CocosMCP（开发态 submodule）copy，
 * 排除 .git/node_modules/dist（版本由 submodule 锁定，dist/node_modules 目标工程重建）。
 * vendor/deps 都不存在时 fallback git clone GitHub。
 * 已存在则跳过（更新走 cocoscli remove + init）。
 *
 * @returns cloned 成功安装 / exists 已存在跳过
 * @throws copy 或 git clone 失败时抛错（命令层捕获提示）
 */
export function cloneCocosMcp(projectPath: string): CloneResult {
  const extensionsDir = path.join(projectPath, 'extensions');
  const targetDir = path.join(extensionsDir, COCOS_MCP_DIR);

  fs.mkdirSync(extensionsDir, { recursive: true });

  if (fs.existsSync(targetDir)) {
    // 已存在 → 跳过（更新走 remove + init）
    return { status: 'exists' };
  }

  const src = resolveCocosMcpSource();
  if (src) {
    // vendor/deps → copy（排除 .git/node_modules/dist）
    fs.cpSync(src, targetDir, {
      recursive: true,
      filter: (s: string) => {
        const rel = s.slice(src.length).replace(/^[\\/]/, '');
        if (!rel) return true; // 根目录本身
        return !COPY_EXCLUDE.test(rel);
      },
    });
    return { status: 'cloned' };
  }

  // fallback：vendor/deps 都不存在，远端 git clone
  execSync(`git clone "${COCOS_MCP_URL}" "${targetDir}"`, {
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
