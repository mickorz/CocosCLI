import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getCocosCreatorPath } from './cocos.js';
import { writeCompileLog } from './compile-log.js';

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
  /** CocosCreator 进程退出码（spawn 失败时为 null） */
  exitCode: number | null;
  /** 结构化 build-log JSON 路径 */
  logPath?: string;
  /** 原始全文 log 路径 */
  rawLogPath?: string;
  /** 命中的报错行总数（含重复） */
  errorLineCount: number;
  /** 去重后的报错聚合（按重复次数降序在命令层展示） */
  errors: BuildErrorItem[];
}

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
  const dataIdx = text.indexOf('data:text/javascript,');
  if (dataIdx >= 0) {
    try {
      const decoded = decodeURIComponent(text.slice(dataIdx + 'data:text/javascript,'.length));
      const m = decoded.match(/throw new Error\(`([^`]*)`\)/);
      text = m ? m[1] : decoded;
    } catch {
      // 解码失败保留原文（含非法转义序列时 decodeURIComponent 会抛错）
    }
  }
  // 压掉多余空白再截断
  text = text.replace(/\s+/g, ' ').trim();
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
 * 构建工程到指定平台（输出实时 tee 终端 + 落盘 build-log / build-raw）
 *
 * @param projectPath 工程根目录
 * @param platform 平台（简称或 Cocos 原生名）
 * @returns 构建结果（成功时含产物目录；含日志路径与报错聚合）
 */
export async function buildProject(projectPath: string, platform: string): Promise<BuildResult> {
  const cocosPlatform = normalizePlatform(platform);
  const creatorPath = getCocosCreatorPath();
  const startMs = Date.now();

  // 生成 buildConfig 到 <project>/.cocoscli/
  const configDir = path.join(projectPath, COCOSCLI_BUILD_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  const configRelPath = `${COCOSCLI_BUILD_DIR}/buildConfig-${cocosPlatform}.json`;
  const configAbsPath = path.join(projectPath, configRelPath);
  fs.writeFileSync(
    configAbsPath,
    JSON.stringify(generateBuildConfig(cocosPlatform), null, 2),
    'utf-8'
  );

  // 调 CocosCreator 构建（异步等待，输出 tee 终端 + 收集）
  // cwd 必须设为工程根：configPath 是相对工程根的路径，CocosCreator 按进程 cwd 解析
  const args = ['--project', projectPath, '--build', `configPath=${configRelPath}`];
  const child = spawn(creatorPath, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 收集输出：原始字节留全文 log，按行切分供报错提取；同时原样转发终端
  const chunks: Buffer[] = [];
  const lines: string[] = [];
  let lineBuf = '';
  const collect = (data: Buffer, stream: NodeJS.WriteStream): void => {
    chunks.push(data);
    stream.write(data);
    lineBuf += data.toString('utf-8');
    const parts = lineBuf.split(/\r?\n/);
    lineBuf = parts.pop() ?? '';
    lines.push(...parts);
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

  // 提取报错（分类去重）
  const errors = summarizeBuildErrors(lines);
  const errorLineCount = errors.reduce((n, e) => n + e.count, 0);

  // 验证产物：目录存在 + 有本次构建新写入的文件（防止上次旧产物误报成功）
  // CocosCreator 常返回警告级非零码但实际成功，以产物为准
  const outputDir = path.join(projectPath, 'build', cocosPlatform);
  const fresh = isFreshOutput(outputDir, startMs);

  const result: BuildResult = {
    success: fresh,
    message: '',
    durationMs,
    exitCode,
    errorLineCount,
    errors,
    rawLogPath,
  };

  if (fresh) {
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

  // 结构化 build-log JSON（与 compile-log / eslint-log 同消费风格）
  result.logPath = writeCompileLog(projectPath, 'build-log-', {
    command: 'cocoscli build',
    project: projectPath,
    timestamp: new Date().toISOString(),
    platform: cocosPlatform,
    ok: result.success,
    exitCode,
    durationMs,
    outputDir: fresh ? outputDir : undefined,
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
