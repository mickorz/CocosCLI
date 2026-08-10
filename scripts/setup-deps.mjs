import { execSync } from 'node:child_process'
import process from 'node:process'

// setup：开发态初始化依赖（= build:deps + 提示 npm link cocoscli）
// cdp-cli 命令由 cocoscli 的 bin wrapper 提供（npm link cocoscli 后自动有 cdp-cli）
//
// 流程：
//   build:deps（install + build cdp-cli + CocosMCP，复用 build-deps.mjs）
//     ↓
//   提示 npm link cocoscli → 得到 cocoscli 与 cdp-cli 全局命令
//
// 用法：npm run setup

// 复用 build-deps 的 install + build 逻辑（含 package.json 检查、DEP0190 抑制）
execSync('node scripts/build-deps.mjs', { stdio: 'inherit', cwd: process.cwd() })

console.log('\n[完成] 依赖已构建')
console.log('开发态执行 npm link 得到 cocoscli 与 cdp-cli 命令')
