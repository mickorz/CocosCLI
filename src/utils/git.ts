import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// CocosMCP 扩展克隆流程
//
// cloneCocosMcp(projectPath)
//        ├─> 确保 extensions/ 存在
//        ├─> 检查 extensions/CocosMCP 是否已存在
//        │     ├─> 已存在  返回 exists（跳过）
//        │     └─> 不存在  git clone <url> extensions/CocosMCP
//        └─> 返回 cloned / exists
//
// 注：按确认决策使用普通 git clone，不再使用 git submodule

/** CocosMCP 扩展仓库地址（本地 Gitea） */
export const COCOS_MCP_URL = 'http://127.0.0.1:3000/mickorz/CocosMCP.git';

/** extensions 子目录下 CocosMCP 的目标目录名 */
const COCOS_MCP_DIR = 'CocosMCP';

/**
 * 把 CocosMCP 克隆到 <project>/extensions/CocosMCP
 * 已存在则跳过，否则执行 git clone（普通 clone，不用 submodule）
 *
 * @returns cloned 成功克隆 / exists 已存在跳过
 * @throws git clone 失败时抛错（命令层捕获提示）
 */
export function cloneCocosMcp(projectPath: string): 'cloned' | 'exists' {
  const extensionsDir = path.join(projectPath, 'extensions');
  const targetDir = path.join(extensionsDir, COCOS_MCP_DIR);

  fs.mkdirSync(extensionsDir, { recursive: true });

  if (fs.existsSync(targetDir)) {
    return 'exists';
  }

  execSync(`git clone ${COCOS_MCP_URL} "${targetDir}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return 'cloned';
}
