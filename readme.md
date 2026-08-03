# cocoscli

面向 Cocos Creator 3.7.x 的轻量命令行工具，提供工程初始化扩展、打开工程、关闭进程三个命令。

## 功能

| 命令 | 说明 |
|---|---|
| `cocoscli init` | 为当前 Cocos 工程安装 CocosMCP 扩展并打开 |
| `cocoscli open [dir]` | 用 CocosCreator 打开工程，dir 省略时为当前目录 |
| `cocoscli close [dir]` | 关闭工程对应的 CocosCreator 进程，dir 省略时为当前目录 |

## 环境要求

- Node.js >= 18
- Cocos Creator 3.7.x（偏好 3.7.3）
- git（init 命令克隆扩展需要）

## 安装

```bash
cd CocosCLI
npm install
npm run build
npm link
```

`npm link` 后即可全局使用 `cocoscli` 命令。

## 使用示例

### 打开工程

```bash
cocoscli open                # 打开当前目录工程
cocoscli open D:\MyGame      # 打开指定工程
```

### 关闭工程

```bash
cocoscli close               # 关闭当前目录对应的进程
cocoscli close D:\MyGame     # 关闭指定工程对应的进程
```

close 通过匹配 CocosCreator 进程命令行的 `--project` 参数定位目标工程，精确比对路径，不会误关同名前缀工程。

### 初始化扩展

```bash
cd D:\MyGame
cocoscli init
```

init 会依次执行：

1. 定位本机 CocosCreator（5 级查找）
2. 判定当前目录是否 Cocos 3.x 工程
3. 克隆 CocosMCP 扩展到 `extensions/CocosMCP`
4. 用 CocosCreator 打开工程

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
