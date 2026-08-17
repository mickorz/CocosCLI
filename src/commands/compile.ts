import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { checkCocosMcpDeps } from '../utils/git.js';
import {
  runScriptDiagnosticsViaMcp,
  readMcpPort,
  verifyMcpConnection,
  warnProxyIfLoopbackBlocked,
  classifyDiagnostics,
  ScriptDiagnostic,
} from '../utils/verify.js';
import { readSnippet, writeCompileLog } from '../utils/compile-log.js';
import { readCompileConfig, filterExcludePath, filterIncludePath, validatePaths, type CompileConfig } from '../utils/compile-config.js';
import { ensureRootTsconfig } from '../utils/tsconfig.js';
import { buildRuntimeGlobalsDeclaration } from '../utils/runtime-globals.js';

// compile 命令：调 cocos-mcp run_script_diagnostics 做编译检查，生成 log
//
// P1 忠实模式：cocoscli 不再构造残缺的 verify tsconfig，让 cocos-mcp 直接读工程 tsconfig.json
// （保留完整类型环境：types/include/paths/strict 按工程原样，cocoscli 不覆盖）
// 把 diagnostics 写到 .cocoscli/compile-log.txt

/**
 * compile 命令：编译检查 + 生成 log
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 */
export async function compile(projectDir?: string): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 读 compile 配置（.cocoscli/compile.config.json，不存在自动生成默认模板）
  let config: CompileConfig;
  try {
    config = readCompileConfig(dir);
  } catch (e) {
    console.log(chalk.red(`.cocoscli/compile.config.json 解析失败：${e instanceof Error ? e.message : e}`));
    console.log(chalk.gray('  请检查配置文件 JSON 格式（如 { "strict": true }）'));
    process.exit(1);
  }

  // 校验 includePath/excludePath 路径存在性（检出拼错/大小写错，避免静默失效漏检）
  const missingPaths = validatePaths(dir, config);
  if (missingPaths.length > 0) {
    console.log(chalk.yellow(`[警告] 配置里的路径在工程中不存在（可能拼错/大小写）：${missingPaths.join(', ')}`));
    console.log(chalk.gray('  这些路径过滤不到任何文件，请检查 .cocoscli/compile.config.json 的 includePath/excludePath'));
  }

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`编译检查（cocos-mcp run_script_diagnostics）`));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}`));
  console.log(chalk.gray(`模式：忠实使用工程 tsconfig.json（types/paths/include/strict 按工程原样，cocoscli 不覆盖）\n`));

  // ===== 前置检查（四条链路，任一失败中断 + 提示修复）=====

  // 检查1：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    console.log(chalk.gray(`  ${cocosMcpDir} 不存在，先跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装'));

  // 检查2：CocosMCP 已 build（dist/tools/diagnostics.js + node_modules 运行时依赖）
  const diagnosticsJs = path.join(cocosMcpDir, 'dist', 'tools', 'diagnostics.js');
  if (!fs.existsSync(diagnosticsJs)) {
    console.log(chalk.red('[检查2] CocosMCP 未 build（dist/tools/diagnostics.js 不存在）'));
    console.log(chalk.gray(`  在 ${cocosMcpDir} 跑 npm install + npm run build。`));
    process.exit(1);
  }
  const deps = checkCocosMcpDeps(cocosMcpDir);
  if (!deps.ok) {
    console.log(chalk.red(`[检查2] CocosMCP node_modules 缺失（${deps.missing.join(', ')}）`));
    console.log(chalk.gray('  编辑器面板会报 Cannot find module，MCP HTTP server 起不来。'));
    console.log(chalk.gray(`  在 ${cocosMcpDir} 跑 npm install，或重跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查2] CocosMCP 已 build 且依赖齐全（dist + node_modules）'));

  // 检查3：CocosCreator 已开（MCP HTTP server 在跑）
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查3] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  CocosCreator 可能没开，或 CocosMCP 扩展没加载。先跑 cocoscli open。'));
    warnProxyIfLoopbackBlocked();
    process.exit(1);
  }
  console.log(chalk.gray(`[检查3] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 检查4：保障工程根 tsconfig.json 存在（不存在自动生成推荐模板）。P1 忠实模式：
  //       cocoscli 不构造 verify tsconfig，让 cocos-mcp findTsConfig 默认优先读工程
  //       tsconfig.json（保留完整类型环境：types/include/paths/strict 全部按工程原样）
  const tsconfigSetup = ensureRootTsconfig(dir);
  if (tsconfigSetup.status === 'written') {
    console.log(chalk.yellow(`[检查4] 工程根 tsconfig.json 不存在，已生成推荐模板：${path.join(dir, 'tsconfig.json')}`));
    console.log(chalk.gray('  模板：extends ./temp/tsconfig.cocos.json + skipLibCheck:true + lib ES2017/DOM（折叠引擎声明噪音）'));
    if (!tsconfigSetup.hasBase) {
      console.log(chalk.yellow('  [提示] temp/tsconfig.cocos.json 尚不存在（工程未在 CocosCreator 打开过），先跑 cocoscli open 再 compile。'));
    }
  } else {
    console.log(chalk.gray('[检查4] 使用工程 tsconfig.json（忠实模式，不构造 verify tsconfig）'));
    if (tsconfigSetup.missingSkipLibCheck) {
      console.log(chalk.yellow('  [提示] 工程 tsconfig.json 未设 "skipLibCheck": true，引擎 .d.ts（jsb.d.ts/cc.d.ts）声明噪音可能大量进入结果；可手动补上（cocoscli 不自动改已有配置）。'));
    }
  }
  const tsconfigArg = undefined; // 不传 → cocos-mcp findTsConfig 默认优先 project/tsconfig.json

  // P2/P3: 生成 runtime globals bridge（virtual declaration，不落盘，仅 checker 可见）
  // moduleExport: declare const <name>: typeof import("<module>").<export>;
  // namespaceAlias: import <name> = <target>;
  const runtimeGlobalsDecl = buildRuntimeGlobalsDeclaration(config.runtimeGlobals);
  const virtualDeclarations = runtimeGlobalsDecl ? [runtimeGlobalsDecl] : undefined;
  if (virtualDeclarations) {
    console.log(chalk.gray('[P2/P3] runtime globals bridge 已生成（virtual，不落盘）：'));
    for (const [name, g] of Object.entries(config.runtimeGlobals ?? {})) {
      if (g.kind === 'moduleExport') {
        console.log(chalk.gray(`  ${name} -> ${g.module}.${g.export} (moduleExport)`));
      } else {
        console.log(chalk.gray(`  ${name} -> ${g.target} (namespaceAlias)`));
      }
    }
  }

  // 检查5：run_script_diagnostics 工具可用（同时拿编译结果）
  const diag = await runScriptDiagnosticsViaMcp(mcpPort, tsconfigArg, virtualDeclarations);
  if (!diag.ran) {
    console.log(chalk.red('[检查5] run_script_diagnostics 工具不可用'));
    console.log(chalk.gray('  CocosMCP 可能没移植 run_script_diagnostics，或 CocosCreator 需重启加载新 CocosMCP。'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查5] run_script_diagnostics 可用\n'));

  // P2: Type Environment Resolution Error（virtual bridge 自身 diagnostics）
  // bridge 解析失败（如 module/export 无法解析）单独报告，绝不 fallback any，不混业务 real/noise
  if (diag.environmentErrors.length > 0) {
    console.log(chalk.red(`[Type Environment Resolution Error] runtime globals bridge 解析失败（绝不 fallback any）：`));
    diag.environmentErrors.forEach((e) => {
      console.log(chalk.red(`  ${e.code}: ${e.message}`));
    });
    console.log(chalk.gray('  请检查 .cocoscli/compile.config.json 的 runtimeGlobals（module 须能被工程 tsconfig paths 解析，export 须存在）'));
  }

  // includePath 白名单（为空全保留）+ excludePath 黑名单，串行过滤
  const { kept: afterInclude, excluded: excludedByInclude } = filterIncludePath(diag.errors, config.includePath);
  const { kept: filteredErrors, excluded: excludedByExclude } = filterExcludePath(afterInclude, config.excludePath);
  const excludedCount = excludedByInclude + excludedByExclude;
  // 降噪分类（层1 明确规则 + 层2 频次阈值，折叠第三方库声明噪音）
  const classified = classifyDiagnostics(filteredErrors);
  // snippet：cocos-mcp 已自带就优先用，没有则读文件兜底
  const withSnippet = (e: ScriptDiagnostic) => ({
    ...e,
    snippet: e.snippet && e.snippet.length > 0 ? e.snippet : readSnippet(path.join(dir, e.file), e.line),
  });

  // 展示 real（真实 error，逐条；分类计数：语法 + 类型）
  if (classified.real.length === 0) {
    console.log(chalk.green('无真实 error'));
  } else {
    console.log(
      chalk.red(
        `发现 ${classified.real.length} 个真实 error（语法 ${classified.syntacticCount} + 类型 ${classified.semanticCount}）：`
      )
    );
    classified.real.forEach((e) => {
      console.log(chalk.gray(`  ${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`));
    });
  }

  // 展示 noise 摘要（折叠的第三方库声明噪音，编辑器不报/运行时正常）
  if (classified.noise.length > 0) {
    console.log(chalk.yellow(`\n[已折叠 ${classified.noise.length} 条声明噪音（编辑器不报/运行时正常，详见 log）]`));
    const codeEntries = Object.entries(classified.noiseSummary.byCode).sort((a, b) => b[1] - a[1]);
    codeEntries.forEach(([code, n]) => console.log(chalk.gray(`  ${code}: ${n}`)));
    const typeEntries = Object.entries(classified.noiseSummary.byType).sort((a, b) => b[1] - a[1]);
    if (typeEntries.length > 0) {
      console.log(chalk.gray(`  属性不存在高频类型 top10（共 ${typeEntries.length} 个）：`));
      typeEntries.slice(0, 10).forEach(([t, n]) => console.log(chalk.gray(`    ${t}: ${n}`)));
    }
    console.log(chalk.gray('  规则：TS2307 非相对路径(含 @/ alias)、TS2304 首字母大写名、TS2339/TS2551 同 type>5 归 noise'));
    console.log(chalk.gray('  注：基于规则启发式可能误判，完整列表见 log JSON 的 noise 字段'));
  }

  // 展示 excluded（includePath 之外 + excludePath 匹配，不计 real/noise）
  if (excludedCount > 0) {
    const parts: string[] = [];
    if (excludedByInclude > 0) parts.push(`includePath 之外 ${excludedByInclude} 条`);
    if (excludedByExclude > 0) parts.push(`excludePath 匹配 ${excludedByExclude} 条（${(config.excludePath ?? []).join(', ')}）`);
    console.log(chalk.gray(`\n[已排除 ${excludedCount} 条（${parts.join('，')}），不计 real/noise，详见 log]`));
  }

  // 写 log（real 全量 + noise 全量 + 摘要，方便事后查误判）
  const logData = {
    command: 'cocoscli compile',
    project: dir,
    timestamp: new Date().toISOString(),
    mcpPort,
    tsconfigPath: 'tsconfig.json',
    runtimeGlobals: config.runtimeGlobals ?? null,
    environmentErrors: diag.environmentErrors,
    ok: classified.real.length === 0 && diag.environmentErrors.length === 0,
    errorCount: classified.real.length,
    excludedCount,
    excludedByInclude,
    excludedByExclude,
    includePaths: config.includePath ?? [],
    excludedPaths: config.excludePath ?? [],
    errors: classified.real.map(withSnippet),
    noiseSummary: classified.noiseSummary,
    noise: classified.noise.map(withSnippet),
  };
  const logPath = writeCompileLog(dir, 'compile-log-', logData);
  console.log(chalk.green(`\n编译报告已写入：${logPath}`));
}
