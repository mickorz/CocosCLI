import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import {
  verifyMcpConnection,
  fetchPreviewUrl,
  readMcpPort,
  sceneManagementGetList,
  sceneManagementOpen,
} from '../utils/verify.js';

// previewscene 命令：通过 CocosMCP 切换场景 + 获取预览地址
//
// 流程：
//   前置检查（CocosMCP 装/HTTP 跑）
//   → get_list 确认场景存在 + 拿 path
//   → open 切场景
//   → server_information 拿 previewUrl
//   → 输出预览地址

/**
 * previewscene 命令：切换场景并获取预览地址
 *
 * @param scene 场景名（如 loading）
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export async function previewScene(scene: string, projectDir?: string): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!scene) {
    console.log(chalk.red('请指定场景名，例如：cocoscli previewscene <场景> [工程目录]'));
    process.exit(1);
  }

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`预览场景（cocos-mcp）`));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`场景：${scene}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}\n`));

  // ===== 前置检查 =====

  // 检查1：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    console.log(chalk.gray(`  ${cocosMcpDir} 不存在，先跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装'));

  // 检查2：MCP HTTP server 跑
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查2] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  CocosCreator 可能没开，或 CocosMCP 扩展没加载。先跑 cocoscli open。'));
    process.exit(1);
  }
  console.log(chalk.gray(`[检查2] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // ===== 预览流程 =====

  // 1. get_list 确认场景存在 + 拿 path
  console.log(chalk.gray('\n查询场景列表...'));
  const scenes = await sceneManagementGetList(mcpPort);
  if (scenes.length === 0) {
    console.log(chalk.red('工程中无场景'));
    process.exit(1);
  }

  // 匹配场景名（支持 "loading" 或 "loading.scene"）
  const target = scenes.find(
    (s) => s.name === scene || s.name === `${scene}.scene` || s.path === scene
  );
  if (!target) {
    console.log(chalk.red(`场景不存在：${scene}`));
    console.log(chalk.gray(`可用场景：${scenes.map((s) => s.name).join(', ')}`));
    process.exit(1);
  }
  console.log(chalk.gray(`找到场景：${target.name}（${target.path}）`));

  // 2. open 切场景
  console.log(chalk.gray(`切换场景：${target.path}...`));
  const opened = await sceneManagementOpen(mcpPort, target.path);
  if (!opened) {
    console.log(chalk.red(`场景切换失败：${target.path}`));
    process.exit(1);
  }

  // 3. 拿 previewUrl
  console.log(chalk.gray('获取预览地址...'));
  const previewUrl = await fetchPreviewUrl(mcpPort);
  if (!previewUrl) {
    console.log(chalk.yellow('场景已切换，但无法获取 previewUrl（server_information 失败）'));
    process.exit(0);
  }

  // 4. 输出
  console.log(chalk.green(`\n场景已切换：${target.name}`));
  console.log(chalk.green(`预览地址：${previewUrl}`));
  console.log(chalk.gray(`在浏览器打开 ${previewUrl} 即可预览 ${target.name}`));
}
