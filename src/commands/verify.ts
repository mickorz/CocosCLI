import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isCocosProject } from '../utils/project.js';
import { getCocosCreatorPath, openCocosProject } from '../utils/cocos.js';
import {
  runScriptDiagnosticsViaMcp,
  verifyMcpConnection,
  httpOk,
  fetchPreviewUrl,
  readMcpPort,
  isOpencodeAvailable,
  runOpencodeMonitored,
  OpencodeResult,
} from '../utils/verify.js';
import { findCocosProcesses, isProjectMatch } from '../utils/process.js';
import { readSnippet, writeCompileLog } from '../utils/compile-log.js';

// verify 命令：编排四步验证
//
// 第1步  cocoscli open 启动 CocosCreator，等编辑器与 CocosMCP 加载
// 第2步  tsc --noEmit 编译检查，解析 error
// 第3步  HTTP 验证 MCP（3001/health）与 preview（7456）
// 第4步  opencode run --format json 预览 {场景}，事件流监控状态
// 最后   汇总报告写到 .cocoscli/verify-report.md

/** 等待 ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * verify 命令：验证工程（编译 + MCP/preview + opencode 预览场景）
 *
 * @param projectDir 工程目录，省略时默认当前执行目录
 * @param scene 要预览的场景名（如 loading）
 */
export async function verify(projectDir: string | undefined, scene: string): Promise<void> {
  const dir = path.resolve(projectDir ?? process.cwd());

  if (!scene) {
    console.log(chalk.red('请指定场景，例如：cocoscli verify <场景> [工程目录]'));
    process.exit(1);
  }

  if (!isCocosProject(dir)) {
    console.log(chalk.red(`目标目录不是 Cocos 3.x 工程：${dir}`));
    console.log(chalk.gray('Cocos 工程根目录应同时包含 assets/ 与 settings/'));
    process.exit(1);
  }

  // 前置检查：opencode 是否可用（第4步依赖，提前检查避免白跑 1-3 步）
  if (!isOpencodeAvailable()) {
    console.log(chalk.red('opencode 未找到（不在 PATH）'));
    console.log(chalk.gray('  安装：npm install -g opencode'));
    process.exit(1);
  }

  const mcpPort = readMcpPort(dir);
  console.log(chalk.cyan(`开始 verify ${dir}`));
  console.log(chalk.cyan(`场景：${scene}`));
  console.log(chalk.gray(`MCP 端口：${mcpPort}\n`));

  const report: string[] = [
    '# cocoscli verify 报告',
    '',
    `- 工程：${dir}`,
    `- 场景：${scene}`,
    `- 时间：${new Date().toISOString()}`,
    '',
  ];

  // 第1步：启动 CocosCreator
  console.log(chalk.blue('第1步 启动 CocosCreator'));
  let creatorPath: string;
  try {
    creatorPath = getCocosCreatorPath();
  } catch (e) {
    console.log(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  // 检测 CocosCreator 是否已开（同工程），已开则跳过 open，避免重复 --project 触发重启
  const procs = findCocosProcesses();
  const alreadyRunning = procs.some((p) => isProjectMatch(p.command, dir));
  if (alreadyRunning) {
    console.log(chalk.gray('  CocosCreator 已在运行，跳过启动（不重启）'));
    report.push('## 第1步 启动 CocosCreator', '- CocosCreator 已在运行，跳过启动', '');
  } else {
    openCocosProject(creatorPath, dir);
    console.log(chalk.gray('  已拉起 CocosCreator'));
    report.push('## 第1步 启动 CocosCreator', '- 已拉起 CocosCreator', '');
  }

  // 轮询 CocosMCP health 直到就绪（替代固定 sleep，CocosCreator 启动慢时等够）
  console.log(chalk.gray(`  等待 CocosMCP 就绪（轮询 ${mcpPort}/health，最多 90 秒）...`));
  let mcpReady = false;
  for (let i = 0; i < 18; i++) {
    if (await verifyMcpConnection(mcpPort)) {
      mcpReady = true;
      break;
    }
    await sleep(5000);
  }
  console.log(chalk.gray(`  CocosMCP ${mcpReady ? '已就绪' : '未就绪（超时，后续 MCP 验证可能失败）'}`));

  // 第2步：编译检查 + 自动修复循环（调 cocos-mcp run_script_diagnostics，用编辑器内置 tsc）
  console.log(chalk.blue('\n第2步 编译检查（cocos-mcp run_script_diagnostics，含自动修复循环，最多 3 轮）'));
  console.log(chalk.gray('  正在编译检查（编辑器 tsc，大工程可能几十秒）...'));
  let diag = await runScriptDiagnosticsViaMcp(mcpPort);
  if (!diag.ran) {
    console.log(chalk.gray('  cocos-mcp run_script_diagnostics 不可用，跳过'));
    report.push('## 第2步 编译检查', '- cocos-mcp run_script_diagnostics 不可用，跳过', '');
  } else {
    let round = 0;
    const maxRounds = 3;
    while (diag.errors.length > 0 && round < maxRounds) {
      round++;
      // 留存本轮编译 log（JSON + snippet，追溯修复过程）
      writeCompileLog(dir, `verify-compile-round-${round}-`, {
        source: 'verify',
        round,
        timestamp: new Date().toISOString(),
        errorCount: diag.errors.length,
        errors: diag.errors.map((e) => ({
          ...e,
          snippet: readSnippet(path.join(dir, e.file), e.line),
        })),
      });
      console.log(chalk.yellow(`\n  第 ${round} 轮：发现 ${diag.errors.length} 个 error，调 opencode 修复`));
      diag.errors.forEach((e) =>
        console.log(chalk.gray(`    ${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`))
      );
      const errorList = diag.errors
        .map((e) => `${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`)
        .join('\n');
      const fixPrompt = `请修复以下 TypeScript 编译 error，只做必要的最小修改，不要改无关代码：\n${errorList}`;
      const fixResult = await runOpencodeMonitored(fixPrompt, dir, (st, info) => {
        console.log(chalk.gray(`    [${st}] ${info}`.trim()));
      });
      if (fixResult.state !== 'SUCCEEDED') {
        console.log(chalk.red('  opencode 修复未成功，停止循环'));
        report.push('## 第2步 编译检查', `- 第 ${round} 轮 opencode 修复未成功`, '');
        break;
      }
      console.log(chalk.gray('  修复完成，重跑编译检查...'));
      diag = await runScriptDiagnosticsViaMcp(mcpPort);
    }
    // 留存最终编译 log
    writeCompileLog(dir, 'verify-compile-final-', {
      source: 'verify',
      round: 'final',
      timestamp: new Date().toISOString(),
      errorCount: diag.errors.length,
      errors: diag.errors.map((e) => ({
        ...e,
        snippet: readSnippet(path.join(dir, e.file), e.line),
      })),
    });
    if (diag.errors.length === 0) {
      const note = round > 0 ? `（经 ${round} 轮修复）` : '';
      console.log(chalk.green(`  无 error${note}`));
      report.push('## 第2步 编译检查', `- 无 error${note}`, '');
    } else {
      console.log(chalk.red(`  仍有 ${diag.errors.length} 个 error（${round} 轮修复后）：`));
      report.push('## 第2步 编译检查', `- 仍有 ${diag.errors.length} 个 error（${round} 轮修复后）：`, '');
      diag.errors.forEach((e) => {
        const line = `${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`;
        console.log(chalk.gray(`    ${line}`));
        report.push(`- ${line}`);
      });
      report.push('');
    }
  }

  // 第3步：MCP + preview 验证（preview 用动态 previewUrl，调 cocos-mcp server_information 查真实地址）
  console.log(chalk.blue('\n第3步 验证 MCP 与 preview'));
  const mcpOk = await verifyMcpConnection();
  const previewUrl = await fetchPreviewUrl(mcpPort);
  let previewOk = false;
  if (previewUrl) {
    // 轮询 preview server：MCP 就绪时 preview server 可能还没起（延迟启动），等它就绪
    for (let i = 0; i < 10; i++) {
      if (await httpOk(previewUrl)) {
        previewOk = true;
        break;
      }
      await sleep(3000);
    }
  }
  console.log(chalk.gray(`  MCP (3001/health)：${mcpOk ? '可访问' : '不可访问'}`));
  console.log(chalk.gray(`  preview (${previewUrl || '未获取到'})：${previewOk ? '可访问' : '不可访问'}`));
  report.push(
    '## 第3步 MCP 与 preview 验证',
    `- MCP (3001/health)：${mcpOk ? '可访问' : '不可访问'}`,
    `- preview (${previewUrl || '未获取到'})：${previewOk ? '可访问' : '不可访问'}`,
    ''
  );

  // 第4步：opencode 预览场景（事件流监控）
  console.log(chalk.blue('\n第4步 opencode 预览场景（事件流监控）'));
  // prompt 用 /skill 参数 斜杠命令式（比自然语言更稳地命中 cocos-preview-scene skill）
  const prompt = `/cocos-preview-scene ${scene}`;
  console.log(chalk.gray(`  prompt：${prompt}`));
  const result: OpencodeResult = await runOpencodeMonitored(prompt, dir, (st, info) => {
    const line = info ? `[${st}] ${info}` : `[${st}]`;
    console.log(chalk.gray(`  ${line}`));
  });
  const succ = result.state === 'SUCCEEDED';
  console.log(succ ? chalk.green(`  预览结果：${result.state}`) : chalk.red(`  预览结果：${result.state}`));
  report.push(
    '## 第4步 opencode 预览场景',
    `- 最终状态：${result.state}`,
    `- 退出码：${result.exitCode}`,
    `- 调用工具：${result.toolsCalled.join(', ') || '(无)'}`,
    result.error ? `- 错误：${result.error}` : '',
    ''
  );

  // 写报告
  const reportDir = path.join(dir, '.cocoscli');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'verify-report.md');
  fs.writeFileSync(reportPath, report.filter(Boolean).join('\n') + '\n', 'utf-8');

  console.log(chalk.green(`\n验证完成，报告：${reportPath}`));
}
