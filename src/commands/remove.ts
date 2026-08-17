import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { createSpinner, spinnerSucceed, spinnerFail } from '../utils/spinner.js';
import { findCocosProcesses, isProjectMatch, killProcess } from '../utils/process.js';
import { isCocosProject } from '../utils/project.js';
import { COCOS_MCP_DIR, MCP_SERVER_FILE, TOOL_MANAGER_FILE } from '../utils/git.js';
import { getRegistryPath, removeProject } from '../utils/registry.js';

// remove 命令：卸载 CocosMCP（init 的逆操作）
//
// remove(dir)
//        ├─> 第一步 关闭工程进程（如果在运行）
//        ├─> 第二步 删除 extensions/CocosMCP
//        ├─> 第三步 删除 settings/mcp-server.json
//        ├─> 第四步 删除 settings/tool-manager.json
//        └─> 第五步 从全局工程列表移除（~/.cocoscli/projects.json，init 第八步的逆操作）

/**
 * remove 命令：卸载 CocosMCP（init 的逆操作）
 *
 * 五步流程：
 *   1. 关闭工程对应进程（如果在运行）
 *   2. 删除 extensions/CocosMCP
 *   3. 删除 settings/mcp-server.json
 *   4. 删除 settings/tool-manager.json
 *   5. 从全局工程列表移除（~/.cocoscli/projects.json）
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export function remove(projectDir?: string): void {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  console.log(chalk.cyan(`开始卸载 ${dir} 的 CocosMCP\n`));

  // 第一步：关闭工程进程（如果在运行）
  console.log(chalk.blue('第一步 关闭工程进程'));
  const procs = findCocosProcesses();
  const hits = procs.filter((p) => isProjectMatch(p.command, dir));
  if (hits.length === 0) {
    console.log(chalk.gray('  工程未在运行，跳过'));
  } else {
    for (const p of hits) {
      console.log(chalk.gray(`  关闭进程 PID ${p.pid}`));
      try {
        killProcess(p.pid);
      } catch (e) {
        console.log(chalk.red(`  关闭 PID ${p.pid} 失败：${e instanceof Error ? e.message : e}`));
      }
    }
    console.log(chalk.green(`  已关闭 ${hits.length} 个进程`));
  }

  // 第二步：删除 extensions/CocosMCP
  console.log(chalk.blue('\n第二步 删除 extensions/CocosMCP'));
  removeDir(path.join(dir, 'extensions', COCOS_MCP_DIR), 'extensions/CocosMCP');

  // 第三步：删除 settings/mcp-server.json
  console.log(chalk.blue('\n第三步 删除 settings/mcp-server.json'));
  removeFile(path.join(dir, 'settings', MCP_SERVER_FILE), 'settings/mcp-server.json');

  // 第四步：删除 settings/tool-manager.json
  console.log(chalk.blue('\n第四步 删除 settings/tool-manager.json'));
  removeFile(path.join(dir, 'settings', TOOL_MANAGER_FILE), 'settings/tool-manager.json');

  // 第五步：从全局工程列表移除（init 第八步的逆操作）。
  // 注销失败不 exit（卸载主体已完成），红字提示配置文件路径
  console.log(chalk.blue('\n第五步 从全局工程列表移除'));
  try {
    const removed = removeProject(getRegistryPath(), dir);
    console.log(chalk.gray(removed ? '  已从全局工程列表移除' : '  全局工程列表无此记录，跳过'));
  } catch (e) {
    console.log(chalk.red('  从全局工程列表移除失败'));
    console.log(chalk.red(`  ${e instanceof Error ? e.message : e}`));
  }

  console.log(chalk.green('\nCocosMCP 卸载完成'));
}

/** 删除目录（不存在则跳过） */
function removeDir(dirPath: string, label: string): void {
  if (!fs.existsSync(dirPath)) {
    console.log(chalk.gray(`  ${label} 不存在，跳过`));
    return;
  }
  const spinner = createSpinner('  删除中（含 node_modules，可能稍慢）...').start();
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    spinnerSucceed(spinner, `  已删除 ${label}`);
  } catch (e) {
    spinnerFail(spinner, `  删除 ${label} 失败`);
    console.log(chalk.red(`  ${e instanceof Error ? e.message : e}`));
    process.exit(1);
  }
}

/** 删除单个文件（不存在则跳过） */
function removeFile(filePath: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    console.log(chalk.gray(`  ${label} 不存在，跳过`));
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
    console.log(chalk.gray(`  已删除 ${label}`));
  } catch (e) {
    console.log(chalk.red(`  删除 ${label} 失败：${e instanceof Error ? e.message : e}`));
  }
}
