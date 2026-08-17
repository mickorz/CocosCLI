import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getRegistryPath, readProjects } from '../utils/registry.js';

// list 命令：列出所有执行过 cocoscli init 的工程（读全局 ~/.cocoscli/projects.json）
//
// listProjects()
//        ├─> 配置不存在/空  灰字提示先跑 init
//        ├─> 逐条打印   工程名 / 目录 / CocosMCP 版本 / MCP 端口 / init 时间
//        └─> 目录已不存在  黄字警告（工程可能被删，可手动清理配置）

/** initAt（ISO 8601）转本地可读时间（yyyy-MM-dd HH:mm，确定性格式，不用 locale 相关 API） */
function formatInitAt(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

/**
 * list 命令：打印所有已注册工程
 *
 * 数据来源：init 第八步登记的全局配置（~/.cocoscli/projects.json），
 * remove 第五步会移除对应记录。
 */
export function listProjects(): void {
  const registryPath = getRegistryPath();

  let projects;
  try {
    projects = readProjects(registryPath);
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    console.log(chalk.gray('  请修复或删除该配置文件后重试'));
    process.exit(1);
  }

  if (projects.length === 0) {
    console.log(chalk.gray('暂无已注册工程，先跑 cocoscli init <工程目录>'));
    return;
  }

  console.log(chalk.cyan(`已注册 Cocos 工程（${projects.length} 个，配置：${registryPath}）\n`));
  projects.forEach((p, i) => {
    const name = path.basename(p.dir) || p.dir;
    console.log(`  ${i + 1}. ${name}`);
    console.log(chalk.gray(`     目录：${p.dir}`));
    console.log(
      chalk.gray(
        `     CocosMCP 版本：${p.cocosMcpVersion.padEnd(8)} MCP 端口：${String(p.port).padEnd(6)} init 时间：${formatInitAt(p.initAt)}`
      )
    );
    if (!fs.existsSync(p.dir)) {
      console.log(chalk.yellow('     [警告] 目录已不存在（工程可能已被删除，可手动清理配置文件）'));
    }
  });
}
