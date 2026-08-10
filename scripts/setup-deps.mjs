import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

// setup-deps：初始化 CocosCLI 的所有 submodule 依赖
//
// 流程：
//   前置：deps/ 存在（clone 时 --recurse-submodules，或 git submodule update --init）
//     ├─> deps/CocosMCP：npm install + npm run build（生成 dist，CocosCreator 加载需要）
//     └─> deps/cdp-cli：npm install + npm run build + npm link（全局可调 cdp-cli）
//
// 用法：npm run setup

const root = process.cwd()

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, cwd) {
  console.log(`\n> npm ${args.join(' ')}`)
  execFileSync(npm, args, { cwd, stdio: 'inherit' })
}

// ------------------------
// 前置：submodule 已初始化
// ------------------------

const depsDir = resolve(root, 'deps')
if (!existsSync(depsDir)) {
  console.error('[失败] deps/ 不存在，请先执行：git submodule update --init --recursive')
  process.exit(1)
}

// ------------------------
// cdp-cli
// ------------------------

const cdpCli = resolve(root, 'deps/cdp-cli')

console.log('\n[setup] cdp-cli')

run(['install'], cdpCli)
run(['run', 'build'], cdpCli)
run(['link'], cdpCli)

console.log('\n[完成] cdp-cli 已全局 link')

// ------------------------
// CocosMCP
// ------------------------

const cocosMcp = resolve(root, 'deps/CocosMCP')

console.log('\n[setup] CocosMCP')

run(['install'], cocosMcp)
run(['run', 'build'], cocosMcp)

console.log('\n[完成] CocosMCP 已就绪')

console.log('\n所有依赖初始化完成.')
