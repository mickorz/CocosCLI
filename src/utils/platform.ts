import * as os from 'os';
import * as path from 'path';

/**
 * 平台判断工具
 *
 * 提供当前平台、是否 Windows / macOS、用户主目录等基础判断，
 * 供 cocos / process 等模块按平台分支使用。
 */

/**
 * 获取当前平台（暴露为函数便于测试注入）
 */
export function getPlatform(): NodeJS.Platform {
  return os.platform();
}

/**
 * 是否 Windows
 */
export function isWindows(platform: NodeJS.Platform = getPlatform()): boolean {
  return platform === 'win32';
}

/**
 * 是否 macOS
 */
export function isMac(platform: NodeJS.Platform = getPlatform()): boolean {
  return platform === 'darwin';
}

/**
 * 是否 Linux
 */
export function isLinux(platform: NodeJS.Platform = getPlatform()): boolean {
  return platform === 'linux';
}

/**
 * 获取用户主目录
 */
export function getHomeDir(): string {
  return os.homedir();
}

/**
 * 获取本地配置目录（存放 cocoscli.json 等本地配置）
 * Windows: %APPDATA%/cocoscli
 * macOS:   ~/Library/Application Support/cocoscli
 * Linux:   ~/.config/cocoscli
 */
export function getConfigDir(platform: NodeJS.Platform = getPlatform()): string {
  if (isWindows(platform)) {
    const appData = process.env.APPDATA ?? path.join(getHomeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'cocoscli');
  }
  if (isMac(platform)) {
    return path.join(getHomeDir(), 'Library', 'Application Support', 'cocoscli');
  }
  // Linux 及其它类 Unix
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(getHomeDir(), '.config');
  return path.join(xdg, 'cocoscli');
}
