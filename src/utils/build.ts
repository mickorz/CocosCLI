import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { getCocosCreatorPath } from './cocos.js';
import { writeCompileLog } from './compile-log.js';
import { killProcess } from './process.js';

// 工程构建流程（cocoscli 内置，不依赖 autobuild 脚本）
//
// buildProject(projectPath, platform)
//        ├─> normalizePlatform()      简称 → Cocos 原生 platform
//        ├─> getCocosCreatorPath()    复用 5 级查找
//        ├─> generateBuildConfig()    生成通用默认 buildConfig（不含 scenes）
//        ├─> 写到 <project>/.cocoscli/buildConfig-<platform>.json
//        ├─> spawn CocosCreator --project <project> --build configPath=<相对路径>
//        │     ├─> stdout/stderr 实时 tee 到终端（保持原 inherit 的可见性）
//        │     └─> 同步收集全部输出行 → summarizeBuildErrors 提取报错（分类+去重计数）
//        ├─> 原始全文落盘 .cocoscli/build-raw-<ts>.log
//        ├─> 结构化结果落盘 .cocoscli/build-log-<ts>.json（与 compile-log/eslint-log 同消费风格）
//        └─> 校验产物目录（存在且有本次构建新写入的文件，防止旧产物误报成功）
//
// 实现依据：autoBuild/build_helper.js（mahjong 工程），核心命令为
//   CocosCreator.exe --project <工程> --build "configPath=<buildConfig.json>"
//
// fast 模式（--fast）：只检查脚本编译，不求产物。
// 实测（mahjong 工程）：脚本错误（语法/模块/运行时）在 build Task 开始后 ~20 秒内全部出现，
// 之后的资源打包与工程自定义 build-script（~46 秒）对脚本检查是纯浪费，
// 所以 fast 在「Build project script start」标记行出现后主动 kill 进程树（按 PID，taskkill /T /F）。
//
// 注意：Cocos 构建不做类型检查（babel/rollup 只转换不检查），
// 类型错误需用 cocoscli compile（tsc）才能抓到，build-log 只含语法/模块/运行时错误。

/** 平台简称 → Cocos 原生 platform 映射 */
const PLATFORM_ALIASES: Record<string, string> = {
  web: 'web-desktop',
  'web-desktop': 'web-desktop',
  'web-mobile': 'web-mobile',
  wechat: 'wechatgame',
  wechatgame: 'wechatgame',
  douyin: 'bytedancegame',
  bytedance: 'bytedancegame',
  bytedancegame: 'bytedancegame',
};

/** cocoscli 在工程内放 buildConfig / 日志的目录 */
const COCOSCLI_BUILD_DIR = '.cocoscli';

/** 报错 message 截断长度（URL 编码的错误行解码后可能非常长） */
const MAX_MESSAGE_LEN = 300;

/** 结构化日志中最多保留的报错类数（防止日志爆炸） */
const MAX_ERROR_ITEMS = 200;

/** 构建结果 */
export interface BuildResult {
  success: boolean;
  outputDir?: string;
  message: string;
  /** 构建耗时（毫秒） */
  durationMs: number;
  /** CocosCreator 进程退出码（spawn 失败 / fast 提前终止时为 null） */
  exitCode: number | null;
  /** 结构化 build-log JSON 路径 */
  logPath?: string;
  /** 原始全文 log 路径 */
  rawLogPath?: string;
  /** 命中的报错行总数（含重复，已剔除被忽略分类） */
  errorLineCount: number;
  /** 被忽略分类过滤掉的报错行数（含重复；未指定 --ignore-category 时为 0） */
  ignoredErrorCount: number;
  /** 去重后的报错聚合（已剔除被忽略分类；按重复次数降序在命令层展示） */
  errors: BuildErrorItem[];
  /** fast 模式标记 */
  fast?: boolean;
  /** fast 模式下是否已在脚本阶段结束后提前终止进程 */
  aborted?: boolean;
}

/** 报错分类（syntax/module/runtime/editor） */
export type BuildErrorCategory = BuildErrorItem['category'];

/** 合法报错分类列表（--ignore-category 参数校验用） */
export const BUILD_ERROR_CATEGORIES: BuildErrorCategory[] = ['syntax', 'module', 'runtime', 'editor', 'other'];

/** 单类构建报错（同类去重计数，与 compile-log/eslint-log 同消费风格） */
export interface BuildErrorItem {
  category: 'syntax' | 'module' | 'runtime' | 'editor' | 'other';
  message: string;   // 清洗后的可读信息（截断到 300 字符）
  count: number;     // 重复出现次数
  firstLine: number; // 首次出现行号（对应 build-raw log 的 1-based 行号）
}

/**
 * 规范化平台名：简称 → Cocos 原生 platform
 * 未识别的名称原样返回（交给 CocosCreator 报错）
 */
export function normalizePlatform(input: string): string {
  return PLATFORM_ALIASES[input.toLowerCase()] ?? input;
}

/**
 * 生成通用默认 buildConfig（不含 scenes/startScene 等工程特定字段）
 * CocosCreator 会用默认主场景与默认参数补全
 */
export function generateBuildConfig(platform: string): Record<string, unknown> {
  return {
    platform,
    buildPath: 'project://build',
    debug: false,
    md5Cache: true,
    skipCompressTexture: false,
    sourceMaps: false,
    polyfills: { asyncFunctions: true },
    experimentalEraseModules: false,
    useBuiltinServer: false,
    mainBundleIsRemote: false,
    mainBundleCompressionType: 'merge_dep',
    useSplashScreen: false,
    packAutoAtlas: true,
    outputName: platform,
    packages: {},
  };
}

/**
 * 生成 fast 模式 buildConfig：只检查脚本编译，砍掉资源打包开销
 *
 * 与默认配置的差异（每项都只影响打包阶段，不影响脚本编译检查）：
 * - debug: true           跳过压缩混淆（minify）
 * - md5Cache: false       跳过 md5 计算
 * - skipCompressTexture: true  跳过纹理压缩
 * - packAutoAtlas: false  跳过自动图集打包
 * - outputName: <platform>-fast  独立产物目录，不覆盖正式构建产物
 */
export function generateFastBuildConfig(platform: string): Record<string, unknown> {
  return {
    ...generateBuildConfig(platform),
    debug: true,
    md5Cache: false,
    skipCompressTexture: true,
    packAutoAtlas: false,
    outputName: `${platform}-fast`,
  };
}

/**
 * fast 模式早退标记：该行出现说明脚本编译阶段已结束、即将进入工程自定义 build-script
 * （实测冷/热两种日志均在「全部脚本错误出现之后」才打印此行，作为收尾边界是安全的）
 */
export function isFastAbortMarker(line: string): boolean {
  return /Build project script start|Run build task\(build-script\)/.test(line);
}

/**
 * 清洗报错行 → 可读 message
 *
 * 两步处理：
 * 1. 去 ANSI 颜色码
 * 2. Programming 面板的语法错误是 data:text/javascript URL 编码的 throw new Error(...)，
 *    解码还原出人话（"SyntaxError: xxx.ts: Unexpected token ..."），失败则原样截断
 */
export function cleanBuildErrorLine(line: string): string {
  let text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  // 剥离 Cocos 编辑器时间戳前缀（如 "2026-8-14 15:59:05-warn: "），
  // 否则同一报错因每行时间戳不同而无法去重
  text = text.replace(/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}:\d{2}-(debug|info|log|warn|error):\s*/, '');
  // Programming 面板的语法错误是 URL 编码的 throw new Error(...)，
  // 解码还原出人话（"SyntaxError: xxx.ts: Unexpected token ..."），失败则原样截断。
  // 注意分隔符可能是 / 或 \（日志里出现过 data:text\javascript, 形态）
  const dataMatch = text.match(/data:text[\\/]javascript,/);
  if (dataMatch?.index !== undefined) {
    try {
      const decoded = decodeURIComponent(text.slice(dataMatch.index + dataMatch[0].length));
      const m = decoded.match(/throw new Error\(`([^`]*)`\)/);
      text = m ? m[1] : decoded;
    } catch {
      // 解码失败保留原文（含非法转义序列时 decodeURIComponent 会抛错）
    }
  }
  // 压掉多余空白再截断
  text = text.replace(/\s+/g, ' ').trim();
  // 归一化 chunk 哈希路径：pack:///chunks/7e/7ec869....js 这类路径每条都不同，
  // 不归一化的话同一个根因（如 gfcc is not defined）会被拆成上百类，去重失效
  // （连同两位哈希目录前缀一起替换，否则 chunks/7e/ 与 chunks/42/ 仍拆成多类）
  text = text.replace(/([0-9a-f]{2}\/)?[0-9a-f]{38,42}\.js/g, '<hash>.js');
  return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN) + '...' : text;
}

/**
 * 判断一行构建日志是否是报错，是则给出分类
 *
 * 匹配依据（mahjong 工程实测日志）：
 * - module：Module "xxx" not found / Cannot find module
 * - syntax：SyntaxError（含 URL 编码形式，clean 后仍含关键字）
 * - runtime：ReferenceError / TypeError
 * - editor：Cocos 编辑器时间戳日志的 "-error:" 级别行（如 build-script failed）
 */
export function classifyBuildErrorLine(line: string): BuildErrorItem['category'] | null {
  // 注意引号可能带反斜杠转义（错误信息被 JSON 序列化内嵌在日志行里）
  if (/Module \\?".*?\\?" not found|Cannot find module/.test(line)) return 'module';
  if (/SyntaxError/.test(line)) return 'syntax';
  if (/ReferenceError:|TypeError:/.test(line)) return 'runtime';
  if (/-error:/.test(line)) return 'editor';
  return null;
}

/**
 * 汇总构建日志中的报错行：分类 + 清洗 + 同类去重计数
 *
 * @param lines 构建进程输出的全部行
 * @returns 去重后的报错列表（超出 MAX_ERROR_ITEMS 截断，原始行数仍可从 build-raw 数）
 */
export function summarizeBuildErrors(lines: string[]): BuildErrorItem[] {
  const map = new Map<string, BuildErrorItem>();
  for (let i = 0; i < lines.length; i++) {
    const category = classifyBuildErrorLine(lines[i]);
    if (!category) continue;
    const message = cleanBuildErrorLine(lines[i]);
    if (!message) continue;
    const key = `${category}|${message}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else if (map.size < MAX_ERROR_ITEMS) {
      map.set(key, { category, message, count: 1, firstLine: i + 1 });
    }
  }
  return [...map.values()];
}

/**
 * 按忽略分类切分报错（--ignore-category）
 *
 * kept 进入 log JSON 的 errors 数组、终端摘要与退出码判定；
 * ignoredCount 是被过滤掉的行数（含重复），写进 JSON 留痕（不静默丢数据，
 * 原始全文始终在 build-raw log 里可复查）。
 */
export function splitIgnoredErrors(
  errors: BuildErrorItem[],
  ignoreCategories?: string[]
): { kept: BuildErrorItem[]; ignoredCount: number } {
  const ignore = new Set(ignoreCategories ?? []);
  const kept = errors.filter((e) => !ignore.has(e.category));
  const ignoredCount = errors
    .filter((e) => ignore.has(e.category))
    .reduce((n, e) => n + e.count, 0);
  return { kept, ignoredCount };
}

/**
 * 构建工程到指定平台（输出实时 tee 终端 + 落盘 build-log / build-raw）
 *
 * @param projectPath 工程根目录
 * @param platform 平台（简称或 Cocos 原生名）
 * @param options.fast 快速模式：只检查脚本编译，脚本阶段结束后提前终止，不校验产物
 * @returns 构建结果（成功时含产物目录；含日志路径与报错聚合）
 */
export async function buildProject(
  projectPath: string,
  platform: string,
  options?: { fast?: boolean; ignoreCategories?: string[] }
): Promise<BuildResult> {
  const fast = options?.fast === true;
  const ignoreCategories = options?.ignoreCategories;
  const cocosPlatform = normalizePlatform(platform);
  const creatorPath = getCocosCreatorPath();
  const startMs = Date.now();

  // 生成 buildConfig 到 <project>/.cocoscli/（fast 用独立配置文件，不覆盖正式配置）
  const configDir = path.join(projectPath, COCOSCLI_BUILD_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  const configName = `buildConfig-${cocosPlatform}${fast ? '-fast' : ''}.json`;
  const configRelPath = `${COCOSCLI_BUILD_DIR}/${configName}`;
  const configAbsPath = path.join(projectPath, configRelPath);
  const config = fast ? generateFastBuildConfig(cocosPlatform) : generateBuildConfig(cocosPlatform);
  fs.writeFileSync(configAbsPath, JSON.stringify(config, null, 2), 'utf-8');

  // 调 CocosCreator 构建（异步等待，输出 tee 终端 + 收集）
  // cwd 必须设为工程根：configPath 是相对工程根的路径，CocosCreator 按进程 cwd 解析
  const args = ['--project', projectPath, '--build', `configPath=${configRelPath}`];
  const child = spawn(creatorPath, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 收集输出：原始字节留全文 log，按行切分供报错提取；同时原样转发终端。
  // fast 模式下逐行检查早退标记：脚本阶段结束（即将进入工程自定义 build-script）即 kill 进程树
  const chunks: Buffer[] = [];
  const lines: string[] = [];
  let lineBuf = '';
  let aborted = false;
  const collect = (data: Buffer, stream: NodeJS.WriteStream): void => {
    chunks.push(data);
    stream.write(data);
    lineBuf += data.toString('utf-8');
    const parts = lineBuf.split(/\r?\n/);
    lineBuf = parts.pop() ?? '';
    lines.push(...parts);
    if (fast && !aborted && child.pid !== undefined && parts.some(isFastAbortMarker)) {
      aborted = true;
      console.log(chalk.yellow(`\n[fast] 脚本编译阶段已结束（${configName}），提前终止构建进程，不等待资源打包...`));
      try {
        killProcess(child.pid); // 按本次 spawn 的 PID 杀进程树，不影响其他 CocosCreator 实例
      } catch {
        // 进程可能恰好已自行退出：不吞错，等待 close 事件按正常退出处理
      }
    }
  };
  child.stdout?.on('data', (d: Buffer) => collect(d, process.stdout));
  child.stderr?.on('data', (d: Buffer) => collect(d, process.stderr));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); // 例如 creatorPath 不存在
    child.on('close', (code) => resolve(code));
  });
  if (lineBuf) lines.push(lineBuf);
  const durationMs = Date.now() - startMs;

  // 落盘原始全文 log（先写 raw，再写 JSON，JSON 里引用 raw 路径）
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawLogPath = path.join(configDir, `build-raw-${ts}.log`);
  fs.writeFileSync(rawLogPath, Buffer.concat(chunks).toString('utf-8'), 'utf-8');

  // 提取报错（分类去重）+ 按忽略分类过滤：
  // errors / errorLineCount / 退出码判定都基于过滤后的结果，被忽略分类不进 JSON 的 errors 数组；
  // 被忽略行数记入 ignoredErrorCount 留痕，原始全文在 build-raw log 里可复查
  const { kept: errors, ignoredCount: ignoredErrorCount } = splitIgnoredErrors(
    summarizeBuildErrors(lines),
    ignoreCategories
  );
  const errorLineCount = errors.reduce((n, e) => n + e.count, 0);

  const result: BuildResult = {
    success: false,
    message: '',
    durationMs,
    exitCode,
    errorLineCount,
    ignoredErrorCount,
    errors,
    rawLogPath,
    fast: fast || undefined,
    aborted: aborted || undefined,
  };

  if (fast) {
    // fast 模式：成功 = 脚本阶段走完（早退或自然退出都算检查完成），不校验产物
    if (aborted) {
      result.success = true;
      result.message = 'fast 检查完成（脚本编译阶段已覆盖，构建在资源打包前提前终止，不产出构建产物）';
    } else {
      // 未见到早退标记进程就退了：要么构建早期失败，要么标记未出现，如实按失败报告
      result.message =
        `fast 检查异常结束（未到达脚本阶段收尾标记，CocosCreator 退出码 ${exitCode}）。` +
        `请查看上方日志与 build-raw log 定位原因。`;
    }
  } else {
    // 验证产物：目录存在 + 有本次构建新写入的文件（防止上次旧产物误报成功）
    // CocosCreator 常返回警告级非零码但实际成功，以产物为准
    const outputDir = path.join(projectPath, 'build', cocosPlatform);
    const fresh = isFreshOutput(outputDir, startMs);
    if (fresh) {
      result.success = true;
      result.outputDir = outputDir;
      result.message = '构建成功';
    } else {
      result.message =
        `构建失败（CocosCreator 退出码 ${exitCode}）。` +
        `若上方日志提示 startScene / No scenes 相关错误，说明工程没有可用启动场景：` +
        `请在 CocosCreator 创建场景并设为启动场景，` +
        `或在 ${configRelPath} 的 startScene 字段手动填入场景 uuid 后重试。` +
        `产物目录：${outputDir}`;
    }
  }

  // 结构化 build-log JSON（与 compile-log / eslint-log 同消费风格）
  result.logPath = writeCompileLog(projectPath, 'build-log-', {
    command: 'cocoscli build',
    project: projectPath,
    timestamp: new Date().toISOString(),
    platform: cocosPlatform,
    fast: fast || undefined,
    aborted: aborted || undefined,
    // 用户显式忽略的分类：errors 数组已过滤掉这些分类的报错，被过滤行数记入 ignoredErrorCount 留痕
    ignoreCategories: ignoreCategories?.length ? ignoreCategories : undefined,
    ignoredErrorCount: ignoreCategories?.length ? ignoredErrorCount : undefined,
    ok: result.success,
    exitCode,
    durationMs,
    outputDir: result.outputDir,
    errorLineCount,
    errors,
    rawLog: path.relative(projectPath, rawLogPath).split(path.sep).join('/'),
  }, ts);

  return result;
}

/**
 * 产物目录是否本次构建新产出（目录存在且有文件的 mtime 晚于构建开始时间）
 *
 * 允许 2 秒时钟容差：Cocos 写产物的 mtime 理论上都晚于 startMs，
 * 但跨盘符/文件系统时间戳精度问题留一点余量
 */
function isFreshOutput(outputDir: string, startMs: number): boolean {
  try {
    if (!fs.existsSync(outputDir)) return false;
    const entries = fs.readdirSync(outputDir);
    if (entries.length === 0) return false;
    const skewMs = 2_000;
    return entries.some((name) => {
      const st = fs.statSync(path.join(outputDir, name));
      return st.mtimeMs >= startMs - skewMs;
    });
  } catch {
    return false;
  }
}
