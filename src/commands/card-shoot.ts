import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import { pathToFileURL } from 'url';
import chalk from 'chalk';
import { ensureCdpCli } from '../utils/dep-check.js';
import { runCdpCliSync } from '../utils/cdp-cli.js';

// card shoot 命令：把 doc to card html 产出的单文件卡片页
// 切成每个 section 一张 3 比 4 高清图
//
// 流程：
//   前置 cdp cli 可用 加 CDP Chrome 可达
//   打开 HTML 页
//   viewport 锁 1080 乘 1440 DPR 2 即 setDeviceMetricsOverride
//   逐个 section 舞台化 克隆进 1080 乘 1440 舞台 transform scale 等比缩放
//   截视口 PNG 输出 2160 乘 2880
//
// 截图能力由 cdp cli 的 viewport 与 screenshot 命令提供
// 这两个命令是本次为切图新加到 deps cdp cli 的

/** 等待 ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** CDP Chrome 前置检查（不可达则自动启动），照 browser logs 模式 */
async function ensureCdpChrome(): Promise<void> {
  const checkCdp = (): boolean => {
    const r = runCdpCliSync(['tabs'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return r.status === 0;
  };

  if (checkCdp()) {
    console.log(chalk.gray('[检查2] CDP Chrome 可达'));
    return;
  }

  console.log(chalk.gray('[检查2] CDP Chrome 不可达，尝试自动启动...'));
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
    console.log(chalk.red('[检查2] 找不到 Chrome'));
    console.log(chalk.gray('  请手动启动：chrome --remote-debugging-port=9223'));
    process.exit(1);
  }
  console.log(chalk.gray(`  Chrome：${chromePath}`));
  // 复用 browser logs 的 user data dir，共用同一个 Chrome 实例，避免多开
  const userDataDir = path.join(os.tmpdir(), 'cocoscli-chrome-cdp');
  spawn(
    chromePath,
    ['--remote-debugging-port=9223', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }
  ).unref();
  console.log(chalk.gray('  等待 CDP Chrome 启动（5 秒）...'));
  await sleep(5000);
  if (!checkCdp()) {
    console.log(chalk.red('[检查2] CDP Chrome 自动启动失败'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查2] CDP Chrome 已启动并可达'));
}

// ===== 纯函数（可单测）=====

/** 从 stdout 解析第一行 NDJSON 对象 */
export function parseFirstNdjson(stdout: string): any {
  const lines = stdout.trim().split(/\r?\n/);
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('{')) {
      try {
        return JSON.parse(t);
      } catch {
        // 跳过非 JSON 行
      }
    }
  }
  return null;
}

/** 从 cdp cli new 的输出解析 page id */
export function parsePageId(stdout: string): string | null {
  const obj = parseFirstNdjson(stdout);
  return obj?.data?.id ?? null;
}

/** 从 cdp cli eval 的输出解析 value（eval 的 NDJSON 形如 success value type） */
export function parseEvalValue(stdout: string): unknown {
  const obj = parseFirstNdjson(stdout);
  return obj?.value ?? null;
}

/** 解析测量的 sections（value 可能是 JSON 字符串或已解析数组） */
export function parseSections(evalValue: unknown): { id: string; w: number; h: number }[] {
  let arr: unknown;
  if (typeof evalValue === 'string') {
    try {
      arr = JSON.parse(evalValue);
    } catch {
      return [];
    }
  } else {
    arr = evalValue;
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => !!x && typeof (x as any).id === 'string')
    .map((x) => ({
      id: (x as any).id as string,
      w: Number((x as any).w) || 0,
      h: Number((x as any).h) || 0,
    }));
}

/** 生成测量所有 section 宽高的 JS */
export function buildMeasureScript(): string {
  return "JSON.stringify([...document.querySelectorAll('section.card')].map(s=>({id:s.id,w:s.offsetWidth,h:s.offsetHeight})))";
}

/** 生成把指定 section 舞台化（克隆进 W 乘 H 舞台，等比缩放）的 JS */
export function buildStageScript(sectionId: string, width: number, height: number): string {
  const idLit = JSON.stringify(sectionId);
  return [
    '(function(){',
    "document.querySelectorAll('.shoot-stage').forEach(function(e){e.remove();});",
    "var sec=document.querySelector('#' + " + idLit + ');',
    'if(!sec) return JSON.stringify({error:"section not found: "+' + idLit + '});',
    'var sw=sec.offsetWidth, sh=sec.offsetHeight;',
    'var k=Math.min(' + width + '/sw, ' + height + '/sh);',
    "var stage=document.createElement('div');",
    "stage.className='shoot-stage';",
    "stage.style.cssText='position:fixed;inset:0;width:" + width + 'px;height:' + height + "px;background:var(--bg);overflow:hidden;display:flex;justify-content:center;z-index:99999;';",
    "var wrap=document.createElement('div');",
    "wrap.style.cssText='transform:scale('+k+');transform-origin:top center;width:'+sw+'px;';",
    'wrap.appendChild(sec.cloneNode(true));',
    'stage.appendChild(wrap);',
    'document.body.appendChild(stage);',
    'return JSON.stringify({k:k, sw:sw, sh:sh});',
    '})()',
  ].join('');
}

/** 生成清理舞台的 JS */
export function buildCleanupScript(): string {
  return "document.querySelectorAll('.shoot-stage').forEach(function(e){e.remove();}); 'ok'";
}

/**
 * 计算截图 clip.scale 以抵消系统 DPR。
 *
 * 桌面 Chrome 下 Emulation.setDeviceMetricsOverride 的 deviceScaleFactor 不生效，
 * captureScreenshot 实际像素 = CSS 尺寸 × 系统 DPR × clip.scale。
 * 要让输出 = CSS 尺寸 × 目标 DPR，取 clip.scale = 目标 DPR / 系统 DPR。
 */
export function computeClipScale(targetDpr: number, sysDpr: number): number {
  if (!sysDpr || sysDpr <= 0) return targetDpr;
  return targetDpr / sysDpr;
}

// ===== 命令主流程 =====

/**
 * card shoot 命令：把卡片页 HTML 切成每 section 一张 3 比 4 高清图
 *
 * @param html 卡片页 HTML 路径，默认 cocoscli card.html
 * @param out 输出目录，默认 cards
 * @param options width height dpr sections
 */
export async function cardShoot(
  html?: string,
  out?: string,
  options: { width?: number; height?: number; dpr?: number; sections?: string } = {}
): Promise<void> {
  const htmlPath = path.resolve(html ?? 'cocoscli-card.html');
  const outDir = path.resolve(out ?? 'cards');
  const width = options.width ?? 1080;
  const height = options.height ?? 1440;
  const dpr = options.dpr ?? 2;
  const sectionFilter = options.sections
    ? options.sections.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  if (!fs.existsSync(htmlPath)) {
    console.log(chalk.red(`卡片页不存在：${htmlPath}`));
    process.exit(1);
  }

  console.log(chalk.cyan('卡片页切图（cdp-cli）'));
  console.log(chalk.gray(`HTML：${htmlPath}`));
  console.log(chalk.gray(`输出：${outDir}`));
  console.log(chalk.gray(`尺寸：${width}x${height} DPR${dpr}（像素 ${width * dpr}x${height * dpr}）\n`));

  // 检查1：cdp-cli 可用
  ensureCdpCli();

  // 检查2：CDP Chrome 可达
  await ensureCdpChrome();

  // 打开 HTML 页（每次新开 tab）
  const fileUrl = pathToFileURL(htmlPath).href;
  console.log(chalk.gray(`\n打开页面：${fileUrl}`));
  const newRes = runCdpCliSync(['new', fileUrl], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  if (newRes.status !== 0) {
    console.log(chalk.red('打开页面失败'));
    console.log(chalk.gray(newRes.stderr || newRes.stdout || ''));
    process.exit(1);
  }
  const pageId = parsePageId(newRes.stdout || '');
  if (!pageId) {
    console.log(chalk.red('无法获取 page id'));
    console.log(chalk.gray(newRes.stdout || ''));
    process.exit(1);
  }
  console.log(chalk.gray(`page id：${pageId}`));

  // 等待页面渲染
  await sleep(800);

  // 锁视口（Emulation.setDeviceMetricsOverride）
  console.log(chalk.gray(`\n锁定视口 ${width}x${height} DPR${dpr}`));
  const vpRes = runCdpCliSync(['viewport', pageId, String(width), String(height), '--dpr', String(dpr)], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  if (vpRes.status !== 0) {
    console.log(chalk.red('设置视口失败'));
    console.log(chalk.gray(vpRes.stderr || vpRes.stdout || ''));
    process.exit(1);
  }
  // 设视口后等一帧重排
  await sleep(400);

  // 读取系统 DPR：setDeviceMetricsOverride 的 deviceScaleFactor 在桌面 Chrome 不生效，
  // 改用 screenshot 的 clip.scale 抵消系统缩放，达到目标 DPR 的像素输出
  const dprRes = runCdpCliSync(['eval', pageId, 'window.devicePixelRatio'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  if (dprRes.status !== 0) {
    console.log(chalk.red('读取系统 DPR 失败'));
    console.log(chalk.gray(dprRes.stderr || dprRes.stdout || ''));
    process.exit(1);
  }
  const sysDpr = Number(parseEvalValue(dprRes.stdout || '')) || 1;
  const clipScale = computeClipScale(dpr, sysDpr);
  console.log(chalk.gray(`系统 DPR ${sysDpr}，clip scale ${clipScale.toFixed(4)}（目标 DPR ${dpr}）\n`));

  // 测量 sections
  const measureRes = runCdpCliSync(['eval', pageId, buildMeasureScript()], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  if (measureRes.status !== 0) {
    console.log(chalk.red('测量 sections 失败'));
    console.log(chalk.gray(measureRes.stderr || measureRes.stdout || ''));
    process.exit(1);
  }
  let sections = parseSections(parseEvalValue(measureRes.stdout || ''));
  if (sectionFilter) {
    sections = sections.filter((s) => sectionFilter.includes(s.id));
  }
  if (sections.length === 0) {
    console.log(chalk.red('未找到 section.card 节点（确认 HTML 是 doc-to-card-html 产物）'));
    process.exit(1);
  }
  console.log(chalk.gray(`找到 ${sections.length} 个 section：${sections.map((s) => s.id).join(', ')}\n`));

  // 准备输出目录
  fs.mkdirSync(outDir, { recursive: true });

  // 逐个 section 舞台化 加 截视口 加 清理
  const outputs: string[] = [];
  sections.forEach((s, i) => {
    const no = String(i + 1).padStart(2, '0');
    const outFile = path.join(outDir, `${no}-${s.id}.png`);

    // 舞台化
    const stageRes = runCdpCliSync(['eval', pageId, buildStageScript(s.id, width, height)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    if (stageRes.status !== 0) {
      console.log(chalk.red(`[${no}] 舞台化失败：${s.id}`));
      console.log(chalk.gray(stageRes.stderr || stageRes.stdout || ''));
      process.exit(1);
    }
    const stageInfoRaw = parseEvalValue(stageRes.stdout || '');
    // 截视口（用 clip.scale 抵消系统 DPR，输出 W 乘 目标DPR 乘 H 乘 目标DPR 像素）
    const shotRes = runCdpCliSync(
      ['screenshot', pageId, outFile, '--format', 'png', '--clip', `0,0,${width},${height},${clipScale.toFixed(6)}`],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      }
    );
    if (shotRes.status !== 0) {
      console.log(chalk.red(`[${no}] 截图失败：${s.id}`));
      console.log(chalk.gray(shotRes.stderr || shotRes.stdout || ''));
      process.exit(1);
    }
    // 清理舞台（为下一个 section 准备）
    runCdpCliSync(['eval', pageId, buildCleanupScript()], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });

    outputs.push(outFile);
    let scaleInfo = '';
    if (typeof stageInfoRaw === 'string') {
      try {
        const o = JSON.parse(stageInfoRaw);
        if (o && typeof o.k === 'number') {
          scaleInfo = ` scale ${o.k.toFixed(3)} (${o.sw}x${o.sh})`;
        }
      } catch {
        // 忽略解析失败
      }
    }
    console.log(chalk.green(`[${no}] ${s.id} -> ${path.relative(process.cwd(), outFile)}${scaleInfo}`));
  });

  console.log(chalk.cyan(`\n[完成] 共输出 ${outputs.length} 张图到 ${outDir}`));
}
