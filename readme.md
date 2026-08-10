# cocoscli

由于官方cocoscli只有cocos creator4以上的版本，旧的3.7项目不支持，所以开发了此项目。方便用于agent封装。
面向 Cocos Creator 3.7.x 的轻量命令行工具，提供工程初始化扩展、打开工程、关闭进程三个命令。open 与 init **默认免登录**（启动编辑器时自动追加 `--nologin`）。


## 功能

| 命令 | 说明 |
|---|---|
| `cocoscli init` | 为当前 Cocos 工程安装 CocosMCP 扩展并打开（默认免登录） |
| `cocoscli open [dir]` | 用 CocosCreator 打开工程，dir 省略时为当前目录（默认免登录） |
| `cocoscli close [dir]` | 关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录 |
| `cocoscli remove [dir]` | 卸载 CocosMCP（关闭工程、删除扩展与 settings 配置），dir 省略时为当前目录 |
| `cocoscli build <platform> [dir]` | 构建工程到指定平台（web-desktop/wechat/douyin 等），dir 省略时为当前目录 |
| `cocoscli verify <scene> [dir]` | 验证工程：tsc 编译检查 + MCP/preview 连通性 + opencode 预览场景，dir 省略时为当前目录 |
| `cocoscli doctor` | 依赖体检：检查 git/node/npm/cdp-cli 等关键依赖是否就绪 |

## 环境要求

- Node.js >= 18
- Cocos Creator 3.7.x（偏好 3.7.3）
- git（init 克隆扩展、submodule 拉取需要）
- cdp-cli（browserlogs/previewscene 依赖，`npm run setup` 安装）

## 安装

```bash
git clone --recurse-submodules https://github.com/mickorz/CocosCLI.git

cd CocosCLI
npm install
npm run setup     # 初始化 submodule 依赖（install + build CocosMCP 与 cdp-cli）
npm run build
npm link
```

`npm link` 后即可全局使用 `cocoscli` 与 `cdp-cli` 命令（cdp-cli 由 cocoscli 的 bin wrapper 提供，指向 deps/cdp-cli/build）。`npm run setup` 会 install + build `deps/CocosMCP` 与 `deps/cdp-cli`。普通 clone 后补一句 `git submodule update --init --recursive` 即可。

## 使用示例

### 打开工程

```bash
cocoscli open                # 打开当前目录工程（默认免登录）
cocoscli open D:\MyGame      # 打开指定工程（默认免登录）
```

open 会在启动 CocosCreator 时自动追加 `--nologin` 参数，跳过登录提示。

### 关闭工程

```bash
cocoscli close               # 关闭当前目录对应的进程
cocoscli close D:\MyGame     # 关闭指定工程对应的进程
```

close 通过匹配 CocosCreator 进程命令行的 `--project` 参数定位目标工程，精确比对路径，不会误关同名前缀工程。

### 卸载扩展

```bash
cocoscli remove               # 卸载当前目录的 CocosMCP
cocoscli remove D:\MyGame     # 卸载指定工程
```

remove 是 init 的逆操作：先关闭工程（如果在运行），再删除 `extensions/CocosMCP` 和 `settings/mcp-server.json`、`settings/tool-manager.json`。删除不可逆，但可用 `cocoscli init` 重新安装。

### 构建打包

```bash
cocoscli build web-desktop            # 构建当前工程到 web-desktop
cocoscli build web-desktop D:\MyGame  # 构建指定工程
cocoscli build wechat                 # 微信小游戏（映射到 wechatgame）
cocoscli build douyin                 # 抖音小游戏（映射到 bytedancegame）
```

build 内置打包逻辑：定位 CocosCreator → 生成通用 buildConfig（`.cocoscli/buildConfig-<platform>.json`）→ 调 `CocosCreator --project <工程> --build configPath=...`，产物在 `build/<platform>/`。支持的平台简称：`web`/`web-desktop`、`web-mobile`、`wechat`/`wechatgame`、`douyin`/`bytedance`/`bytedancegame`，其它名字原样传给 CocosCreator。

### 验证工程

```bash
cocoscli verify loading                      # 验证当前工程的 loading 场景
cocoscli verify loading D:\MyGame            # 验证指定工程
```

verify 会：启动 CocosCreator → `tsc --noEmit` 编译检查 → 验证 MCP 与 preview 连通 → 调 opencode（非交互，`run --format json`）预览场景并事件流监控，最后输出 `.cocoscli/verify-report.md`。状态监控细节见 `Docs/cocoscli-verify-opencode状态监控.md`。

### 依赖体检

```bash
cocoscli doctor
```

doctor 检查 cocoscli 运行所需关键依赖（git/node/npm/cdp-cli），逐项输出 [完成]/[失败]。任一缺失会明确提示跑 `npm run setup`，而不是在具体命令里拿到难分析的 `spawn ENOENT`。对 AI / opencode 自动调用尤其重要。

### 初始化扩展

```bash
cd D:\MyGame
cocoscli init                # 初始化扩展并打开（默认免登录）
```

init 会依次执行：

1. 定位本机 CocosCreator（5 级查找）
2. 判定当前目录是否 Cocos 3.x 工程
3. 安装 CocosMCP 到 `extensions/CocosMCP`（优先 vendor/deps copy，fallback git clone）
4. 构建 CocosMCP（`npm install` + `npm run build`，生成 `dist`，否则 CocosCreator 加载会报错）
5. 写入默认 `mcp-server.json` 到 `settings/`（端口 3001、autoStart 等，已存在则跳过）
6. 用 CocosCreator 打开工程（自动追加 `--nologin`）

> `tool-manager.json`（工具开关配置）由 CocosMCP 扩展首次打开时自动生成，cocoscli 不预置。

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
npm test             # vitest 单测
npm run dev          # tsx 直接运行源码
```

## 许可

MIT
