# cocoscli

由于官方 cocoscli 只支持 Cocos Creator 4 以上版本，旧 3.7 项目不支持，故开发此项目，方便 Agent 封装。
面向 Cocos Creator 3.7.x 的命令行工具，提供工程初始化、构建打包、编译检查、场景预览、编辑器脚本执行等能力。`open` 与 `init` **默认免登录**（启动编辑器时自动追加 `--nologin`）。

## 功能

| 命令 | 说明 |
|---|---|
| `cocoscli init [dir] [-p port]` | 为工程安装 CocosMCP 扩展 + build + 写配置 + 打开（默认免登录）；端口优先级 mcp-server.json 已有 > 显式 `-p`（撞已注册工程直接中断）> 自动错开（首个 3001） |
| `cocoscli open [dir]` | 用 CocosCreator 打开工程（默认免登录），已开则跳过 |
| `cocoscli close [dir]` | 关闭工程对应的 CocosCreator 进程 |
| `cocoscli remove [dir]` | 卸载 CocosMCP（关闭工程 + 删扩展 + 删配置 + 从全局列表注销） |
| `cocoscli list` | 列出已执行 `init` 的工程（目录、CocosMCP 版本、MCP 端口） |
| `cocoscli build <platform> [dir] [--fast] [--ignore-category ...]` | 构建打包到指定平台 + 生成 build-log（报错分类去重） |
| `cocoscli verify <scene> [dir]` | 验证：编译检查 + MCP/preview + opencode 预览场景 |
| `cocoscli compile [dir]` | 编译检查（cocos-mcp run_script_diagnostics）+ 生成 log |
| `cocoscli lint [dir]` | ESLint 代码规范检查（忠实工程 .eslintrc.json）+ 生成 eslint-log |
| `cocoscli previewscene <scene> [dir] [--save]` | 切换场景并获取预览地址，在浏览器打开预览（自动最大化并置前窗口） |
| `cocoscli eval [code] [dir] [--context scene\|editor] [--args json] [-f file] [--timeout ms]` | 在编辑器内执行任意 JS（CocosMCP execute_script） |
| `cocoscli browserlogs [dir] [--type] [--tail] [--grep]` | 读取浏览器控制台日志（cdp-cli） |
| `cocoscli doctor` | 依赖体检：检查 git/node/npm/cdp-cli 是否就绪 |

## 环境要求

- Node.js >= 20.19.0
- Cocos Creator 3.7.x（偏好 3.7.3）
- git（init 克隆扩展、submodule 拉取需要）
- cdp-cli（browserlogs/previewscene 依赖，随 cocoscli 一并安装，`npm run setup` 构建）

## 安装

```bash
git clone --recurse-submodules https://github.com/mickorz/CocosCLI.git

cd CocosCLI
npm install
npm run setup     # 初始化 submodule 依赖（install + build CocosMCP 与 cdp-cli）
npm run build
npm link
```

`npm link` 后即可全局使用 `cocoscli` 与 `cdp-cli` 命令（cdp-cli 由 cocoscli 的 bin wrapper 提供，指向 `deps/cdp-cli/build`）。`npm run setup` 会 install + build `deps/CocosMCP` 与 `deps/cdp-cli`。普通 clone 后补一句 `git submodule update --init --recursive` 即可。

> 发布态安装：`npm install -g cocoscli` 后直接得到 `cocoscli` 与 `cdp-cli` 两个命令，无需手动 setup（vendor 已预置构建产物）。

## 使用示例

### 工程管理

```bash
cocoscli init                # 初始化当前目录工程并打开（默认免登录）
cocoscli init D:\MyGame      # 初始化指定工程
cocoscli init -p 3002        # 指定 MCP 端口（省略时自动错开，首个工程 3001）
cocoscli open                # 打开当前目录工程（已开则跳过）
cocoscli open D:\MyGame      # 打开指定工程（默认免登录）
cocoscli close               # 关闭当前目录对应的进程
cocoscli close D:\MyGame     # 关闭指定工程对应的进程
cocoscli remove              # 卸载当前目录的 CocosMCP
cocoscli list                # 列出所有已注册工程
```

`init` 会依次执行：定位 CocosCreator → 判定 Cocos 3.x 工程 → 安装 CocosMCP（优先 `vendor/CocosMCP` copy → `deps/CocosMCP` → fallback GitHub clone）→ build 扩展 → 写 `settings/mcp-server.json` → 用 CocosCreator 打开（追加 `--nologin`）→ 登记到全局工程注册表。

`close` 通过匹配 CocosCreator 进程命令行的 `--project` 参数定位目标工程，精确比对路径，不会误关同名前缀工程。

`remove` 是 `init` 的逆操作：先关闭工程，再删除 `extensions/CocosMCP`、`settings/mcp-server.json` 等配置，并从全局注册表注销。

### 构建打包

```bash
cocoscli build web-desktop            # 构建当前工程到 web-desktop
cocoscli build web-desktop D:\MyGame # 构建指定工程
cocoscli build wechat                # 微信小游戏（映射到 wechatgame）
cocoscli build douyin                # 抖音小游戏（映射到 bytedancegame）
cocoscli build web-mobile --fast     # 快速模式：只查脚本编译，脚本阶段后提前终止（不产出产物）
cocoscli build web-desktop --ignore-category runtime  # 忽略 runtime 分类报错
```

build 内置打包逻辑：定位 CocosCreator → 生成通用 buildConfig（`.cocoscli/buildConfig-<platform>.json`）→ 调 `CocosCreator --project <工程> --build configPath=...`，产物在 `build/<platform>/`。支持的平台简称：`web`/`web-desktop`、`web-mobile`、`wechat`/`wechatgame`、`douyin`/`bytedance`/`bytedancegame`，其它名字原样传给 CocosCreator。

构建结束生成 build-log（报错分类 syntax/module/runtime/editor 去重，chunk 哈希归一化）。`--fast` 只查脚本编译，脚本阶段结束后 kill 进程树提前终止（不产出产物，有报错退出码 1）。`--ignore-category` 显式忽略分类（log 的 errors 数组与退出码均过滤该分类，被过滤行数记入 `ignoredErrorCount`，原始全文见 build-raw log）。构建不做类型检查，类型错误请跑 `compile`。

### 验证与检查

```bash
cocoscli verify loading               # 验证当前工程的 loading 场景
cocoscli verify loading D:\MyGame     # 验证指定工程
cocoscli compile                     # 编译检查当前工程
cocoscli compile D:\MyGame           # 编译检查指定工程
cocoscli lint                        # ESLint 检查当前工程
cocoscli lint D:\MyGame              # ESLint 检查指定工程
```

`verify` 会：启动 CocosCreator → `tsc --noEmit` 编译检查 → 验证 MCP 与 preview 连通 → 调 opencode（非交互，`run --format json`）预览场景并事件流监控，最后输出 `.cocoscli/verify-report.md`。

`compile` 调用 CocosMCP 的 `run_script_diagnostics` 做编译检查，忠实使用工程 `tsconfig.json`，支持 `compile.config.json` 配置 includePath/excludePath 白名单，生成 `.cocoscli/compile-log-*.json`（JSON 格式 + 时间戳文件名 + snippet 代码上下文）。工程根 `tsconfig.json` 缺失时自动生成推荐模板。

`lint` 忠实使用工程的 `.eslintrc.json` + `tsconfig.eslint.json` + 工程本地 ESLint，生成 `.cocoscli/eslint-log-*.json`。

### 编辑器交互

```bash
cocoscli previewscene loading              # 切换到 loading 场景并打开预览
cocoscli previewscene loading --save       # 切换前保存当前场景（默认丢弃未保存改动直接切）
cocoscli browserlogs                       # 读取预览页控制台日志
cocoscli browserlogs --type error          # 只看 error 级别
cocoscli browserlogs --tail 50             # 只看最后 50 条
cocoscli browserlogs --grep "Uncaught"     # 关键词过滤
cocoscli eval "return cc.director.getScene().name"   # 在场景上下文执行 JS
cocoscli eval "return Editor.assetdb.uuidToUrl(args.id)" --context editor --args '{"id":"abc"}'
cocoscli eval -f script.js D:\MyGame       # 从文件读代码执行（长脚本推荐）
```

`previewscene` 切换场景并获取预览地址（CocosMCP），在浏览器打开预览。默认丢弃未保存改动直接切换（不弹保存框），`--save` 切换前保存当前场景。预览打开后自动最大化浏览器窗口并激活置前（CDP setWindowBounds + activateTarget，CDP 失败时 OS 层兜底）。

`eval` 在编辑器内执行任意 JS（CocosMCP execute_script）。scene 上下文注入 `require/cc/Editor/scene/director/args`，操作活场景树；editor 上下文注入 `require/Editor/args/fs/path/os`，用 Editor API 与文件操作。三种代码出口：直接 `return` / `run(env)` / `module.exports`。结果 JSON 打印 + 写 `.cocoscli/eval-log-*.json`。长脚本推荐 `-f` 文件入口（PowerShell 外层单引号防 `${}` 插值被吃）。

`browserlogs` 通过 cdp-cli 读取 CDP Chrome 中预览页的控制台日志，支持级别/条数/关键词过滤。找不到预览页时会提示先跑 `previewscene`。

### 工具命令

```bash
cocoscli doctor                          # 依赖体检
```

`doctor` 检查 cocoscli 运行所需关键依赖（git/node/npm/cdp-cli），逐项输出 [完成]/[失败]。任一缺失会明确提示跑 `npm run setup`，对 AI / opencode 自动调用尤其重要。

## .cocoscli 目录

各命令生成的报告与日志统一存放在工程根目录的 `.cocoscli/` 下：

| 文件 | 来源命令 | 说明 |
|---|---|---|
| `buildConfig-<platform>.json` | build | 通用构建配置 |
| `build-log-*.json` / `build-raw-log-*.txt` | build | 报错分类去重日志 / 原始全文 |
| `compile-log-*.json` | compile | 编译诊断（JSON + 时间戳 + snippet） |
| `compile.config.json` | compile | 编译检查配置（includePath/excludePath 白名单） |
| `eslint-log-*.json` | lint | ESLint 结构化结果 |
| `verify-report.md` | verify | 验证综合报告 |
| `eval-log-*.json` | eval | 脚本执行结果 |

## 全局工程注册表

执行 `init` 的工程会登记到全局注册表，`remove` 时注销：

- Windows: `%USERPROFILE%/.cocoscli/projects.json`
- macOS / Linux: `~/.cocoscli/projects.json`

`list` 命令读取此文件列出所有工程（目录、CocosMCP 版本、MCP 端口）。`init` 未指定 `-p` 时会读注册表挑空闲端口自动错开，避免多工程 MCP 端口冲突。

## CocosCreator 定位优先级

| 顺序 | 来源 |
|---|---|
| 1 | 环境变量 `COCOS_CREATOR_PATH` / `COCOS_CREATOR` |
| 2 | 系统命令 `where` / `which` |
| 3 | `~/.Cocos/profiles/editor.json` |
| 4 | 常见安装目录（C/D 盘 Program Files 等） |
| 5 | 本地配置 `cocoscli.json` 写死值 |

偏好版本 3.7.3，机器上没有时按版本号降序择优。找到后会自动回写到本地配置，下次直接命中。

## 本地配置

配置文件位置：

- Windows: `%APPDATA%/cocoscli/cocoscli.json`
- macOS: `~/Library/Application Support/cocoscli/cocoscli.json`
- Linux: `~/.config/cocoscli/cocoscli.json`

可手动编辑 `cocosCreatorPath` 字段固定 CocosCreator 路径，跳过自动查找。

## 开发

```bash
npm run build        # tsc 编译到 dist
npm run build:watch  # 增量监听
npm run dev          # tsx 直接运行源码
npm test             # vitest 单测
npm run build:deps  # install + build submodule 依赖（不 link）
npm run prepack      # build + build:deps + prepare-package（发布前）
```

## 许可

MIT
