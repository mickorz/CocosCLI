#!/usr/bin/env node

// cocoscli 入口：命令注册与分发
//
// 命令分发流程
//
// index.ts
//   ├─> 无参数  显示帮助（不默认进 init，避免误触发）
//   └─> 有参数  commander.parse()
//         ├─> init   为指定 Cocos 工程安装 CocosMCP 扩展并打开（dir 省略时为当前目录，登记全局列表）
//         ├─> open   用 CocosCreator 打开工程
//         ├─> close  关闭工程对应的 CocosCreator 进程
//         ├─> list   列出已注册工程（全局 ~/.cocoscli/projects.json）
//         └─> ...    build/verify/compile/lint 等检查与工具命令

import { Command } from 'commander';
import { VERSION } from './version.js';
import { init } from './commands/init.js';
import { open } from './commands/open.js';
import { close } from './commands/close.js';
import { remove } from './commands/remove.js';
import { listProjects } from './commands/list.js';
import { build } from './commands/build.js';
import { verify } from './commands/verify.js';
import { compile } from './commands/compile.js';
import { lint } from './commands/lint.js';
import { previewScene } from './commands/preview-scene.js';
import { evalScript } from './commands/eval.js';
import { browserLogs } from './commands/browser-logs.js';
import { doctor } from './commands/doctor.js';

const program = new Command();

program
  .name('cocoscli')
  .description('Cocos Creator 3.7.x 项目命令行工具')
  .version(VERSION);

// init：为指定 Cocos 工程安装 CocosMCP 扩展并打开，dir 省略时为当前目录
// -p 不给默认值：区分「用户显式指定」与「未指定自动错开」（读全局注册表挑空闲端口）
program
  .command('init [dir]')
  .description('为 Cocos 工程安装 CocosMCP 扩展并打开（默认免登录），dir 省略时为当前目录')
  .option('-p, --port <port>', 'CocosMCP 端口（省略时按全局注册表自动错开，首个工程 3001）')
  .action((dir: string | undefined, options: { port?: string }) => init(dir, options.port ? parseInt(options.port, 10) : undefined));

// open：用 CocosCreator 打开工程，dir 省略时为当前目录
program
  .command('open [dir]')
  .description('用 CocosCreator 打开工程（默认免登录），dir 省略时为当前目录')
  .action((dir?: string) => open(dir));

// close：关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录
program
  .command('close [dir]')
  .description('关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录')
  .action((dir?: string) => close(dir));

// remove：卸载 CocosMCP（关闭工程 + 删除扩展与配置，init 的逆操作）
program
  .command('remove [dir]')
  .description('卸载 CocosMCP（关闭工程、删除 extensions/CocosMCP 与 settings 配置，init 的逆操作）')
  .action((dir?: string) => remove(dir));

// list：列出所有执行过 cocoscli init 的工程（全局 ~/.cocoscli/projects.json）
program
  .command('list')
  .description('列出所有已执行 cocoscli init 的工程（目录、CocosMCP 版本、MCP 端口）')
  .action(() => listProjects());

// build：构建工程到指定平台
program
  .command('build <platform> [dir]')
  .description('构建工程到指定平台（web/web-desktop、web-mobile、wechat、douyin 等），生成 build-log，dir 省略时为当前目录')
  .option('--fast', '快速模式：只检查脚本编译，脚本阶段结束后提前终止（不产出构建产物，发现报错退出码非 0）')
  .option('--ignore-category <cats>', '忽略指定报错分类（逗号分隔：syntax,module,runtime,editor）：log 的 errors 数组与退出码均过滤掉该分类（被过滤行数记入 ignoredErrorCount，原始全文见 build-raw log）')
  .action((platform: string, dir?: string, opts?: { fast?: boolean; ignoreCategory?: string }) =>
    build(dir, platform, opts?.fast === true, opts?.ignoreCategory));

// verify：验证工程（编译检查 + MCP/preview 验证 + opencode 预览场景）
program
  .command('verify <scene> [dir]')
  .description('验证工程：tsc 编译检查 + MCP/preview 连通性 + opencode 预览指定场景，事件流监控')
  .action(async (scene: string, dir?: string) => verify(dir, scene));

// compile：编译检查（cocos-mcp run_script_diagnostics），生成编译报告 log
program
  .command('compile [dir]')
  .description('编译检查（cocos-mcp run_script_diagnostics），生成编译报告到 .cocoscli/logs/compile/compile-log-*.json。配置见 .cocoscli/compile.config.json')
  .action(async (dir?: string) => compile(dir));

// lint：ESLint 代码规范检查（忠实使用工程 .eslintrc.json + tsconfig.eslint.json + 工程本地 ESLint）
program
  .command('lint [dir]')
  .description('ESLint 代码规范检查（忠实使用工程 .eslintrc.json + tsconfig.eslint.json + 工程本地 ESLint），生成 .cocoscli/logs/lint/eslint-log-*.json')
  .action(async (dir?: string) => lint(dir));

// previewscene：切换场景并获取预览地址（CocosMCP scene_management + server_information）
// 默认丢弃未保存改动直接切换（不弹保存框）；--save 切换前保存当前场景
// 预览参数：.cocoscli/preview.config.json（default + scenes 场景级覆盖），--query 临时覆盖
program
  .command('previewscene <scene> [dir]')
  .description('切换场景并获取预览地址（CocosMCP），在浏览器打开预览；默认丢弃未保存改动直接切换（不弹窗），--save 保留改动；预览地址参数读 .cocoscli/preview.config.json（场景级覆盖 default），--query 临时覆盖')
  .option('--save', '切换前保存当前场景（默认丢弃未保存改动直接切）')
  .option('--query <query>', '预览地址参数（不含 ?，如 ui=10000&gameid=42272；临时覆盖 preview.config.json）')
  .action(
    async (scene: string, dir?: string, options?: { save?: boolean; query?: string }) =>
      previewScene(scene, dir, options?.save === true, options?.query)
  );

// eval：在编辑器内执行任意 JS（CocosMCP execute_script，scene/editor 双上下文）
// PowerShell 引号提示：外层用单引号（双引号会吃 JS 模板串 ${} 插值），JS 内部字符串用双引号；
// 长脚本推荐 -f 文件入口规避一切转义
program
  .command('eval [code] [dir]')
  .description('在编辑器内执行任意 JS（scene 上下文注入 require/cc/Editor/scene/director/args，editor 上下文注入 require/Editor/args/fs/path/os），三出口：直接 return / run(env) / module.exports，写 eval-log')
  .option('--context <ctx>', '执行上下文（scene|editor，默认 scene）')
  .option('--args <json>', '传给代码的 args 参数（JSON 对象串）')
  .option('-f, --file <path>', '从文件读代码（优先于 code 参数）')
  .option('--timeout <ms>', '执行超时毫秒（默认 120000）', (v: string) => parseInt(v, 10))
  .action(async (code: string | undefined, dir?: string, options?: Record<string, unknown>) => {
    // -f 传了文件时 code 位置参数无意义，用户容易把工程目录直接放第一个
    //（cocoscli eval -f x.js <dir> 会被 commander 解析成 code=<dir>），这里归位
    const opts = options as Record<string, unknown> | undefined;
    if (opts?.file && code !== undefined && dir === undefined) {
      dir = code;
      code = undefined;
    }
    await evalScript(code, dir, opts as Parameters<typeof evalScript>[2]);
  });

// browserlogs：读取 CDP Chrome 中预览页的控制台日志（cdp-cli console）
program
  .command('browserlogs [dir]')
  .description('读取浏览器控制台日志（cdp-cli console），支持 --type/--tail/--duration/--all/--grep')
  .option('--type <type>', '日志级别过滤（error/warn/info/log/debug）')
  .option('--tail <n>', '只看最后 N 条', (v: string) => parseInt(v, 10))
  .option('--duration <s>', '收集时长（秒）', (v: string) => parseInt(v, 10))
  .option('--all', '显示全部日志（不限条数）')
  .option('--grep <keyword>', '关键词过滤（不区分大小写）')
  .option('--page <page>', 'CDP 页面匹配（title/id 子串，默认自动匹配预览页）')
  .action(async (dir: string | undefined, options: Record<string, unknown>) => {
    await browserLogs(dir, options as Parameters<typeof browserLogs>[1]);
  });

// doctor：依赖体检（检查 git/node/npm/cdp-cli 等关键依赖是否就绪）
program
  .command('doctor')
  .description('依赖体检：检查 git/node/npm/cdp-cli 等关键依赖是否就绪')
  .action(async () => doctor());

// 无参数时显示帮助
if (process.argv.length === 2) {
  program.help();
} else {
  program.parse();
}
