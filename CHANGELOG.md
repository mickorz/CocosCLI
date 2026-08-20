# 更新日志

所有重要变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 当前版本 `0.0.1`，尚未正式发布，以下变更均归入 `[Unreleased]`。

## [Unreleased]

### 新增

#### 命令体系

- 初始工程管理四件套：`init`（安装 CocosMCP 扩展 + build + 写配置 + 打开）、`open`（打开工程）、`close`（关闭进程）、`remove`（卸载扩展）。`init`/`open` 默认免登录（自动追加 `--nologin`）。
- `build <platform>`：构建打包到指定平台（web-desktop / web-mobile / wechat / douyin 等），内置通用 buildConfig 生成。
- `verify <scene>`：综合验证（编译检查 + MCP/preview 连通 + opencode 预览场景 + 事件流监控），输出 `verify-report.md`。
- `compile [dir]`：编译检查（调 CocosMCP `run_script_diagnostics`），忠实使用工程 `tsconfig.json`。
- `lint [dir]`：ESLint 代码规范检查（忠实工程 `.eslintrc.json` + `tsconfig.eslint.json` + 工程本地 ESLint）。
- `previewscene <scene>`：切换场景并获取预览地址，在浏览器打开预览。
- `previewscene` 预览地址带参数：读 `.cocoscli/preview.config.json`（`default` 工程默认 + `scenes` 场景级覆盖，首次运行自动生成模板），`--query` 临时覆盖；优先级 `--query` > `scenes[场景名]` > `default` > 不加参数。
- `eval [code]`：在编辑器内执行任意 JS（CocosMCP `execute_script`），scene/editor 双上下文。
- `browserlogs`：读取浏览器控制台日志（cdp-cli console），支持级别/条数/关键词过滤。
- `list`：列出所有已执行 `init` 的工程（目录、CocosMCP 版本、MCP 端口）。
- `doctor`：依赖体检（git/node/npm/cdp-cli），逐项输出 [完成]/[失败]。

#### 工程管理

- 全局工程注册表（`~/.cocoscli/projects.json`）：`init` 登记、`remove` 注销、`list` 读取。
- MCP 端口自动错开：未传 `-p` 时读全局注册表挑空闲端口（首个工程 3001），多工程端口不冲突。
- `init -p <port>` 显式指定端口；撞已注册工程端口时直接中断并红字报冲突、推荐空闲端口。
- `init` 优先从 `vendor/CocosMCP` copy → `deps/CocosMCP` → fallback GitHub clone，发布态无需二次 git clone。
- `init` 已存在 CocosMCP 时 `git pull` 更新（拉最新含新工具）。
- CocosCreator 5 级查找（环境变量 → 系统命令 → editor.json → 常见目录 → 本地配置），偏好 3.7.3，找到后自动回写本地配置。

#### 构建打包

- `build` 生成 build-log：报错分类（syntax/module/runtime/editor）去重，chunk 哈希归一化，原始全文落盘 build-raw log。
- `build --fast`：快速模式，只查脚本编译，脚本阶段结束后 kill 进程树提前终止（不产出构建产物，有报错退出码 1）。
- `build --ignore-category <cats>`：显式忽略指定报错分类（errors 数组与退出码均过滤，被过滤行数记入 `ignoredErrorCount`）。

#### 编译检查

- `compile` 忠实使用工程 `tsconfig.json`（P1），废弃自拼 verify tsconfig。
- `compile.config.json` 配置驱动：`includePath` 白名单（只检查指定路径）+ `excludePath` 过滤（排除第三方/子模块目录）。
- 启动校验 `includePath`/`excludePath` 路径存在性，拼错时警告，堵静默失效。
- P2 runtime globals bridge（VirtualDeclaration + Commit/Rollback）：处理 pfbm/gf 等运行时模块注入全局导致的 tsc 误报。
- P3 gf `namespaceAlias`（复用 VirtualDeclaration）：处理 `gf=gameframe` 命名空间别名。
- compile log JSON 格式 + 时间戳文件名 + snippet 代码上下文。
- 工程根 `tsconfig.json` 缺失时自动生成推荐模板。

#### 编辑器交互

- `previewscene` 默认丢弃未保存改动直接切换场景（不弹保存框）。
- `previewscene --save`：切换前保存当前场景。
- `previewscene` 预览打开后自动最大化浏览器窗口并激活置前：CDP `Browser.setWindowBounds` + `Target.activateTarget` + 自动启动 Chrome 时叠加 `--start-maximized`；CDP 激活未确认时 OS 层兜底（Windows PowerShell AppActivate / macOS osascript / Linux wmctrl+xdotool），任一步失败仅黄字提示不阻断主流程。
- `eval` 三种代码出口：直接 `return` / `run(env)` / `module.exports`。
- `eval --context scene|editor`：scene 注入 `require/cc/Editor/scene/director/args` 操作活场景树；editor 注入 `require/Editor/args/fs/path/os` 用 Editor API 与文件操作。
- `eval -f <file>`：从文件读代码（长脚本推荐，规避一切转义）。
- `eval --args <json>`：传 JSON 对象给代码的 `args`。
- `eval --timeout <ms>`：执行超时（默认 120000）。
- `browserlogs` 支持 `--type`/`--tail`/`--duration`/`--all`/`--grep`/`--page` 过滤。
- `compile`/`browserlogs` 读 `.cocoscli/known_nonblocking_errors.json` 过滤已知非阻断项（compile 按 code 精确匹配+可选 file/message_contains 细化，browserlogs 按 text 子串匹配）；命中即过滤不计入 errors/logs（不写入 log JSON），终端仅提示过滤条数；配置不存在自动生成默认模板。

#### 发布与基础设施

- cdp-cli bin wrapper：`npm link` 后同时得到 `cocoscli` 与 `cdp-cli` 命令（指向 `deps/cdp-cli/build`）。
- `prepare-package` 脚本：打包 deps 到 vendor 供 `npm publish`，排除 .gitignore 让 build 进包。
- `build:deps` 与 `prepack` 脚本（build + build:deps + prepare-package）。
- CocosMCP 与 cdp-cli 作为 submodule 接入。
- 纯文本 spinner（ASCII + [完成]/[失败]），无 unicode 符号依赖。

### 变更

- `init` 安装 CocosMCP 由 submodule 改为 plain git clone，再改为 vendor/deps copy 优先 + fallback 远端。
- `open` 与 `init` 改为默认免登录（`--nologin`），原为可选 `--nologin` flag。
- spinner 由 ora unicode symbols 改为纯文本 ASCII。
- `compile` 移除 `--strict` 参数，改用 `.cocoscli/compile.config.json` 配置驱动。
- `compile` 从自拼 verify tsconfig 改为忠实使用工程 `tsconfig.json`。
- `lint` 的 `process.chdir` 包进 try/finally（`withProjectCwd`），避免工作目录泄漏。
- `compile-log` 不再记录 `noise`/`noiseSummary` 字段（log 只保留 errors 真实阻断项；terminal 仍展示 noise 摘要）。
- 各命令日志按命令分类归档到 `.cocoscli/logs/<命令>/` 子目录（compile / eval / lint / build / verify / browserlogs），`compile.config.json` 与 `buildConfig-<platform>.json` 等配置保留在 `.cocoscli/` 根目录；`writeCompileLog` 新增 `category` 参数支持，`build-raw-*.log` 与 `verify-report.md` 同步归入对应子目录。

### 移除

- `card-shoot` 命令及对应实现（`src/commands/card-shoot.ts`）与测试，不再内置卡片页切图能力（可由外部 cdp-cli 直接完成）。

### 修复

#### build 链路

- 构建成功但 CocosCreator 退出码非零时（macOS 无头构建已知现象，如退出码 36）加灰字提示，避免只看退出码误判构建失败。

#### verify 链路

- MCP port 读工程 `mcp-server.json`，不写死 3001。
- `run_script_diagnostics` 工具不存在时优雅跳过。
- 第3步 preview 轮询就绪（MCP 就绪时 preview server 可能还没起）。
- 第3步 MCP 检查使用 `readMcpPort` 读出的端口。
- MCP 不可达时检测代理环境变量拦截回环并黄字提示。
- 开头加 opencode 前置检查（找不到直接中断）。
- 第1步端口显示 + 第2步编译检查进度提示。
- opencode 路径搜索（PATH 找不到时查 npm 全局 prefix + `node_modules/opencode-ai/bin`）。

#### previewscene / browserlogs

- previewscene CDP 改用 `tabs+go+eval pageId`（实测跑通）。
- previewscene 检查4 CDP Chrome 不可达时自动启动。
- previewscene 切场景加 30 秒超时兜底。
- browserlogs 用 cdp-cli tabs 找预览页，找不到时中断提示先跑 `previewscene`。

#### compile

- 过滤工程外声明噪音 + `skipLibCheck` 双保险（`jsb.d.ts` 不再进 real）。
- `ensureVerifyTsconfig` 加 `*Module` paths，还原 Cocos 裸模块别名。
- preserve quoted import types in diagnostic grouping（带引号的 import 类型不丢）。
- clean stale strict messaging，log runtime global bridges。
- 真正检查 assets 目录 + 智能降噪 + Compiler API 收全量 diagnostics。

#### init / 工程管理

- 显式 `-p` 撞已注册工程端口时直接中断，红字报冲突并推荐空闲端口。
- `init` 命令支持 `[dir]` 位置参数，错误文案对齐其余命令。
- 识别 CocosMCP `node_modules` 缺失并给出明确修复提示。

#### eval

- `-f` 传文件时把第一个位置参数归位为工程目录（`cocoscli eval -f x.js <dir>` 不再被解析成 `code=<dir>`）。

#### 发布 / 依赖

- cdp-cli 入口路径 `dist` 改 `build`（cdp-cli tsc outDir 为 build）。
- cdp-cli 指针回 `562941b`（71a5b89 不在 remote 导致 submodule 悬空）。
- npm 调用加 `shell:true` 修复 Windows EINVAL。
- `setup-deps`/`prepare-package` 改 execSync 命令字符串 + 设 NODE_OPTIONS 抑制 DEP0190（含 CocosMCP preinstall）。
- P0 发布依赖 ws/yargs 由根 package.json 承担，`prepare-package` 排 `.gitignore` 让 build 进包。
- 同步 `package-lock.json`，`engines` 提到 `>=20.19.0`。

#### build

- 修复 build cwd 与 startScene 错误提示。

### 文档

- 新增 `Docs/cocoscli-CocosMCP能力接入指南.md`：CocosMCP 能力迁移到 CLI 的四步接入模式。
- 新增 `CLAUDE.md`：命令架构、compile 错误处理最高规则、发布注意事项。
- 新增 `Docs/cocoscli-compile-全局变量报错分析.md`：pfbm/xuanwu/gf 三类全局变量，编辑器 vs compile 机制差异。
- 新增 `Docs/cocoscli-submodule发布问题记录.md`。
- 新增 compile P3.2 TS2339 频次降噪 audit 基线与冻结决策。
- 新增 `.gitattributes` 与 `.gitignore`（含 `.idea` IDE 配置）。
