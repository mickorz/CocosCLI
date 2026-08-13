# cocoscli compile 模仿 CocosCreator 类型环境方案：可行性分析与设计

> 目标：把 cocoscli compile 从「tsc + 错误过滤器」升级成「Cocos-aware TypeScript Checker」——修 Type Environment 重新生成 diagnostics，而不是修 diagnostics 本身。
> 核心原则（本工程 CLAUDE.md 最高规则）：**不要试图判断「这个错误要不要忽略」，而应该先问「我是不是缺少了这个项目真实运行环境的类型信息」。**
> 状态：**v7——P1+P2 已实施完成并闭环（xuanwu 58→0；pfbm bridge 成功 60→0 / 失败 rollback 不降检查能力），进入 P2.5/P3**。
> 修订记录：
> - v1（2026-08-13）：初版评审外部方案，确立方向 + 5 阶段。
> - v2（2026-08-13）：吸收 8 项关键修正——路线 C / 依赖 extends 解析 / Declaration Index / Virtual SourceFile / incremental + cache / 可证明条件且绝不 any / gf alias 仅服务 checker / 阶段重排为 7 阶段。
> - v3（2026-08-13）：吸收 5 项细化——阶段 0 实验 4 不改真实源码 / Index 拆 Ambient + Module Export 双索引 / 扫描范围 P0-P3 优先级 / cache fingerprint 失效条件 / RESOLVED 与 SUSPECTED 移出 diagnostic 归入 Type Environment Resolution 层；「绝不 any」提升为类型层 invariant。
> - v4（2026-08-13）：**阶段 0 四实验完成，出现颠覆性发现——当前大头误报根因是自拼 `tsconfig.verify.json`，而非缺 Global Resolver**。xuanwu 谜底揭晓（声明在 project_dts，自拼 tsconfig 丢了 include）。方案优先级重排为 P1 换项目 tsconfig / P2 pfbm bridge / P3 gf alias / suspectedGlobal 不需要。v3 通用架构保留为「未来工程通用」。
> - v5（2026-08-13）：4 点收紧——① Type Environment Loader 写成 **prefer project tsconfig + fallback**（不硬编码「永远 project/tsconfig.json」）② P1 **只 overlay `noEmit`，不默认改 strict**（默认完全尊重 project tsconfig，仅 `--strict` 才 override）③ P3 前加 **P2.5 调查剩余 4 条 gf**（先解释 diagnostic 再补，不盲目 alias）④「真 runtime global 只剩 pfbm」**限定为本次已调查三类中唯一**。补 P1 实施规范 + 6 项验收标准 + 「先忠实再 Cocos-aware」实施哲学。
> - v6（2026-08-13）：**P1 实施完成 + 验收**。`compile.ts` 改忠实模式（废弃 `ensureVerifyTsconfig` 自拼，cocos-mcp 用 project tsconfig.json）。实测 xuanwu 58→0、pfbm 60（real）、real 665（忠实 strict:true vs 之前 311）。发现 **gf TS 版本敏感性**（编辑器 4.6=167 全 noise vs cocoscli 5.9=4）。6 项验收 5 项通过 + gf 版本差异 1 项待 P2.5 在 4.6 链路复查。
> - v7（2026-08-13）：**P2 实施完成 + 闭环**。cocos-mcp 通用 VirtualDeclaration Host（createCompilerHost 包一层 + virtual 加入 rootNames + diagnostics 分层）+ cocoscli runtimeGlobals 配置 / bridge 生成；**Type Environment Commit / Rollback（fail closed，事务语义）**——bridge 验证失败重跑无 bridge，业务回到 TS2304，绝不 implicit any。7 项验收全过（pfbm 成功 60→0 强类型 / 配错 rollback 恢复 60 不降检查能力）。

## 一、核心判断与定位

方向认可：把「补类型信息」从手工补声明升级为自动化 Global Resolver，让运行时全局变量从「误报」变成「真正被 TS 正确检查」。

定位（决定所有取舍）：

> cocoscli 的目标不是「找到最新版 TypeScript 认为错误的代码」，而是「**找到 Cocos 项目真实需要修复的 TypeScript 错误**」。

## 二、阶段 0 实验结论（v4 核心）

阶段 0 四个验证实验已在 game-mahjong（Cocos 3.7.3）上跑通，探查脚本 `scripts/probe-type-env.ts`（cocoscli TS 5.9.3，直接用项目 tsconfig.json）。**核心假设全部验证通过，但出现颠覆性发现。**

### 2.1 实验数据汇总

| 全局 | baseline（项目 tsconfig） | inject 后 | 之前自拼 tsconfig.compile | 结论 |
|---|---|---|---|---|
| pfbm TS2304 | 61 | **0** | 61 | 强类型 bridge 完美解决 |
| xuanwu TS2304 | **0** | 0 | 58 | 项目 tsconfig 直接归零 |
| gf TS2503 | **4** | 4 | 167 | 大头是自拼 tsconfig 丢失，仅剩 4 需 alias |

baseline 其它：rootNames **1944**、createProgram **3.6 秒**、strict:true、isolatedModules:false、paths `{kiwi, *}`、types 指向 `lint/declarations/{cc,jsb,...}`。

### 2.2 颠覆性发现：大头误报根因是自拼 tsconfig，不是缺 Global Resolver

当前 cocos-mcp（`deps/CocosMCP/source/tools/diagnostics.ts`）createProgram 用的 tsconfig，是 cocoscli 在 `.cocoscli/tsconfig.verify.json` 自拼的（`src/utils/verify.ts:ensureVerifyTsconfig`）：

- base **extends `temp/tsconfig.cocos.json`**（Creator 内部配置，target ES2015 + `db://` 虚拟路径 + 无 include）
- **`types: []`**（清空 → cc/jsb 等 Cocos 类型声明全丢）
- **`paths: *Module`**（窄化，丢了项目本有的 `kiwi` 和 `*` 通配）
- include 是自定的，**不含 `project_dts/*.d.ts`、`dts/*.d.ts` 等项目真实声明目录**

而项目 `client/tsconfig.json` 本身就是 **Cocos 为 IDE/tsc 准备的完整正确类型环境**（types→lint/declarations、include→assets/dts/project_dts/fgui、paths→kiwi+`*`、target ES2017），cocoscli 却完全没用它。

**结论**：之前 compile 报的 xuanwu 58 + gf 167 两个「大头」，主要是自拼 tsconfig.verify.json 的 bug，**不是真问题**。换用项目 tsconfig：xuanwu 直接归零，gf 从 167 降到 4。前几轮设计的 Declaration Index / xuanwu recovery / 多维降噪，对 game-mahjong 来说大部分用不上。

### 2.3 xuanwu 谜底

`project_dts/ConfigInterface.d.ts:1` 有 `declare namespace xuanwu`，项目 tsconfig 的 include 含 `./project_dts/*.d.ts` → 声明在 Program 内 → 不报 TS2304。自拼 tsconfig 的 include 丢了 project_dts → 才报 xuanwu 58。**xuanwu 根本不需要 declaration recovery，换对 tsconfig 就归零。**

（`xuanwu_tools/.../AdapterInterface.d.ts:35` 的 `declare namespace xuanwu.adapter` 是嵌套子命名空间，不是顶层 xuanwu 的来源。）

### 2.4 核心证明：pfbm bridge 补检查，不是降噪

实验 4 注入 `declare const pfbm: typeof import("kiwi").pfbm`：
- pfbm TS2304：61 → **0**
- runtime-globals.d.ts 自身**无诊断**（`import("kiwi").pfbm` 解析成功，kiwi/index → kiwiModule → PrefabManger 的 re-export 链通了）
- 故意写错 `pfbm.notExistMethodAbc_xyz()` 被精确抓到：

```
TS2339: Property 'notExistMethodAbc_xyz' does not exist on type 'PrefabManger'.
```

**bridge 保留了 PrefabManger 整条类型链**——写错方法名报在 PrefabManger 类型上，而非被 any 放行。这是方案核心论点「补 Type Environment = 真正补检查，不是降噪」的硬实证，也是后续 AI 自动修复能正确识别 `pfbm.xxx()` 真实错误的前提。

### 2.5 诚实保留

实验用 cocoscli TS 5.9.3，编辑器是 TS 4.6。但 pfbm/xuanwu/gf 涉及的 TS2304（模块规则）/TS2503（namespace 规则）/TS2339（属性）是 TS 长期稳定的基础语义，跨版本行为一致——结论在编辑器 TS 下应不变。路线 C Loader 阶段用编辑器 TS 复验一次即可确认。

## 三、方案优先级（v5 重排）

| 优先级 | 改动 | 收益（game-mahjong） | 复杂度 |
|---|---|---|---|
| **P1** | 废弃 `.cocoscli/tsconfig.verify.json` + `ensureVerifyTsconfig`；cocos-mcp **优先读项目 `tsconfig.json`**（prefer + fallback，不硬编码），**只 overlay `noEmit=true`，不默认改 strict** | 单步消 xuanwu 全部（58）+ gf 大头（163/167）+ 大量 tsconfig 残缺误报 | 低（删代码为主） |
| **P2** | pfbm runtime-globals bridge（virtual .d.ts 注入 `declare const pfbm: typeof import("kiwi").pfbm`） | 消 pfbm 61，保留检查能力（已实证 TS2339 抓错） | 中 |
| **P2.5** | 调查剩余 4 条 gf：逐条看文件/位置/用法（value / type / namespace position），**先解释 diagnostic 再补 Type Environment** | 确认 4 条是否真为 alias 缺失，避免盲目 bridge 掩盖真实问题 | 低（调查为主） |
| **P3** | 仅当 P2.5 确认 4 条确为 alias 缺失，才加 gf namespace alias（`import gf = gameframe`，virtual .d.ts） | 消 gf 4 | 中（alias 全局化需 virtual .d.ts） |
| 不需要 | ~~suspectedGlobal 多维降噪~~ | pfbm 用 bridge、xuanwu/gf 用项目 tsconfig 已解决 | — |

### P1 实施规范（纯净 P1）

```
删除/停用：
  ensureVerifyTsconfig()
  .cocoscli/tsconfig.verify.json

cocos-mcp diagnostics.ts：
  读 project tsconfig.json（prefer；不存在 / 无法解析则 fallback）
        ↓
  ts.getParsedCommandLineOfConfigFile(...)
        ↓
  保留全部：rootNames / compilerOptions / paths / types / include / exclude / lib / target / strict ...
        ↓
  只覆盖：noEmit = true
```

**不默认改 strict**：目标已是「找项目真实 Type Environment 下的错误」。强制 `strict:true` 会重新引入 cocoscli 自己制造的 diagnostics（项目若 `strict:false` 而 cocoscli 强开 true，又回到「修一个自己造的问题」）。默认**完全尊重 project tsconfig**；仅用户明确 `--strict`/配置时才 override。

### P1 验收标准（6 项全过才算成功）

不是「real 更少」，而是：

1. xuanwu TS2304 = 0
2. gf TS2503 ≈ baseline 4
3. pfbm TS2304 ≈ 61 —— 证明真正 runtime-global 问题仍存在（留给 P2）
4. testerror 人为制造的真实错误仍全部检出
5. project_dts / dts / kiwi 等类型链进入 Program
6. 没有由 cocoscli 自己 override 配置导致的新错误

**额外要看**：不只 real 数下降，还要看哪些错误类型**新增**了。类型链恢复后 TS2339 / TS2345 可能增——这不一定是回退，和之前 `*Module paths` 修复同理（真实错误可能反而增加）。

### P1 实施结果（v6 实测，2026-08-13）

P1 已实施：`src/commands/compile.ts` 改忠实模式（删 `ensureVerifyTsconfig` 调用 + 检查工程 tsconfig.json 存在 + `tsconfigArg=undefined`），cocos-mcp `findTsConfig` 默认用 project tsconfig.json。cocos-mcp 侧无需改（`findTsConfig` 已优先 project + `parseJsonConfigFileContent` 已保留全部 options）。实测（cocos-mcp 编辑器 TS 4.6，全工程，strict 按 project=true）：

| # | 验收项 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | xuanwu TS2304 | = 0 | **0**（real） | ✓ P1 核心成果（58→0）|
| 2 | gf TS2503 | ≈ 4 | real=0；noise=167 | △ 见 gf 版本差异 |
| 3 | pfbm TS2304 | ≈ 61 | **60**（real） | ✓ 真 runtime-global 仍在 |
| 4 | testerror 真实错误 | 全检出 | TS1005:2 + 相关 TS2304/2339 在 real | ✓ |
| 5 | project_dts/dts/kiwi 进 Program | 是 | xuanwu=0 即证明 project_dts 声明生效 | ✓ |
| 6 | 无 cocoscli override 新错 | 无 | cocoscli 不 override，strict 按 project | ✓ |

**665 real（语法 2 + 类型 663）+ 845 noise**，对比之前自拼 tsconfig strict:false 的 311 real，增量 ~354 主要是 strict 错误（TS2531/7053/2564/18048 等）——忠实 project strict:true 的代价，不是回退。

**重要发现：gf 的 TS 版本敏感性**——同一 project tsconfig，gf TS2503 在 cocoscli TS 5.9 下仅 4 条、编辑器 TS 4.6 下 167 条。印证路线 C「Engine Compatible TS」的重要性。但 gf 167 全归 noise（judgeNoise 规则），**real 不受 gf 污染**（real gf=0），P3 alias 是清理 noise、优先级低于 P2。**P2.5 调查 gf 必须在 cocos-mcp（4.6）链路下做**，探查脚本（5.9）的 4 条不代表性。

real 665 待修构成：pfbm 60（P2 bridge）+ proto 重复 ~68（TS2300/2451/2393，工程修）+ testerror 真实错误 + 其他真实类型错误 + strict 错误 ~200+（忠实代价）。

### P2 实施结果（v7 实测，2026-08-13）

P2 已实施并闭环（通用 VirtualDeclaration 能力，cocos-mcp 不含 pfbm/runtimeGlobals 业务知识）：

- cocos-mcp `diagnostics.ts`：通用 VirtualDeclaration Host（`createCompilerHost` 包一层，override fileExists/readFile/getSourceFile；virtual 加入 rootNames）+ diagnostics 分层（environmentErrors 单独收集）
- cocos-mcp `debug-tools.ts`：`run_script_diagnostics` 透传 virtualDeclarations
- cocoscli `compile-config.ts`：CompileConfig 加 `runtimeGlobals`（Record<string, {kind:'moduleExport'; module; export}>）
- cocoscli `runtime-globals.ts`：`buildRuntimeGlobalsDeclaration` 生成强类型 bridge（`declare const <name>: typeof import("<module>").<export>;`）
- cocoscli `verify.ts` / `compile.ts`：透传 virtualDeclarations + environmentErrors 分层显示（Type Environment Resolution Error）

**Type Environment Commit / Rollback（fail closed，事务语义，非 fallback）**：bridge 生成 → 验证（environmentErrors）→ 成功 commit（业务用带 bridge 的 Program，pfbm 得强类型）/ 失败 rollback（重跑无 bridge 的 Program，业务回到 TS2304，绝不 implicit any 假阴性）。仅失败路径多一次 createProgram，成功路径零开销。P2 整体 commit/rollback；未来多 bridge 可逐项验证（RuntimeGlobalResolution {name, validated, diagnostics}），一个坏 bridge 不拖累好的。

7 项验收（game-mahjong 全工程，cocos-mcp 编辑器 TS 4.6）：

| # | 验收项 | 实测 | 结论 |
|---|---|---|---|
| ① | pfbm TS2304（正确配置 module=kiwi）| 60→0 | ✓ |
| ② | virtual declaration 自身 diagnostics（正确配置）| envErrors=0 | ✓ bridge 解析成功 |
| ③ | pfbm 正确 API 不新增错 | real 605=665−60，virtual 不在 real | ✓ |
| ④ | pfbm 不存在方法 → TS2339 | 探查脚本证 TS2339 on PrefabManger | ✓ |
| ⑤ | 删 runtimeGlobals.pfbm → 恢复 | real 恢复 665 | ✓ 无隐式降噪 |
| ⑥ | 配错 module → envError + 不放行 | envError(TS2307 kiwii) + **pfbm TS2304 恢复 60** + real 665 | ✓ rollback 无 implicit any |
| ⑦ | 磁盘无 runtime-globals.d.ts | 不存在 | ✓ virtual 不落盘 |

**P2 闭环定义达成**：pfbm bridge 成功时提供强类型（real 605，PrefabManger 类型链保留，写错方法 TS2339 可抓）；失败时绝不降低原有检查能力（rollback → pfbm TS2304 60，real 665，无 implicit any 假阴性）。

### 实施哲学

> **先让 cocoscli 成为「忠实使用项目 TypeScript 环境的 checker」，然后再让它成为「Cocos-aware checker」。**

当前最重要的是先把「忠实」做正确，而不是继续造 Cocos-aware 能力。阶段 0 实验已证明：80% 的问题只是 cocoscli 自己构造了残缺 Type Environment。

### v3 通用架构的定位调整

v3 的 Declaration Index / Global Resolver / cache fingerprint / incremental 等「通用架构」对**未来其他工程可能有别的运行时全局变量**仍有价值，保留为通用能力设计（见第四节）。但对 game-mahjong 的 P0，**P1 一个改动就是 80% 的收益**，通用架构不阻塞 P1，且**现在不应投入实现成本**——先做 P1 实测，再决定是否需要。

## 四、通用架构设计要点（v2/v3 修正速览，为未来工程保留）

### 4.1 设计修正速览（13 项）

| # | 修正 | 要点 |
|---|---|---|
| 1 | 路线 C | 执行在 cocoscli，TS 版本取 Engine Compatible（编辑器兼容 TS → cocoscli 兼容 TS → bundled fallback），解耦「执行位置」与「TS 版本」 |
| 2 | 直接用项目 tsconfig | v2 原写「依赖 extends 解析」，v4 实测简化为「直接用项目 tsconfig.json」（它本身就是完整正确的 IDE/tsc 配置）；tsconfig.cocos.json 是 Creator 内部用的（`db://` 虚拟路径），cocoscli 不碰 |
| 3 | 双索引 | Ambient Declaration Index（.d.ts 全局声明：globalNamespace/globalVariable/declareGlobal）+ Module Export Index（.ts/.d.ts 模块 export） |
| 4 | Virtual SourceFile | bridge 通过 CompilerHost 注入虚拟 `.d.ts`，不落盘、不污染工程、不进 Git |
| 5 | incremental + cache | Discovery 首次两轮 + 存 cache，日常普通 compile 只一轮 |
| 6 | 可证明条件 | Resolver 验证 module 能解析/symbol 存在/export 存在/类型非 unknown，全满足才 RESOLVED |
| 7 | gf alias 仅服务 checker | `import gf = gameframe` 技术成立，但 Creator 不支持 `import =`，故必须 virtual .d.ts |
| 8 | 扫描范围 P0-P3 | 从 Program SourceFile[] 建第一版 Index，不做全盘递归（P0 已加载 → P1 include 触达 → P2 配置 roots → P3 有限 fallback） |
| 9 | cache fingerprint | 记录 typescriptVersion/creatorVersion/tsconfigHash/cocosTsconfigHash/runtimeGlobalConfigHash + 每个 resolved global 的 source + sourceHash，指纹变则失效 |
| 10 | 分层输出 | Type Environment Resolution（resolved/suspected globals）与 Diagnostics（real/noise）分层，不混在一起 |
| 11 | 绝不 any invariant | 见 4.3，类型层让 any fallback 不可能 |
| 12 | 阶段 0 实验无侵入 | 改真实源码的验证一律走临时测试文件或 virtual SourceFile |
| 13 | 自动发现 | 双索引建好后 pfbm(moduleExport)/xuanwu(globalNamespace) 能自动发现，只剩 gf 类「名字不同的 alias」需人工配置 |

### 4.2 最终推荐架构（通用，分层）

```
               Cocos Project
                     │
                     ▼
          Type Environment Probe
                     │
                     ▼
          Type Environment Loader         直接用项目 tsconfig.json（v4 简化）
                     │
                     ▼
             TypeScript Program
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   Ambient Index          Module Export Index
   .d.ts globals          TS module symbols
          │                     │
          └──────────┬──────────┘
                     ▼
          Runtime Global Resolver
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
       resolved              suspected
          │
          ▼
       Virtual Type Environment
                     │
          ┌──────────┴──────────┐  resolved/suspected 属
          ▼                     ▼  Type Environment Resolution
   Incremental Program    (suspected 列出)
          │
          ▼
       Final Diagnostics
       REAL / NOISE                             real/noise 属 Diagnostics
```

### 4.3 invariant：绝不 any 写进类型层

「可证明 → 补 Type Environment / 无法证明 → suspected / 绝不 → any」直接做成代码层 invariant，让 any fallback 在类型系统层面不可能发生：

```ts
type ResolvedRuntimeGlobal =
  | { kind: 'moduleExport';   typeVerified: true; module: string; export: string; }
  | { kind: 'declaration';    typeVerified: true; file: string; }
  | { kind: 'namespaceAlias'; typeVerified: true; target: string; };

function resolveGlobal(name: string): ResolvedRuntimeGlobal | SuspectedRuntimeGlobal;
// API 不接受 type:'any'，唯一无法 resolve 的出口是 suspected
```

## 五、阶段 0 的 4 个验证实验（已完成）

探查脚本 `scripts/probe-type-env.ts`，无侵入（临时文件写 `.cocoscli/probe/` 跑完即删）：

1. **tsconfig 解析链** ✓——项目 tsconfig.json 自包含无 extends；tsconfig.cocos.json 在 temp/（3.7）是 Creator 内部用的；cocoscli 应直接用项目 tsconfig.json。
2. **Program 状态** ✓——当前 Program 建在自拼 `.cocoscli/tsconfig.verify.json`（残缺），应改为项目 tsconfig.json。baseline rootNames 1944 / TS 5.9.3 / 3.6 秒。
3. **xuanwu 漏检原因** ✓——自拼 tsconfig include 丢了 project_dts（xuanwu 声明所在），项目 tsconfig 下不报。
4. **virtual .d.ts 注入验证** ✓——pfbm bridge 61→0 且写错被抓 TS2339 on PrefabManger；xuanwu/gf 在项目 tsconfig 下已基本不报。

## 六、类比理解

- **v1** = 给审计员换正式花名册 + 纸质代号本，每次审两遍。
- **v2** = 电子代号本 + 脑内规矩 + 只在新人入职重审 + 必须出示身份证才登记。
- **v3** = 代号本拆「全局名册」和「部门花名册」，盖「环境指纹章」，已解决/疑似属「名单核对」、真实错误属「审计报告」。
- **v4** = 探查发现：审计员之前报错最多的人（xuanwu/gf），**其实一直在公司正式花名册里**（project_dts/dts），只是审计员之前拿的是自己手抄的残缺副本（自拼 tsconfig.verify.json），漏抄了好几页。换成公司正式花名册，这批人全部「查到」。真正需要补代号本的，只剩 pfbm 这一个（模块 export 当全局用）——而且代号本写得足够细，pfbm 叫错方法名都能当场抓到。

## 七、待修正的旧认知

需同步更新 `cocoscli-compile-全局变量报错分析.md`：

1. 「编辑器知道 export 注入所以不报」从未被证明，更可能编辑器没做完整类型检查。
2. **xuanwu/gf 的大头报错是自拼 tsconfig 丢 include 的 artifact，不是「Cocos 运行时全局」本质问题**——项目 tsconfig 下 xuanwu 归零、gf 167→4。该报告的「方案 C suspectedGlobal」对 game-mahjong 已不需要。
3. **在本次 game-mahjong 已调查的三类问题（pfbm/xuanwu/gf）中，唯一已确认仍需 Runtime Global Bridge 的是 pfbm**（模块 export 当全局用），且 bridge 完美解决。项目可能还有 gfcc/lb 等其他业务全局，只是这次未成为主要 diagnostics，不排除未来出现——结论限定于本次调查作用域。

## 八、整体结论与下一步

- **P1+P2 已实施闭环**：P1 忠实 project tsconfig（xuanwu 58→0）；P2 pfbm VirtualDeclaration bridge + Commit/Rollback（成功 60→0 强类型，失败 rollback 不降检查能力）。
- **最大教训**：之前几轮设计复杂 Global Resolver，根因其实是「cocoscli 自己拼了残缺 tsconfig」。P1 换回项目 tsconfig 是 80% 收益，P2 用通用 VirtualDeclaration Host + Commit/Rollback 解决剩余 pfbm。
- **下一步**：
  - **P2.5**：调查 gf（cocos-mcp 编辑器 TS 4.6 下 167 条 TS2503，全 noise；逐条看 value/type/namespace position，确认是否 alias 缺失）
  - **P3**：仅当 P2.5 确认 gf 确为 alias 缺失，才加 `import gf = gameframe`（复用 P2 VirtualDeclaration Host，runtimeGlobals 加 namespaceAlias kind）
  - gf 不污染 real（167 全 noise），优先级低于真实类型错误
- v3 通用架构（双索引/Resolver/cache/incremental）保留为未来工程通用能力，**现在不投入实现成本**。

## 九、参考

- 阶段 0 探查脚本：`scripts/probe-type-env.ts`（可复跑：`npx tsx scripts/probe-type-env.ts <projectPath> inject`）
- 被评审方案：[cocoscli-compile核心问题测试环境模仿cocoscreator方案](./cocoscli-compile核心问题测试环境模仿cocoscreator方案.md)
- 关联：[cocoscli-compile-全局变量报错分析](./cocoscli-compile-全局变量报错分析.md)（待按第七节修正认知）
- 关联：[cocoscli-compile-错误分类架构设计](./cocoscli-compile-错误分类架构设计.md)（suspectedGlobal 降为兜底/不需要）
- Cocos Creator 语言支持（支持的 TS 语义子集，`export =/import =` 不支持）：https://docs.cocos.com/creator/3.8/manual/en/scripting/language-support.html
- Cocos Creator tsconfig（tmp/tsconfig.cocos.json 由来 + extends）：https://docs.cocos.com/creator/3.8/manual/en/scripting/tsconfig.html
- TypeScript incremental program API（createIncrementalProgram，3.6+）：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-6.html
- TypeScript global .d.ts 模板（virtual .d.ts 描述运行环境 globals 的官方依据）：https://www.typescriptlang.org/docs/handbook/declaration-files/templates/global-d-ts.html
