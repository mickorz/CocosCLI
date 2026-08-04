import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// CocosMCP 扩展安装流程
//
// cloneCocosMcp(projectPath)
//        ├─> 父工程是 git 仓库？
//        │     ├─> 是  git submodule add（生成 .gitmodules，纳入父仓库）
//        │     │     ├─> 已注册为 submodule      返回 exists
//        │     │     ├─> 已存在但非 submodule    报错（让用户手动删）
//        │     │     └─> 否则                    git submodule add
//        │     └─> 否  普通 git clone（不依赖 git）
//        └─> 返回 { status, method }

/** CocosMCP 扩展仓库地址（本地 Gitea） */
export const COCOS_MCP_URL = 'http://127.0.0.1:3000/mickorz/CocosMCP.git';

/** extensions 子目录下 CocosMCP 的目标目录名 */
const COCOS_MCP_DIR = 'CocosMCP';

/** 安装结果 */
export interface CloneResult {
  status: 'cloned' | 'exists';
  method: 'submodule' | 'clone';
}

/**
 * 判断目录是否 git 仓库
 */
export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断某子路径是否已注册为 submodule（.gitmodules 含该 path）
 */
function isSubmoduleRegistered(projectPath: string, subPath: string): boolean {
  try {
    const out = execSync('git config -f .gitmodules --get-regexp path', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes(subPath);
  } catch {
    return false; // .gitmodules 不存在或未注册
  }
}

/**
 * 安装 CocosMCP 到 <project>/extensions/CocosMCP
 *
 * - 父工程是 git 仓库：用 git submodule add（生成 .gitmodules）
 * - 父工程不是 git 仓库：用普通 git clone
 *
 * @throws 父工程是 git 但 extensions/CocosMCP 已存在且不是 submodule 时抛错
 *         （提示用户手动删除后重试）
 */
export function cloneCocosMcp(projectPath: string): CloneResult {
  const extensionsDir = path.join(projectPath, 'extensions');
  const targetDir = path.join(extensionsDir, COCOS_MCP_DIR);
  const subPath = `extensions/${COCOS_MCP_DIR}`;

  fs.mkdirSync(extensionsDir, { recursive: true });

  if (isGitRepo(projectPath)) {
    // 已注册为 submodule → 跳过
    if (isSubmoduleRegistered(projectPath, subPath)) {
      return { status: 'exists', method: 'submodule' };
    }
    // 已存在但不是注册的 submodule（如旧的普通 clone）→ 报错让用户手动删
    if (fs.existsSync(targetDir)) {
      throw new Error(
        `extensions/CocosMCP 已存在但不是 git submodule，请先手动删除该目录后重试：${targetDir}`
      );
    }
    execSync(`git submodule add ${COCOS_MCP_URL} "${subPath}"`, {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 'cloned', method: 'submodule' };
  }

  // 非 git 仓库：普通 clone
  if (fs.existsSync(targetDir)) {
    return { status: 'exists', method: 'clone' };
  }
  execSync(`git clone ${COCOS_MCP_URL} "${targetDir}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: 'cloned', method: 'clone' };
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
