# CLAUDE.md

cocoscli —— 面向 Cocos Creator 3.7.x 的命令行工具。

## 命令

| 命令 | 说明 |
|---|---|
| `cocoscli init` | 装 CocosMCP（普通 clone）+ build + 写 mcp-server.json / opencode.json + 打开（默认免登录） |
| `cocoscli open [dir]` | 打开工程（默认免登录，已开则跳过） |
| `cocoscli close [dir]` | 关闭工程对应的 CocosCreator 进程 |
| `cocoscli remove [dir]` | 卸载 CocosMCP（关闭工程 + 删扩展 + 删配置） |
| `cocoscli build <platform> [dir]` | 构建打包到指定平台（web-desktop / wechat / douyin 等） |
| `cocoscli verify <scene> [dir]` | 验证：编译检查 + MCP/preview + opencode 预览场景 |
| `cocoscli compile [dir]` | 编译检查（cocos-mcp run_script_diagnostics）+ 生成 log |

## 架构

```
src/
├── index.ts           commander 注册命令
├── commands/          命令入口（init / open / close / remove / build / verify / compile）
├── utils/
│   ├── cocos.ts       5 级查找 CocosCreator + 打开
│   ├── project.ts     工程判定 + 路径规范化
│   ├── process.ts     跨平台进程查杀
│   ├── git.ts         clone CocosMCP + build + 写配置
│   ├── build.ts       构建打包
│   ├── verify.ts      编译检查 + MCP/preview 验证 + opencode 事件流监控（含通用 HTTP 函数）
│   ├── spinner.ts     纯文本 spinner（ASCII + [完成]/[失败]）
│   └── platform.ts    平台判断
└── __tests__/         vitest 单测
```

## 迁移 CocosMCP 能力到 CLI

如果要接入 CocosMCP 的能力（编译检查 / 预览场景 / 读浏览器日志 / 场景操作 / 资源管理等），**必看 [Docs/cocoscli-CocosMCP能力接入指南.md](../Docs/cocoscli-CocosMCP能力接入指南.md)**。

接入模式（四步）：
1. 读 `.opencode/skills/<skill>/SKILL.md` 了解端点/参数/返回
2. `utils/verify.ts` 加 HTTP 调用函数（复用 `httpPostJson` / `readMcpPort` / `verifyMcpConnection`）
3. `commands/` 加命令（四条链路前置检查 + 调用 + 输出）
4. `index.ts` 注册命令

**四条链路前置检查**（所有调 CocosMCP 的命令通用）：
1. CocosMCP 已装（extensions/CocosMCP 存在）
2. CocosMCP 已 build（dist/tools/<tool>.js 存在）
3. MCP HTTP server 跑（verifyMcpConnection）
4. 目标工具可用（调一次看响应结构）

## 开发

```bash
npm run build       # tsc 编译
npm test            # vitest 单测
npm link            # 全局链接 cocoscli（同时得到 cocoscli 与 cdp-cli 命令）
```

## 发布注意事项（submodule/vendor）

发布前必看 [Docs/cocoscli-submodule发布问题记录.md](../Docs/cocoscli-submodule发布问题记录.md)。关键点：

- cdp-cli 构建产物在 `deps/cdp-cli/build/`（非 dist），入口 `build/index.js`
- `cocoscli init` 优先 `vendor/CocosMCP` copy → `deps/CocosMCP` → fallback GitHub，不用二次 git clone
- Windows 调 npm.cmd 用 execSync 命令字符串（不带 shell 的 execFileSync 会 EINVAL；带 shell+args 会 DEP0190）
- vendor 不放 node_modules（npm 不打包），cdp-cli 运行时依赖 ws/yargs 由根 package.json 承担
- prepare-package copy 时排除 .gitignore（否则 npm pack 忽略 vendor/cdp-cli/build）
- 改 package.json 后必须 git add package-lock.json 同步，npm ci 验证
- cdp-cli 命令由 `src/cdp-cli-bin.ts` wrapper 提供（package.json bin），不依赖全局 npm link
- engines node >=20.19.0（yargs 18 要求）

发布流程：`npm run build:deps`（install+build，不 link）→ `npm run prepack`（build+build:deps+prepare-package）→ `npm pack` → `npm install -g ./tgz` → `cocoscli doctor` + `cdp-cli --help` 验证。

## 约定

- 代码无 Emoji（用 [完成] / [失败] 等纯文本）
- 中文注释 / Log
- UTF-8 编码
- Conventional Commits（feat: / fix: / docs: / chore:）
