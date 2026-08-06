import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// CocosMCP 扩展安装与构建
//
// cloneCocosMcp(projectPath)
//        ├─> 确保 extensions/ 存在
//        ├─> extensions/CocosMCP 已存在  返回 exists（跳过）
//        └─> 否则  git clone <url> extensions/CocosMCP
//
// buildCocosMcp(projectPath)
//        └─> npm install + npm run build（生成 dist，否则 CocosCreator 加载报错）

/** CocosMCP 扩展仓库地址（本地 Gitea） */
export const COCOS_MCP_URL = 'http://127.0.0.1:3000/mickorz/CocosMCP.git';

/** extensions 子目录下 CocosMCP 的目标目录名 */
export const COCOS_MCP_DIR = 'CocosMCP';

/** 安装结果 */
export interface CloneResult {
  status: 'cloned' | 'exists';
}

/**
 * 用普通 git clone 把 CocosMCP 装到 <project>/extensions/CocosMCP
 * 已存在则跳过，否则执行 git clone
 *
 * @returns cloned 成功克隆 / exists 已存在跳过
 * @throws git clone 失败时抛错（命令层捕获提示）
 */
export function cloneCocosMcp(projectPath: string): CloneResult {
  const extensionsDir = path.join(projectPath, 'extensions');
  const targetDir = path.join(extensionsDir, COCOS_MCP_DIR);

  fs.mkdirSync(extensionsDir, { recursive: true });

  if (fs.existsSync(targetDir)) {
    return { status: 'exists' };
  }

  execSync(`git clone ${COCOS_MCP_URL} "${targetDir}"`, {
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
export function writeDefaultMcpServerConfig(projectPath: string): 'written' | 'exists' {
  const settingsDir = path.join(projectPath, 'settings');
  const filePath = path.join(settingsDir, MCP_SERVER_FILE);
  fs.mkdirSync(settingsDir, { recursive: true });
  if (fs.existsSync(filePath)) {
    return 'exists';
  }
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_MCP_SERVER_CONFIG, null, 2) + '\n', 'utf-8');
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
