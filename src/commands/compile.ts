import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { runScriptDiagnosticsViaMcp, readMcpPort, verifyMcpConnection } from '../utils/verify.js';
import { readSnippet, writeCompileLog } from '../utils/compile-log.js';

// compile 命令：调 cocos-mcp run_script_diagnostics 做编译检查，生成 log
//
// 复用 verify 第2步的 runScriptDiagnosticsViaMcp（编辑器内置 tsc + skipLibCheck）
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

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`编译检查（cocos-mcp run_script_diagnostics）`));
  console.log(chalk.gray(`工程：${dir}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}\n`));

  // ===== 前置检查（四条链路，任一失败中断 + 提示修复）=====

  // 检查1：CocosMCP 已装
  const cocosMcpDir = path.join(dir, 'extensions', 'CocosMCP');
  if (!fs.existsSync(cocosMcpDir)) {
    console.log(chalk.red('[检查1] CocosMCP 未安装'));
    console.log(chalk.gray(`  ${cocosMcpDir} 不存在，先跑 cocoscli init。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查1] CocosMCP 已安装'));

  // 检查2：CocosMCP 已 build（dist/tools/diagnostics.js）
  const diagnosticsJs = path.join(cocosMcpDir, 'dist', 'tools', 'diagnostics.js');
  if (!fs.existsSync(diagnosticsJs)) {
    console.log(chalk.red('[检查2] CocosMCP 未 build（dist/tools/diagnostics.js 不存在）'));
    console.log(chalk.gray(`  在 ${cocosMcpDir} 跑 npm install + npm run build。`));
    process.exit(1);
  }
  console.log(chalk.gray('[检查2] CocosMCP 已 build（含 diagnostics）'));

  // 检查3：CocosCreator 已开（MCP HTTP server 在跑）
  const mcpOk = await verifyMcpConnection(mcpPort);
  if (!mcpOk) {
    console.log(chalk.red(`[检查3] CocosMCP HTTP server 不可访问（端口 ${mcpPort}）`));
    console.log(chalk.gray('  CocosCreator 可能没开，或 CocosMCP 扩展没加载。先跑 cocoscli open。'));
    process.exit(1);
  }
  console.log(chalk.gray(`[检查3] CocosMCP HTTP server 可访问（${mcpPort}）`));

  // 检查4：run_script_diagnostics 工具可用（同时拿编译结果）
  const diag = await runScriptDiagnosticsViaMcp(mcpPort);
  if (!diag.ran) {
    console.log(chalk.red('[检查4] run_script_diagnostics 工具不可用'));
    console.log(chalk.gray('  CocosMCP 可能没移植 run_script_diagnostics，或 CocosCreator 需重启加载新 CocosMCP。'));
    process.exit(1);
  }
  console.log(chalk.gray('[检查4] run_script_diagnostics 可用\n'));

  // 写 log 文件（JSON 格式 + 时间戳 + snippet，通过共用 writeCompileLog）
  const logData = {
    command: 'cocoscli compile',
    project: dir,
    timestamp: new Date().toISOString(),
    mcpPort,
    ok: diag.errors.length === 0,
    errorCount: diag.errors.length,
    errors: diag.errors.map((e) => ({
      ...e,
      snippet: readSnippet(path.join(dir, e.file), e.line),
    })),
  };

  if (diag.errors.length === 0) {
    console.log(chalk.green('无 error'));
  } else {
    console.log(chalk.red(`发现 ${diag.errors.length} 个 error：`));
    diag.errors.forEach((e) => {
      console.log(chalk.gray(`  ${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`));
    });
  }

  const logPath = writeCompileLog(dir, 'compile-log-', logData);
  console.log(chalk.green(`\n编译报告已写入：${logPath}`));
}
