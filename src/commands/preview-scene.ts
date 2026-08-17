import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import {
  verifyMcpConnection,
  warnProxyIfLoopbackBlocked,
  fetchPreviewUrl,
  readMcpPort,
  sceneManagementGetList,
  sceneManagementOpen,
} from '../utils/verify.js';
import { ensureCdpCli } from '../utils/dep-check.js';
import { runCdpCliSync } from '../utils/cdp-cli.js';
import { checkCocosMcpDeps } from '../utils/git.js';

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

  // 检查1：CocosMCP 已装（目录 + node_modules 运行时依赖）
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    console.log(chalk.gray(`  先跑 cocoscli init。`));
    process.exit(1);
  }
  const deps = checkCocosMcpDeps(cocosMcpDir);
  if (!deps.ok) {
    console.log(chalk.red(`[检查1] CocosMCP node_modules 缺失（${deps.missing.join(', ')}）`));
    console.log(chalk.gray(`  编辑器面板会报 Cannot find module，MCP HTTP server 起不来。`));
    console.log(chalk.gray(`  在 ${cocosMcpDir} 跑 npm install，或重跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装且依赖齐全'));

  // 检查2：MCP HTTP server 跑
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查2] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  先跑 cocoscli open。'));
    warnProxyIfLoopbackBlocked();
    process.exit(1);
  }
  console.log(chalk.gray(`[检查2] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 检查3：cdp-cli 可用
  ensureCdpCli();

  // 检查4：CDP Chrome 可达（不可达则自动启动 Chrome --remote-debugging-port=9223）
  const checkCdp = (): boolean => {
    const r = runCdpCliSync(['tabs'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return r.status === 0;
  };

  if (checkCdp()) {
    console.log(chalk.gray('[检查4] CDP Chrome 可达'));
  } else {
    console.log(chalk.gray('[检查4] CDP Chrome 不可达，尝试自动启动...'));
    // 找 Chrome 可执行文件
    const chromePaths =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : process.platform === 'darwin'
          ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
          : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
    const chromePath = chromePaths.find((p) => fs.existsSync(p));
    if (!chromePath) {
      console.log(chalk.red('[检查4] 找不到 Chrome'));
      console.log(chalk.gray('  请手动启动：chrome --remote-debugging-port=9223'));
      process.exit(1);
    }
    console.log(chalk.gray(`  Chrome：${chromePath}`));
    // 启动 Chrome（后台，独立 user-data-dir 避免和用户 Chrome 冲突）
    const userDataDir = path.join(os.tmpdir(), 'cocoscli-chrome-cdp');
    spawn(
      chromePath,
      [
        '--remote-debugging-port=9223',
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore' }
    ).unref();
    console.log(chalk.gray('  等待 CDP Chrome 启动（5 秒）...'));
    await sleep(5000);
    if (!checkCdp()) {
      console.log(chalk.red('[检查4] CDP Chrome 自动启动失败'));
      console.log(chalk.gray('  请手动启动：chrome --remote-debugging-port=9223'));
      process.exit(1);
    }
    console.log(chalk.gray('[检查4] CDP Chrome 已启动并可达'));
  }

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

  // 2. open 切场景（30 秒超时兜底，防编辑器切大场景卡死）
  console.log(chalk.gray(`切换场景：${target.path}（超时 30 秒）...`));
  const openResult = await sceneManagementOpen(mcpPort, target.path);
  if (openResult === 'timeout') {
    console.log(chalk.red(`场景切换超时（30 秒未响应）：${target.path}`));
    console.log(chalk.gray('  可能场景过大或编辑器卡顿；可重试，或检查 CocosCreator 是否正常响应。'));
    process.exit(1);
  }
  if (openResult !== 'success') {
    console.log(chalk.red(`场景切换失败：${target.path}（编辑器返回失败）`));
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
  const tabsResult2 = runCdpCliSync(['tabs'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
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

  const goResult = runCdpCliSync(['go', pageId, previewUrl], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
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
  // shell:false，参数数组原样传递，不会被 shell 拆分
  const evalResult = runCdpCliSync(
    ['eval', pageId, 'typeof(window.cc)'],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
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
