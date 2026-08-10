#!/usr/bin/env node

// cdp-cli 全局命令 wrapper
// npm install -g cocoscli 后自动得到 cdp-cli 命令（无需单独 npm link cdp-cli）
// 实际执行 vendor/cdp-cli/build/index.js（发布态）或 deps/cdp-cli/build/index.js（开发态）
// 版本由 cocoscli 的 submodule/vendor 锁定，不受其他项目 npm link 影响

import { runCdpCliSync } from './utils/cdp-cli.js';

const result = runCdpCliSync(process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
