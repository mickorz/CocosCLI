# cocoscli compile 语法错误阻断问题

> 状态：**已解决**（2026-08-12）。方案：cocos-mcp 改用 TypeScript Compiler API 收全量 diagnostics。

## 零、最终结论（已实现 + 验证）

cocos-mcp `run_script_diagnostics` 改用 `ts.createProgram` + `getSyntacticDiagnostics` + `getSemanticDiagnostics`（替代 `tsc -p` CLI），一次拿 syntactic + semantic 全量；cocoscli 配套用 category 分类（syntactic 全归 real 不降噪，semantic 走原降噪规则）。

验证（game-mahjong/client，重启 CocosCreator 加载新 CocosMCP 后）：
- testerror **6 个脚本一次拿全**（syntactic 2 + semantic 21），不再被语法错误阻断。
- 全工程 real 652（syntactic 2 + semantic 650）+ noise 1584 折叠。
- 两侧改完（cocos-mcp diagnostics.ts + cocoscli verify/compile/verify command + 测试），CocosMCP build + 重启编辑器后生效。



## 一、问题

`cocoscli compile` 无法获取工程所有报错脚本——当工程有任意脚本存在语法错误（TS1xxx，如缺逗号）时，compile 只输出语法错误所在文件，其他所有脚本的类型错误全消失。

## 二、现象（game-mahjong 工程）

- `assets/scripts/testerror/` 下 6 个脚本都有错误（语法 / 类型 / 未定义 / 属性 / 参数 / 模块引用）。
- 01 有语法错误（TS1005）时，compile 只报 01 的 2 条语法错误，**02-06 的 16 条类型错误全消失**（noise total = 0）。
- 用户诉求：compile 一次获取所有报错脚本。

## 三、根因（2026-08-12 修正）

`compile` 调 cocos-mcp `run_script_diagnostics`，后者用 `tsc -p tsconfig` **命令行**编译。**`tsc` CLI 的 diagnostics pipeline 会短路**：先取 syntactic diagnostics，若存在则不再调用 `getSemanticDiagnostics()`。

> **重要澄清**：这不是「TypeScript 编译器无法做类型检查」。TypeScript parser 有 error recovery，Program 能正常建立，**Compiler API（ts.createProgram + getSemanticDiagnostics）能在有语法错误时照常拿其他文件的类型错误**。短路仅发生在 `tsc` CLI 的报告 pipeline（emitFilesAndReportErrors 的策略）。详见第九节的最小复现。

## 四、当前缓解（已实现，将被 Compiler API 取代）

加了 `isSyntaxError(code)` 检测 TS1xxx + 阻断提示。注：切换 Compiler API 后，不再需要靠 code 判语法错误——syntactic/semantic 由 Compiler API 天然分类。

## 五、未解决的核心诉求

一次获取工程所有报错脚本（语法 + 类型全报）。

## 六、候选方向（优先级已重排）

| 方案 | 推荐度 | 说明 |
|---|---|---|
| **TypeScript Compiler API** | 最高 | 一次 Program，一次检查，直接拿 syntactic + semantic。天然分类，不绕路 |
| Language Service | 中 | 能做到（类似 VSCode），但实现复杂 |
| compile 自动 exclude 重跑 | 低 | 可作 Compiler API 兼容问题的 fallback。慢（2 次编译） |
| 每文件单独 tsc | 低 | 太慢，破坏项目级类型关系 |
| Cocos build | 不可行 | 已实测排除（第八节），不做类型检查 |

## 七、当前进展

- 已实现：tsconfig 修复（检 assets）+ 智能降噪 + 语法错误阻断提示。
- 根因修正：tsc CLI pipeline 短路（非编译器无法类型检查）。
- 下一步：改 cocos-mcp `run_script_diagnostics`，用 Compiler API 替代 `tsc -p`。

## 八、build 实测结论（2026-08-12）

跑 `cocoscli build web-desktop` 实测（exit=0，日志 11472 行）：

- build 日志覆盖 testerror 的 **01/03/04/06**（语法 / 运行时引用 / 模块加载错误）。
- **完全不含 02/05**（类型错误），类型错误数 = 0。
- 原因：CocosCreator build 走 PackerDriver（逐文件转译/加载），**不做类型检查**。
- build exit=0 即使脚本有错：PackerDriver 把出错脚本替换成运行时 throw 的占位模块，build 照样完成。**build「成功」≠ 脚本无错**。
- build 日志格式极乱（PackerDriver 错误是 URL 编码的 data:text/javascript + 栈追踪），解析困难。

结论：build 与 compile 互补（build 拿语法/运行时，compile 拿类型），不能相互替代。

## 九、根因深入（修正版）：tsc CLI 短路，非编译器能力限制

> 本节经最小复现修正。之前的「AST 不完整 → 无法建立 Program → 类型检查无法进行」解释**不准确**。

### 准确机制：tsc CLI 的 diagnostics pipeline 短路

`tsc` CLI 的 `emitFilesAndReportErrors()` 报告诊断的顺序：

```
Config diagnostics
        ↓
Syntactic diagnostics
        ↓
存在 syntactic errors？
   ├── 是 → 不调用 getSemanticDiagnostics()（短路）
   └── 否 → Global diagnostics → Semantic diagnostics
```

所以 `tsc -p` 遇到语法错误时，只输出 syntactic，跳过 semantic——这是 **CLI 的报告策略**，不是编译器能力限制。TypeScript Compiler 本身完全能在有语法错误时做语义分析（parser 有 error recovery，Program 能建立）。

### 最小复现（本工程实测，2026-08-12）

用编辑器内置 typescript 4.6.3 的 Compiler API 跑同一份 `.cocoscli/tsconfig.verify.json`：

| 来源 | syntactic | semantic | testerror 覆盖 |
|---|---|---|---|
| `tsc -p`（CLI） | 2 | **0（被短路）** | 只有 01 |
| `ts.createProgram + getPreEmitDiagnostics`（Compiler API） | 2 | 20361 | **01-06 全 6 个脚本** |

Compiler API 一次拿到 01 的语法错误 + 02-06 的全部类型错误。对比证明：**Compiler API 能拿全，tsc CLI 短路是唯一元凶**。

### 与 C# Roslyn 的对比（修正）

之前的对比把 tsc 描述成「不容错」不准确。准确说法：

| 维度 | C# Roslyn | TypeScript |
|---|---|---|
| Compiler API | 容错，报全 | **容错，报全**（getPreEmitDiagnostics） |
| 命令行默认 pipeline | dotnet build 也容错，报全 | **tsc -p 短路**（有 syntactic 就不调 semantic） |

差距不在「编译器容错能力」（两者 Compiler API 都容错），而在「**默认 CLI pipeline 是否短路**」：Roslyn 的命令行不短路，tsc 的命令行短路。

### 类比（修正）

- **Roslyn / TS Compiler API**：耐心的老师，某题格式错了圈出来继续批，最后告诉你所有错题。
- **tsc CLI**：严格的老师，发现格式错就停笔，只告诉你格式错的那题——但同一个老师（TypeScript）换种问法（Compiler API）就会继续批。

### 结论与方案

问题性质重定性：**不是「绕过编译器语法错误阻断」，而是「别用 tsc CLI 的默认 pipeline，直接用 Compiler API 收全量 diagnostics」**。

最优方案：改 cocos-mcp `run_script_diagnostics`，用 `ts.createProgram` + `ts.getPreEmitDiagnostics(program)`（或分开 getSyntacticDiagnostics + getSemanticDiagnostics）一次拿全。返回结构天然带 syntactic/semantic 分类，cocoscli 侧用 category 替代 isSyntaxError(code)。

### 参考

- TypeScript Compiler API：https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- tsc CLI 短路逻辑（emitFilesAndReportErrors）：https://github.com/microsoft/TypeScript/blob/main/src/compiler/watch.ts
