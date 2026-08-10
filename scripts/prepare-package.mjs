import { execSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import process from 'node:process'

// prepare-package：把 submodule 依赖打包进 vendor/，供 npm publish 发布
//
// 流程：
//   deps/CocosMCP → vendor/CocosMCP（copy 源码，排除 .git/node_modules/dist
//                   init 时 buildCocosMcp 会在目标工程 npm install + build）
//   deps/cdp-cli  → vendor/cdp-cli（copy build + package.json，排除 .git/node_modules
//                   运行时依赖 ws/yargs 由根 package.json dependencies 承担）
//
// 发布包结构：
//   dist/             CLI 编译产物
//   vendor/CocosMCP   init 拷贝源（init 时 build）
//   vendor/cdp-cli    cdp-cli 入口（build/index.js，运行时依赖由根承担）
//
// 调用链：
//   npm run prepare-package → 生成 vendor/
//   npm publish            → files 含 dist + vendor，用户 npm install -g 即含依赖
//
// 用法：npm run prepare-package

const root = process.cwd()
function run(args, cwd) {
  console.log(`\n> npm ${args.join(' ')}`)
  execSync(`npm ${args.join(' ')}`, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' ') },
  })
}

/** 构造排除过滤器：跳过指定顶层目录（.git / node_modules / dist 等）与 .gitignore
 *  避免 vendor 子目录的 .gitignore 让 npm pack 忽略 build 等产物 */
function excludeDirs(base, dirs) {
  const pattern = new RegExp(`^(${dirs.join('|')})([\\\\/]|$)`)
  return (source) => {
    const rel = source.slice(base.length).replace(/^[\\/]/, '')
    if (!rel) return true // 根目录本身，保留
    if (basename(rel) === '.gitignore') return false // 排除 .gitignore，避免 npm pack 忽略 build
    return !pattern.test(rel)
  }
}

const vendorDir = resolve(root, 'vendor')

// 清理旧 vendor
console.log('\n[prepare] 清理 vendor/')
rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })

// ------------------------
// CocosMCP
// ------------------------

const cocosMcpSrc = resolve(root, 'deps', 'CocosMCP')
const cocosMcpDst = resolve(vendorDir, 'CocosMCP')

if (!existsSync(cocosMcpSrc)) {
  console.error('[失败] deps/CocosMCP 不存在，请先 git submodule update --init --recursive')
  process.exit(1)
}

console.log('\n[prepare] CocosMCP → vendor/CocosMCP')
// 排除 .git / node_modules / dist（init 时在目标工程 build 生成 dist）
cpSync(cocosMcpSrc, cocosMcpDst, {
  recursive: true,
  filter: excludeDirs(cocosMcpSrc, ['.git', 'node_modules', 'dist']),
})
console.log('[完成] vendor/CocosMCP 就绪（init 时 build）')

// ------------------------
// cdp-cli
// ------------------------

const cdpCliSrc = resolve(root, 'deps', 'cdp-cli')
const cdpCliDst = resolve(vendorDir, 'cdp-cli')

if (!existsSync(cdpCliSrc)) {
  console.error('[失败] deps/cdp-cli 不存在，请先 git submodule update --init --recursive')
  process.exit(1)
}

const cdpCliDist = resolve(cdpCliSrc, 'build', 'index.js')
if (!existsSync(cdpCliDist)) {
  console.error('[失败] deps/cdp-cli/build/index.js 不存在，请先 npm run setup')
  process.exit(1)
}

console.log('\n[prepare] cdp-cli → vendor/cdp-cli')
// 排除 .git / node_modules（运行时依赖 ws/yargs 由根 package.json dependencies 承担，
// Node 模块解析沿父目录找 node_modules，发布包不需 vendor/cdp-cli/node_modules）
cpSync(cdpCliSrc, cdpCliDst, {
  recursive: true,
  filter: excludeDirs(cdpCliSrc, ['.git', 'node_modules']),
})
console.log('[完成] vendor/cdp-cli 就绪（build 入口，运行时依赖由根承担）')

console.log('\n所有发布依赖已打包到 vendor/')
console.log('下一步：npm publish（files 含 dist + vendor）')
