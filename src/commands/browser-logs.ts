import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import * as os from 'os';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { verifyMcpConnection, fetchPreviewUrl, readMcpPort } from '../utils/verify.js';
import { writeCompileLog } from '../utils/compile-log.js';
import { ensureCdpCli } from '../utils/dep-check.js';

// browserlogs 命令：通过 cdp-cli 读取 CDP Chrome 中 CocosCreator 预览页的控制台日志
//
// 流程：
//   前置检查（CocosMCP 装/HTTP 跑 + cdp-cli 可用 + CDP Chrome 可达）
//   → cdp-cli console <page> [参数] 读日志
//   → 输出 + 写 JSON log

/** 等待 ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** CDP Chrome 前置检查（不可达则自动启动）*/
async function ensureCdpChrome(): Promise<void> {
  const checkCdp = (): boolean => {
    const r = spawnSync('cdp-cli', ['tabs'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
      timeout: 5000,
    });
    return r.status === 0;
  };

  if (checkCdp()) {
    console.log(chalk.gray('[检查4] CDP Chrome 可达'));
    return;
  }

  console.log(chalk.gray('[检查4] CDP Chrome 不可达，尝试自动启动...'));
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
  const userDataDir = path.join(os.tmpdir(), 'cocoscli-chrome-cdp');
  spawn(
    chromePath,
    ['--remote-debugging-port=9223', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }
  ).unref();
  console.log(chalk.gray('  等待 CDP Chrome 启动（5 秒）...'));
  await sleep(5000);
  if (!checkCdp()) {
    console.log(chalk.red('[检查4] CDP Chrome 自动启动失败'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查4] CDP Chrome 已启动并可达'));
}

/**
 * browserlogs 命令：读取 CDP Chrome 中预览页的控制台日志
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param options { type?, tail?, duration?, all?, grep?, page? }
 */
export async function browserLogs(
  projectDir?: string,
  options: {
    type?: string;
    tail?: number;
    duration?: number;
    all?: boolean;
    grep?: string;
    page?: string;
  } = {}
): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    process.exit(1);
  }

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`浏览器日志（cdp-cli console）`));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}\n`));

  // ===== 前置检查 =====

  // 检查1：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装'));

  // 检查2：MCP HTTP server 跑
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查2] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    process.exit(1);
  }
  console.log(chalk.gray(`[检查2] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 检查3：cdp-cli 可用
  ensureCdpCli();

  // 检查4：CDP Chrome 可达（不可达自动启动）
  await ensureCdpChrome();

  // ===== 确定 page =====

  // 优先用用户指定的 page；否则 cdp-cli tabs 找预览页（找不到中断提示先跑 previewscene）
  let page = options.page ?? '';
  if (!page) {
    // 拿 previewUrl 的 host:port（匹配 tabs 里的 url）
    console.log(chalk.gray('\n获取预览地址...'));
    const previewUrl = await fetchPreviewUrl(mcpPort);
    const previewHost = previewUrl ? (previewUrl.match(/\/\/([^/]+)/)?.[1] ?? '') : '';

    // cdp-cli tabs 列出所有 CDP Chrome 页面
    const tabsResult = spawnSync('cdp-cli', ['tabs'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
      timeout: 5000,
    });
    const tabLines = (tabsResult.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean);
    const tabs = tabLines
      .map((l) => {
        try {
          return JSON.parse(l) as { id: string; title: string; url: string };
        } catch {
          return null;
        }
      })
      .filter((t): t is { id: string; title: string; url: string } => t !== null);

    // 找预览页：url 含 previewHost，或 title 含 Cocos Creator
    const previewPage = tabs.find(
      (t) =>
        (previewHost && t.url && t.url.includes(previewHost)) ||
        (t.title && t.title.toLowerCase().includes('cocos'))
    );

    if (!previewPage) {
      console.log(chalk.red('未找到 CocosCreator 预览页面'));
      console.log(chalk.gray('  请先运行：cocoscli previewscene <场景>'));
      console.log(chalk.gray('  browserlogs 需配合 previewscene 使用（预览页在 CDP Chrome 打开后才能读日志）'));
      if (tabs.length > 0) {
        console.log(chalk.gray(`  当前 CDP 页面：${tabs.map((t) => t.title).join(', ')}`));
      }
      process.exit(1);
    }

    page = previewPage.id;
    console.log(chalk.gray(`找到预览页：${previewPage.title}（${page}）`));
  }

  // ===== 构建 cdp-cli console 参数 =====

  const cdpArgs = ['console', page];

  // --type（过滤日志级别：error/warn/info/log/debug）
  if (options.type) {
    cdpArgs.push('--type', options.type);
  }

  // --tail（只看最后 N 条）
  if (options.all) {
    cdpArgs.push('--all');
  } else if (options.tail !== undefined) {
    cdpArgs.push('--tail', String(options.tail));
  }

  // --duration（收集时长秒，默认 cdp-cli 0.1s）
  if (options.duration !== undefined) {
    cdpArgs.push('--duration', String(options.duration));
  }

  // --verbose（输出完整 JSON，方便解析）
  cdpArgs.push('--verbose');

  console.log(chalk.gray(`\n执行：cdp-cli ${cdpArgs.join(' ')}\n`));

  // ===== 执行 cdp-cli console =====

  const result = spawnSync('cdp-cli', cdpArgs, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true,
    timeout: 30000,
  });

  const output = (result.stdout || '').trim();

  // ===== grep 过滤 =====

  let filteredLines: string[] = [];
  if (output) {
    const allLines = output.split(/\r?\n/).filter(Boolean);
    if (options.grep) {
      // grep 关键词过滤（不区分大小写）
      const grepLower = options.grep.toLowerCase();
      filteredLines = allLines.filter((l) => l.toLowerCase().includes(grepLower));
    } else {
      filteredLines = allLines;
    }
  }

  // ===== 输出 =====

  if (filteredLines.length === 0) {
    console.log(chalk.gray('无日志（可能页面未加载，或无匹配日志）'));
  } else {
    filteredLines.forEach((line) => {
      // 解析 NDJSON，按 type 着色
      try {
        const obj = JSON.parse(line);
        const text = obj.text || obj.message || line;
        const type = obj.type || 'log';
        if (type === 'error') {
          console.log(chalk.red(`[error] ${text}`));
        } else if (type === 'warning' || type === 'warn') {
          console.log(chalk.yellow(`[warn] ${text}`));
        } else {
          console.log(chalk.gray(`[${type}] ${text}`));
        }
      } catch {
        // 非 JSON 行，原样输出
        console.log(line);
      }
    });
  }

  console.log(chalk.gray(`\n共 ${filteredLines.length} 条日志`));

  // ===== 写 JSON log =====

  const logData = {
    command: 'cocoscli browserlogs',
    project: dir,
    timestamp: new Date().toISOString(),
    mcpPort,
    page,
    type: options.type || 'all',
    grep: options.grep || null,
    count: filteredLines.length,
    logs: filteredLines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { text: l };
      }
    }),
  };

  const logPath = writeCompileLog(dir, 'browserlogs-', logData);
  console.log(chalk.gray(`日志已写入：${logPath}`));
}
