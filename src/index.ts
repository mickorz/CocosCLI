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

const program = new Command();

program
  .name('cocoscli')
  .description('Cocos Creator 3.7.x 项目命令行工具')
  .version(VERSION);

// init：为当前 Cocos 工程安装 CocosMCP 扩展并打开
program
  .command('init')
  .description('为当前 Cocos 工程安装 CocosMCP 扩展并打开')
  .option('--nologin', '打开时不提示登录')
  .action((options: { nologin?: boolean }) => init(options.nologin === true));

// open：用 CocosCreator 打开工程，dir 省略时为当前目录
program
  .command('open [dir]')
  .description('用 CocosCreator 打开工程，dir 省略时为当前目录')
  .option('--nologin', '打开时不提示登录')
  .action((dir: string | undefined, options: { nologin?: boolean }) => open(dir, options.nologin === true));

// close：关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录
program
  .command('close [dir]')
  .description('关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录')
  .action((dir?: string) => close(dir));

// 无参数时显示帮助
if (process.argv.length === 2) {
  program.help();
} else {
  program.parse();
}
