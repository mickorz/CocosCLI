import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import {
  verifyMcpConnection,
  fetchPreviewUrl,
  readMcpPort,
  sceneManagementGetList,
  sceneManagementOpen,
} from '../utils/verify.js';

// previewscene 命令：CocosMCP 切场景 + cdp-cli 在 CDP Chrome 打开预览
//
// 流程：
//   前置检查（CocosMCP 装/HTTP 跑 + cdp-cli 可用 + CDP Chrome 可达）
//   → scene_management get_list + open（CocosMCP HTTP）
//   → server_information previewUrl（CocosMCP HTTP）
//   → cdp-cli new previewUrl（CDP Chrome 打开预览）
//   → cdp-cli eval typeof window.cc（验证引擎就绪）

/** 等待 ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * previewscene 命令：切换场景 + CDP Chrome 打开预览 + 验证引擎
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
    process.exit(1);
  }

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`预览场景`));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`场景：${scene}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}\n`));

  // ===== 前置检查 =====

  // 检查1：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    console.log(chalk.gray(`  先跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装'));

  // 检查2：MCP HTTP server 跑
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查2] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  先跑 cocoscli open。'));
    process.exit(1);
  }
  console.log(chalk.gray(`[检查2] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 检查3：cdp-cli 可用
  const cdpCheck = spawnSync('cdp-cli', ['--version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: true,
  });
  if (cdpCheck.status !== 0) {
    console.log(chalk.red('[检查3] cdp-cli 不可用（不在 PATH）'));
    console.log(chalk.gray('  安装：npm install -g @myerscarpenter/cdp-cli'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查3] cdp-cli 可用'));

  // 检查4：CDP Chrome 可达（cdp-cli tabs）
  const tabsResult = spawnSync('cdp-cli', ['tabs'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
    timeout: 5000,
  });
  if (tabsResult.status !== 0) {
    console.log(chalk.red('[检查4] CDP Chrome 不可达（cdp-cli tabs 失败）'));
    console.log(chalk.gray('  需启动 Chrome：chrome.exe --remote-debugging-port=9223'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查4] CDP Chrome 可达'));

  // ===== CocosMCP：切场景 + 拿 previewUrl =====

  // 1. get_list 确认场景存在 + 拿 path
  console.log(chalk.gray('\n查询场景列表...'));
  const scenes = await sceneManagementGetList(mcpPort);
  if (scenes.length === 0) {
    console.log(chalk.red('工程中无场景'));
    process.exit(1);
  }

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
    console.log(chalk.red('无法获取 previewUrl（server_information 失败）'));
    process.exit(1);
  }

  // ===== cdp-cli：CDP Chrome 打开预览 + 验证 =====

  // 4. CDP Chrome 打开预览（拿已有页面 id → go 导航，比 new 更可靠）
  console.log(chalk.gray(`\nCDP Chrome 打开预览：${previewUrl}...`));
  const tabsResult2 = spawnSync('cdp-cli', ['tabs'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
    timeout: 5000,
  });
  const tabLines = (tabsResult2.stdout || '').trim().split('\n').filter(Boolean);
  const firstPage = tabLines.length > 0 ? JSON.parse(tabLines[0]) : null;
  if (!firstPage) {
    console.log(chalk.red('CDP Chrome 无可用页面'));
    process.exit(1);
  }
  const pageId = firstPage.id;
  console.log(chalk.gray(`CDP 页面：${firstPage.title}（${pageId}）`));

  const goResult = spawnSync('cdp-cli', ['go', pageId, previewUrl], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true,
    timeout: 30000,
  });
  if (goResult.status !== 0) {
    console.log(chalk.red('CDP 导航预览失败'));
    process.exit(1);
  }

  // 5. 等页面加载 + 验证 window.cc
  console.log(chalk.gray('等待页面加载（3 秒）...'));
  await sleep(3000);

  console.log(chalk.gray('验证 window.cc...'));
  // page 用 localhost 子串匹配（cdp-cli page 参数是 title/id 子串，不是 url）
  // expression 不含空格（shell:true 时空格会拆分成多个参数）
  const evalResult = spawnSync(
    'cdp-cli',
    ['eval', pageId, 'typeof(window.cc)'],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: true,
      timeout: 10000,
    }
  );
  const evalOutput = (evalResult.stdout || '').trim();
  const ccReady = evalOutput.includes('object') || evalOutput.includes('function');

  // ===== 输出 =====
  console.log(chalk.green(`\n场景已切换：${target.name}`));
  console.log(chalk.green(`预览地址：${previewUrl}`));
  if (ccReady) {
    console.log(chalk.green(`引擎就绪：window.cc = ${evalOutput}`));
  } else {
    console.log(chalk.yellow(`引擎可能未就绪：window.cc = ${evalOutput || '(无输出)'}`));
  }
  console.log(chalk.gray(`CDP Chrome 已打开预览，可用 cdp-cli console / eval 进一步操作`));
}
