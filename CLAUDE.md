# CLAUDE.md

cocoscli —— 面向 Cocos Creator 3.7.x 的命令行工具。

## 命令

| 命令 | 说明 |
|---|---|
| `cocoscli init [dir] [-p port]` | 装 CocosMCP（普通 clone）+ build + 写 mcp-server.json / opencode.json + 打开（默认免登录），dir 省略时为当前目录；端口优先级 mcp-server.json 已有 > 显式 -p（撞已注册工程直接中断并推荐空闲口）> 自动错开（读全局注册表挑空闲口，首个 3001） |
| `cocoscli open [dir]` | 打开工程（默认免登录，已开则跳过） |
| `cocoscli close [dir]` | 关闭工程对应的 CocosCreator 进程 |
| `cocoscli remove [dir]` | 卸载 CocosMCP（关闭工程 + 删扩展 + 删配置 + 从全局列表注销） |
| `cocoscli list` | 列出已执行 init 的工程（目录、CocosMCP 版本、MCP 端口，全局 ~/.cocoscli/projects.json） |
| `cocoscli build <platform> [dir] [--fast] [--ignore-category runtime,...]` | 构建打包到指定平台 + 生成 build-log（报错分类 syntax/module/runtime/editor 去重，chunk 哈希归一化；构建不做类型检查，类型错误跑 compile）；`--fast` 只查脚本编译，脚本阶段结束后 kill 进程树提前终止（不产出产物，有报错退出码 1）；`--ignore-category` 显式忽略分类（log 的 errors 数组与退出码均过滤该分类，被过滤行数记入 ignoredErrorCount，原始全文见 build-raw log） |
| `cocoscli verify <scene> [dir]` | 验证：编译检查 + MCP/preview + opencode 预览场景 |
| `cocoscli compile [dir]` | 编译检查（cocos-mcp run_script_diagnostics）+ 生成 log；读 .cocoscli/known_nonblocking_errors.json 过滤已知非阻断 error（不计 real 不写入 log） |
| `cocoscli lint [dir]` | ESLint 代码规范检查（忠实工程 .eslintrc.json + tsconfig.eslint.json + 工程本地 ESLint）+ 生成 eslint-log |
| `cocoscli eval [code] [dir] [--context scene\|editor] [--args json] [-f file] [--timeout ms]` | 在编辑器内执行任意 JS（CocosMCP execute_script 工具）：scene 上下文注入 require/cc/Editor/scene/director/args 操作活场景树，editor 上下文注入 require/Editor/args/fs/path/os 用 Editor API 与文件操作；三出口直接 return / run(env) / module.exports；结果 JSON 打印 + 写 .cocoscli/logs/eval/eval-log-*.json；长脚本推荐 -f 文件入口（PowerShell 外层单引号防 `${}` 插值被吃） |
| `cocoscli previewscene <scene> [dir] [--save]` | 切换场景并获取预览地址（CocosMCP），在浏览器打开预览；默认丢弃未保存改动直接切换（不弹保存框），`--save` 切换前保存当前场景 |

## 架构

```
src/
├── index.ts           commander 注册命令
├── commands/          命令入口（init / open / close / remove / list / build / verify / compile / lint / eval）
├── utils/
│   ├── cocos.ts       5 级查找 CocosCreator + 打开
│   ├── project.ts     工程判定 + 路径规范化
│   ├── process.ts     跨平台进程查杀
│   ├── git.ts         clone CocosMCP + build + 写配置
│   ├── build.ts       构建打包
│   ├── verify.ts      编译检查 + MCP/preview 验证 + opencode 事件流监控 + execute_script 执行（含通用 HTTP 函数）
│   ├── lint.ts        ESLint 规范检查（工程本地 ESLint + .eslintrc.json，不经 CocosMCP）
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

## compile 错误处理最高规则

处理 compile 报错（尤其是「编辑器不报、compile 报」的差异）时，遵循最高规则：

**不要试图判断「这个错误要不要忽略」，而应该先问「我是不是缺少了这个项目真实运行环境的类型信息」。**

- 当 CocosCreator 编辑器不报但 cocoscli compile（纯 tsc）报错时，差距几乎总是**类型信息缺失**，不是代码错误。典型场景：
  - 运行时全局注入（pfbm/gf 是模块 export 被 cc 模块系统注入全局）→ tsc 缺少 `declare const pfbm/gf`
  - 构建期注入（xuanwu 由 xuanwu_tools SDK 生成）→ 声明文件不在 tsconfig include 范围
  - 命名空间别名（gf=gameframe）→ 缺少 `declare namespace gf` / `declare const gf`
  - 裸模块别名（*Module）→ 缺少 tsconfig paths 映射
- **正确方向（治本）：补全缺失的类型信息**——加全局声明、补 include、加 paths 映射。补不了的（工程特定 / 声明确实缺失）如实暴露给用户决策。
- **错误方向（治标）：用启发式降噪 / 分类（频率阈值、多维 suspectedGlobal）去「判断要不要忽略」**。这会误判（复制粘贴的真错也可能高频跨文件），且掩盖了真正缺类型信息的根因。绝不静默吞掉报错。

详见 [Docs/cocoscli-compile-全局变量报错分析.md](../Docs/cocoscli-compile-全局变量报错分析.md)。

## 开发

```bash
npm run build       # tsc 编译
npm test            # vitest 单测
npm link            # 全局链接 cocoscli（同时得到 cocoscli 与 cdp-cli 命令）
```

## 同步到 game-mahjong cocos_tools 副本

本库每次 git 提交后，必须同步一次到 game-mahjong 的 cocos_tools 副本：

```
python sync_to_cocos_tools.py
```

- 目标：`E:\WorkProjects\xc-flow\.xflow\xc\xcodeDev\game-mahjong\client\cocos_tools\cocoscli`
- 镜像同步、增量复制（按大小 + 修改时间）；源里删除的文件目标同步删除
- 不复制 git 元信息（.git / .gitmodules / .gitattributes）
- `.gitignore` 目标侧独立维护（需提交 deps/node_modules，不覆盖不删除）
- 副本侧已删除 .git，是普通目录，归 game-mahjong 自己的仓库管理

## 提交后同步触发规则

凡在本仓库执行 `git commit`（含 amend、merge 产生的提交），提交完成后立即执行一次同步：

1. `python sync_to_cocos_tools.py`（在仓库根目录）
2. 查看输出确认：`[完成] 复制 N 个文件 ... 删除 M 项`，无 `[失败]`
3. 有报错时先修复同步问题，再继续其他任务

多个提交连续进行时，可全部提交完后同步一次（以最后一次为准）。

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
- 每次提交后，根据最新提交信息同步更新 readme.md 与 CHANGELOG.md：README 对应命令表 / 参数 / 使用示例，CHANGELOG 按 Keep a Changelog 分类（新增 / 变更 / 修复 / 文档）追加条目
