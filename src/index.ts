#!/usr/bin/env node

// cocoscli 入口：命令注册与分发
//
// 命令分发流程
//
// index.ts
//   ├─> 无参数  显示帮助（不默认进 init，避免误触发）
//   └─> 有参数  commander.parse()
//         ├─> init   为当前 Cocos 工程安装 CocosMCP 扩展并打开
//         ├─> open   用 CocosCreator 打开工程
//         └─> close  关闭工程对应的 CocosCreator 进程

import { Command } from 'commander';
import { VERSION } from './version.js';
import { init } from './commands/init.js';
import { open } from './commands/open.js';
import { close } from './commands/close.js';
import { remove } from './commands/remove.js';
import { build } from './commands/build.js';
import { verify } from './commands/verify.js';
import { compile } from './commands/compile.js';
import { previewScene } from './commands/preview-scene.js';
import { browserLogs } from './commands/browser-logs.js';
import { doctor } from './commands/doctor.js';

const program = new Command();

program
  .name('cocoscli')
  .description('Cocos Creator 3.7.x 项目命令行工具')
  .version(VERSION);

// init：为当前 Cocos 工程安装 CocosMCP 扩展并打开
program
  .command('init')
  .description('为当前 Cocos 工程安装 CocosMCP 扩展并打开（默认免登录）')
  .option('-p, --port <port>', 'CocosMCP 端口（默认 3001，多工程时错开如 3002）', '3001')
  .action((options) => init(parseInt(options.port, 10)));

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

// build：构建工程到指定平台
program
  .command('build <platform> [dir]')
  .description('构建工程到指定平台（web/web-desktop、web-mobile、wechat、douyin 等），dir 省略时为当前目录')
  .action((platform: string, dir?: string) => build(dir, platform));

// verify：验证工程（编译检查 + MCP/preview 验证 + opencode 预览场景）
program
  .command('verify <scene> [dir]')
  .description('验证工程：tsc 编译检查 + MCP/preview 连通性 + opencode 预览指定场景，事件流监控')
  .action(async (scene: string, dir?: string) => verify(dir, scene));

// compile：编译检查（cocos-mcp run_script_diagnostics），生成编译报告 log
program
  .command('compile [dir]')
  .description('编译检查（cocos-mcp run_script_diagnostics），生成编译报告到 .cocoscli/compile-log.txt')
  .action(async (dir?: string) => compile(dir));

// previewscene：切换场景并获取预览地址（CocosMCP scene_management + server_information）
program
  .command('previewscene <scene> [dir]')
  .description('切换场景并获取预览地址（CocosMCP），在浏览器打开预览')
  .action(async (scene: string, dir?: string) => previewScene(scene, dir));

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
