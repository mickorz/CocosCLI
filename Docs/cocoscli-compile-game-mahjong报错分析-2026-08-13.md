# game-mahjong compile 报错分析报告（2026-08-13）

> 数据源：`.cocoscli/compile-log-2026-08-13T02-52-09.json`（paths 修复后的结果）。real 632 + noise 1062。
> 用户反馈：CocosCreator 编辑器里**没有这么多报错**。本报告分析 632 real 的成因，给出分类与解决路径。

## 一、结论先行

632 个 real errors 里，**真实需要修的约 50 条**（testerror 测试数据 + proto 生成重复 + 少量真实类型错误），**其余约 580 条是「tsconfig 配置差异 + Cocos 运行时全局变量 + strict 严格性」**，编辑器不报或检查宽松。

| 成因分类 | 条数（估） | 编辑器表现 | 处理 |
|---|---|---|---|
| A. tsconfig lib 版本低（TS2550） | 39 | 不报（编辑器 lib 更高） | **立即修**：verify tsconfig 加 lib |
| B. Cocos 运行时全局变量（pfbm/xuanwu/gf） | ~120 | 不报（运行时注入） | suspectedGlobal 多维降噪 |
| C. strict 严格性（null + 类型不匹配） | ~400 | 不报或宽松 | **定位决策**（对齐编辑器 or 严格） |
| D. proto 生成重复声明 | 30 | 报（真实） | 工程修 proto 生成 |
| E. testerror 测试脚本 | ~20 | 报（真实） | 测试数据，清理或保留 |
| F. 模块/声明残留（isolatedModules 等） | ~20 | 不报 | 降噪或接受 |

## 二、632 real 的 code 分布（实测）

| code | 数量 | 含义 | 归类 |
|---|---|---|---|
| TS2345 | 80 | 参数类型不匹配 | C strict |
| TS2322 | 70 | 类型不可赋值 | C strict |
| TS2304 | 64 | Cannot find name（pfbm/xuanwu 等全局变量） | B 全局变量 |
| TS2550 | 39 | Property includes/values/entries 不存在 | **A lib** |
| TS7053 | 36 | 索引签名隐式 any | C strict |
| TS2531 | 36 | Object possibly null | C strict null |
| TS2339 | 35 | Property 不存在 | C/F 类型 |
| TS2380 | 31 | getter/setter 返回类型不匹配 | C strict |
| TS18048 | 23 | possibly undefined | C strict null |
| TS2554 | 21 | 参数个数不匹配 | C strict |
| TS7015 | 20 | 索引隐式 any | C strict |
| TS2564 | 20 | 属性未初始化 | C strict |
| TS2532 | 17 | possibly undefined | C strict null |
| TS18046 | 15 | type unknown | C strict |
| TS2451 | 12 | Cannot redeclare（proto Package/Service） | D proto |
| TS2300 | 10 | Duplicate identifier（proto） | D proto |
| TS7010/7008 | 16 | 隐式 any 返回/成员 | C strict |
| TS18047 | 9 | possibly null | C strict null |
| TS2551 | 8 | Property 不存在（建议） | C/F |
| TS2393 | 8 | Duplicate function implementation | D 重复 |
| TS1208 | 7 | isolatedModules 全局脚本（testerror/common_game/lobby） | F 模块 |
| TS1005 | 2 | 语法错误（testerror 01） | E 真实 |
| 其他零散 | ~40 | 各种 | 混合 |

TS2304 name 实测高频：`pfbm` 60 处、`xuanwu` 58 处、`gf` 168 处（含 namespace）——全是 Cocos 运行时全局变量。

## 三、成因详解

### A. tsconfig lib 版本低（TS2550，39 条，确定可修）

`temp/tsconfig.cocos.json` 的 `target: ES2015`，没显式 `lib`，tsc 默认 lib = target = ES2015，不含 `Array.includes`（ES2016）、`Object.values/entries`（ES2017）。工程大量用这些，编辑器 lib 更高所以不报。

**修**：`tsconfig.verify.json` 加 `"lib": ["ES2017", "DOM"]`（或 ESNext）。39 条消失。

### B. Cocos 运行时全局变量（pfbm/xuanwu/gf，~120 条）

`pfbm`、`xuanwu`、`gf` 是 Cocos 运行时注入的全局变量（同 gf=gameframe 机制，见《Cocos模块与全局变量类型解析问题》）。TS2304 Cannot find name（小写归 real）+ TS2503（gf namespace，已降噪）。编辑器认这些全局，不报。

**处理**：用《错误分类架构设计》的多维 suspectedGlobal（频次 + 跨文件 + 无声明 + 短名/白名单），单独列出而非直接吞。

### C. strict 严格性（~400 条，大头，需定位决策）

- **strict null**（TS2531/18048/2532/18047/2533/2538）≈ 93 条：对象可能 null/undefined
- **strict 类型**（TS2345/2322/7053/2380/2554/7015/2564/18046/7010/7008）≈ 313 条：类型不匹配、隐式 any、未初始化等

这些是 `strict: true` 的产物。**CocosCreator 编辑器对脚本检查通常不严格执行 strictNullChecks**（Cocos 工程惯例），所以编辑器不报或报得少。运行时这些 null/类型宽松通常正常。

**这是 632 里的大头，决定 compile 的定位**——见第四节决策。

### D. proto 生成重复（TS2451/2300/2393，30 条，真实）

`assets/biz_modules/agActivitySvrModule/lib/interface_agactivity.ts` 里 `Package/Service/Method/Request/Response` 在多个命名空间重复声明（proto 工具生成时没隔离）。这是工程自身的真实问题，编辑器也报。

**处理**：修 proto 生成（给每个 namespace 隔离），或工程层 ignore。属 game-mahjong 工程问题，非 cocoscli。

### E. testerror 测试脚本（~20 条，真实）

`assets/scripts/testerror/01~06` 是故意写的错误脚本（验证 compile 检测能力）。TS1005 语法、TS2304 playerLevel、TS2339 Player.hp、TS2322、TS2554、TS2307 等。这些是真实的，compile 正确检出。

**处理**：测试数据，验证完可清理（或保留作回归用例）。

### F. 模块/声明残留（~20 条）

- TS1208（7）：`common_game.ts`/`lobby.ts`/testerror 是全局脚本（无 import/export），`isolatedModules` 下报。编辑器容忍。
- 部分 TS2339：类型声明不全（非 *Module 连锁，paths 已修那批）。

**处理**：TS1208 可降噪（全局脚本是 Cocos 常见模式）。

## 四、核心决策：compile 的 strict 定位（已实施）

**已决策**：compile 默认对齐编辑器（务实工头视角），`--strict` 时全严格。

实现：
- `ensureVerifyTsconfig(projectPath, { strict })`：默认生成 `strict: false`（覆盖 base 的 `strict:true`），消除 null(TS2531/18048/2532/18047 ~93) + 类型不匹配(TS2345/2322 ~150) + 隐式any(TS7053/7015/7010/7008 ~70) 等。
- `--strict` 时不覆盖，保持 base `strict:true` 全开。
- 顺带 `lib: ['ES2017', 'DOM']`，消除 TS2550（includes/values/entries，39 条）。

| 模式 | tsconfig | 预期 real |
|---|---|---|
| `cocoscli compile`（默认） | strict:false + lib ES2017 | ~80-100（真实错误 + proto 重复 + 全局变量 TS2304） |
| `cocoscli compile --strict` | strict:true（base） | ~600（含 null + 类型严格性，供严格审查） |

日常用默认（对齐编辑器，找真实错误），需要严格类型审查时加 `--strict`。

## 五、推荐解决路径（分优先级）

1. **立即修（A）**：`ensureVerifyTsconfig` 加 `lib: ["ES2017", "DOM"]`，消除 39 条 TS2550。零风险，编辑器也认这些 API。

2. **实现 suspectedGlobal（B）**：按《错误分类架构设计》落地多维判定，把 pfbm/xuanwu/gf 等 120 条全局变量从 real 移到 Suspected（单独列出）。

3. **降噪 TS1208（F）**：全局脚本（common_game.ts/lobby.ts）归 noise。

4. **strict 定位决策（C）**：先在编辑器确认 gamePropController 是否报 TS2531/TS2345，再选方案 1/2/3。

5. **工程修复（D）**：proto 生成重复（interface_agactivity.ts）由 game-mahjong 工程修，非 cocoscli 范围。

6. **testerror（E）**：测试数据，清理或保留作回归。

完成 1+2+3 后，real 预计从 632 降到 ~470（632 - 39 lib - 120 global - 20 模块 ≈ 453）。C 类（~400）的去留取决于 strict 定位决策。

## 六、类比

- compile 现在像一个**最严格的审计员**：拿着 `strict:true` 的清单，把所有"可能 null""类型不太匹配"全标红。
- CocosCreator 编辑器像个**务实的工头**：只关心"能不能跑起来"，null 检查睁一只眼闭一只眼。
- 用户看到的差距 = 审计员 vs 工头的标准差。
- 要让 compile 接近工头视角（方案 1），还是保留审计员严格（方案 2），是定位选择。

## 七、参考

- 关联：[cocoscli-compile-Cocos模块与全局变量类型解析问题](./cocoscli-compile-Cocos模块与全局变量类型解析问题.md)
- 关联：[cocoscli-compile-错误分类架构设计](./cocoscli-compile-错误分类架构设计.md)（suspectedGlobal 多维判定）
- TypeScript compiler options（strict / lib / target）：https://www.typescriptlang.org/tsconfig
