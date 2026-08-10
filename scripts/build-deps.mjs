import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

// build-deps：install + build 所有 submodule 依赖（不 link，发布态安全）
// 供 prepack 与 setup 共用，setup 在此基础上提示 npm link cocoscli
//
// 流程：
//   ensurePackage（检查 deps/<name>/package.json，submodule 未初始化时报错）
//     ├─> deps/cdp-cli：npm install + npm run build（生成 build/index.js）
//     └─> deps/CocosMCP：npm install + npm run build（生成 dist）
//
// 用法：npm run build:deps

const root = process.cwd()

function run(args, cwd) {
  console.log(`\n> npm ${args.join(' ')}`)
  execSync(`npm ${args.join(' ')}`, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' ') },
  })
}

function ensurePackage(name, dir) {
  if (!existsSync(resolve(dir, 'package.json'))) {
    console.error(`[失败] ${name} 未初始化，请执行：git submodule update --init --recursive`)
    process.exit(1)
  }
}

const cdpCli = resolve(root, 'deps/cdp-cli')
const cocosMcp = resolve(root, 'deps/CocosMCP')

ensurePackage('cdp-cli', cdpCli)
ensurePackage('CocosMCP', cocosMcp)

console.log('\n[build:deps] cdp-cli')
run(['install'], cdpCli)
run(['run', 'build'], cdpCli)

console.log('\n[build:deps] CocosMCP')
run(['install'], cocosMcp)
run(['run', 'build'], cocosMcp)

console.log('\n[完成] 依赖构建完成')
