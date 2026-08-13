有，而且我建议你**调整现在文档里的核心思路**。

你现在的方案 C「`suspectedGlobal` 多维降噪」可以保留，但应该从**主要解决方案降级为最后兜底**。更好的方案是：

> **先还原 Cocos 项目真实的 TypeScript 类型环境 → 再自动补 Runtime Global 类型桥接 → 最后才做 suspectedGlobal 降噪。**

这样 `pfbm / xuanwu / gf` 大部分都可以从“误报”变成“真正被 TypeScript 正确检查”，而不是简单隐藏错误。

---

# 先说一个我认为很重要的问题

你这份分析里有一段判断，我建议修改：

> CocosCreator 编辑器知道 kiwi/gameframe 的 export 会被注入全局，所以不报错。

这件事目前从你的调查材料里**并没有被真正证明**。你证明了 `pfbm/gf` 是模块 export，也证明了业务代码直接全局使用它们，但没有找到“Cocos 把这些 export 自动挂到 global”的实际实现代码。

而 Cocos 官方文档反而给出了一个非常重要的信息：

**Cocos Creator 的实际 TypeScript 编译并不会读取项目 `tsconfig.json` 来执行完整类型检查；`tsconfig.json` 更多是提供给 IDE/type checker。IDE 检查本身使用的是 `tsc`。** ([Cocos Creator][1])

同时 Cocos 把固定配置，包括 **Cocos 自身类型声明的位置**，放在：

```text
temp/tsconfig.cocos.json
```

项目 `tsconfig.json` 应该 `extends` 它。([Cocos Creator][2])

所以这里更可能存在的是：

```text
Cocos 能运行
    ≠
Cocos TypeScript 类型系统认为代码合法
```

也就是说：

```text
Creator 构建/运行成功
↓
只能证明 JS 运行时存在 pfbm/gf

不能证明
↓
TypeScript Program 里存在 pfbm/gf 的声明
```

TypeScript 官方规则也很明确：一个文件只要有顶层 `import/export`，里面的符号就是模块作用域；其他文件不 import 就不能直接访问。([TypeScript][3])

所以我不会再把：

```text
Cocos Editor 特殊识别这些 global
```

当作 cocoscli 的设计前提。

---

# 我更推荐的整体架构

把现在：

```text
ts.createProgram
      ↓
diagnostics
      ↓
judgeNoise
      ↓
real / noise / suspected
```

改成：

```text
                 Cocos Project
                      │
                      ▼
          ① Type Environment Resolver
                      │
          ┌───────────┴───────────┐
          │                       │
 temp/tsconfig.cocos.json     project tsconfig
 Cocos .d.ts                  paths / types / dts
 external SDK .d.ts
          │
          ▼
              TypeScript Program
                      │
                      ▼
             First Diagnostics
                      │
                      ▼
         ② Runtime Global Resolver
                      │
       ┌──────────────┼──────────────┐
       │              │              │
 existing d.ts     global alias    runtime export
 xuanwu            gf              pfbm
       │              │              │
       └──────────────┴──────────────┘
                      │
                      ▼
       virtual runtime-globals.d.ts
                      │
                      ▼
             Second Type Check
                      │
                      ▼
          ③ Error Classification
                      │
        real / suspected / noise
```

这样就完全不一样了。

---

# 第一层：不要自己“模拟 tsconfig”，尽量还原 Creator 的 Type Environment

这是最重要的一步。

你现在 `tsconfig.verify.json` 如果本质类似：

```json
{
  "include": ["assets/**/*.ts"]
}
```

这个设计就天然容易漏掉：

```text
dts/
xuanwu_tools/**/*.d.ts
extensions/**/*.d.ts
generated/**/*.d.ts
SDK declaration
第三方 runtime declaration
```

于是才有现在 `xuanwu` 的问题。

### 我建议

优先读取真实：

```text
project/tsconfig.json
        ↓ extends
project/temp/tsconfig.cocos.json
```

然后**只 overlay cocoscli 自己需要修改的配置**，而不是重新造一份完整 tsconfig。

例如：

```ts
const configPath = path.join(project, 'tsconfig.json');

const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    ts.sys
);
```

然后：

```ts
parsed.options.noEmit = true;

// 你的额外 Module paths
parsed.options.baseUrl = project;
parsed.options.paths = {
    ...parsed.options.paths,

    '*Module': [
        'assets/biz_modules/*Module',
        'assets/node_modules/*Module'
    ],

    '*Module/*': [
        'assets/biz_modules/*Module/*',
        'assets/node_modules/*Module/*'
    ],
};
```

最后：

```ts
ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
});
```

这样 Creator 本来的：

```text
types
lib
target
module
paths
Cocos declaration path
.d.ts
```

全部保留下来。

官方本身就是建议项目继承 `temp/tsconfig.cocos.json`，因为里面包含 Creator 固定的 TS 配置与类型声明位置。([Cocos Creator][2])

---

# 第二层：xuanwu 不应该进入 suspectedGlobal

这个我认为你现在分类得不够准确。

你的调查已经明确发现：

```text
xuanwu_tools/.../AdapterInterface.d.ts

declare namespace xuanwu
```

只是：

```text
没有进入 Program
```



这种情况完全不应该降噪。

应该：

```text
TS2304 xuanwu
      ↓
Global Resolver
      ↓
搜索项目内 .d.ts
      ↓
找到：
declare namespace xuanwu
      ↓
当前 Program 不包含
      ↓
动态追加 declaration file
      ↓
重新 typecheck
```

甚至**不要 include 整个 `xuanwu_tools`**。

因为：

```json
"include": [
    "xuanwu_tools/**/*"
]
```

可能把大量 SDK 构建脚本 `.ts` 一起拉进来，产生新 diagnostics。

直接把对应 `.d.ts` 加进 `rootNames`：

```ts
rootNames.push(
    'xuanwu_tools/build-xuanwusdk/contract/AdapterInterface.d.ts'
);
```

更安全。

---

# 第三层：pfbm 不应该降噪，可以自动生成强类型 Global Bridge

你的代码：

```ts
export const pfbm: PrefabManger = gt.pfbm;
```

同时业务：

```ts
pfbm.uiFgui(...)
```



从 TypeScript 的角度，最正确的补偿就是 ambient declaration。

但不用让每个项目人工写：

```ts
declare const pfbm: any;
```

而是 cocoscli 自动生成：

```ts
declare const pfbm: typeof import("kiwi").pfbm;
```

这非常重要。

因为：

```text
declare const pfbm: any
```

只是：

```text
消灭 TS2304
+
制造大量假阴性
```

而：

```ts
declare const pfbm: typeof import("kiwi").pfbm;
```

意味着：

```text
pfbm
  ↓
PrefabManger
  ↓
uiFgui()
  ↓
参数
  ↓
返回值
```

**整个类型链全部保留下来。**

TypeScript 官方本身就是通过 `.d.ts` 来描述真实运行环境中的 global。([TypeScript][4])

---

# gf 其实也有比 `declare const gf` 更好的办法

这个是我专门验证了一下 TypeScript 行为。

你现在：

```ts
gf.sp.onSpineLoaded(...)

(sp: gf.sp.Spine)
```

说明 `gf` 同时被用于：

```text
value
+
namespace/type namespace
```

所以简单：

```ts
declare const gf: typeof gameframe;
```

解决不了所有情况。

你现有声明：

```ts
declare namespace gameframe {
    namespace sp {
        class Spine {}
        function onSpineLoaded(...)
    }
}
```

可以直接建立 namespace alias：

```ts
import gf = gameframe;
```

然后：

```ts
gf.sp.onSpineLoaded(...)

const x: gf.sp.Spine
```

都可以被 TypeScript 正确解析。

也就是说 cocoscli 可以动态生成一个：

```text
.cocoscli/runtime-globals.d.ts
```

内容：

```ts
// runtime global: pfbm
declare const pfbm: typeof import("kiwi").pfbm;

// namespace alias: gf -> gameframe
import gf = gameframe;
```

我用 TypeScript Compiler API 验证过这个模式：

```ts
gf.sp.onSpineLoaded('x', (s: gf.sp.Spine) => {});
pfbm.x;
```

能够正常通过类型检查。

这个比：

```text
TS2503 gf → noise
```

强很多。

---

# 可以把它做成一个通用 Global Resolver

这才是我觉得最适合 cocoscli 的地方。

第一轮 TypeScript：

```text
TS2304 pfbm
TS2304 xuanwu
TS2503 gf
TS2304 playerLevel
```

不要立即 `judgeNoise`。

进入：

```text
GlobalResolver.resolve("pfbm")
```

按照确定性从高到低查：

| 优先级 | 检查                                 | 结果         |
| --- | ---------------------------------- | ---------- |
| P0  | Program 外是否存在 `declare xxx`        | 自动加入       |
| P1  | 是否有明确 global 配置                    | 自动 bridge  |
| P2  | 是否存在 `globalThis.xxx / window.xxx` | 自动 bridge  |
| P3  | 是否存在同名 module export               | 候选         |
| P4  | 是否跨几十文件高频使用                        | 加强候选可信度    |
| P5  | 什么都没有                              | real error |

例如：

### xuanwu

```text
TS2304 xuanwu
↓
搜索 .d.ts
↓
declare namespace xuanwu
↓
FOUND
↓
加入 Program
```

确定性：

```text
100%
```

---

### pfbm

```text
TS2304 pfbm
↓
没有 declare
↓
找到：
export const pfbm
↓
运行时 global manifest 也声明 pfbm
↓
生成：
declare const pfbm:
    typeof import("kiwi").pfbm
```

确定性很高。

---

### playerLevel

```text
TS2304 playerLevel
↓
没有 declare
↓
没有 export
↓
没有 runtime global
↓
1 file / 1 reference
↓
REAL
```

这样根本不需要：

```text
首字母大小写
```

这种比较脆弱的规则。

---

# 再加一个很小的工程配置就会非常稳

我甚至建议 cocoscli 支持：

```json
{
  "runtimeGlobals": {
    "pfbm": {
      "kind": "export",
      "module": "kiwi",
      "export": "pfbm"
    },

    "gf": {
      "kind": "namespaceAlias",
      "target": "gameframe"
    }
  }
}
```

例如：

```text
cocoscli.json
```

于是 cocoscli 自动产生：

```ts
declare const pfbm:
    typeof import("kiwi").pfbm;

import gf = gameframe;
```

这个配置不是“白名单降噪”。

这是：

> **告诉 TypeScript：这个项目真实运行环境额外提供了哪些 global。**

性质完全不一样。

---

# 最好还能自动生成这个配置

甚至第一次执行：

```bash
cocoscli compile
```

发现：

```text
pfbm
gf
xuanwu
```

以后可以分析：

```text
pfbm
 ├─ 63 references
 ├─ 37 files
 ├─ exported by kiwi
 └─ no ambient declaration

gf
 ├─ 221 references
 ├─ namespace usage
 ├─ gameframe namespace exists
 └─ likely alias → gameframe

xuanwu
 ├─ declaration found
 └─ declaration not included
```

最终输出：

```text
Runtime environment analysis

Resolved automatically:
  xuanwu
    declaration:
    xuanwu_tools/.../AdapterInterface.d.ts

Potential runtime globals:
  pfbm
    candidate:
    kiwi.pfbm

  gf
    namespace alias candidate:
    gameframe
```

第一次人工确认一次：

```text
gf -> gameframe
pfbm -> kiwi.pfbm
```

以后项目永久复用。

---

# `suspectedGlobal` 应该放到最后

于是你原来的方案：

```text
高频
+
跨文件
+
短名称
+
无声明
```

仍然有价值。

但应该只处理这种：

```text
Global Resolver 无法确定来源
```

的变量。

例如：

```text
lb
gfcc
xxxx
```

最后才：

```text
suspected runtime global
```

而不是：

```text
noise
```

我会采用这样的最终状态：

```text
REAL
SUSPECTED_RUNTIME_GLOBAL
RESOLVED_RUNTIME_GLOBAL
NOISE
```

例如：

```text
Compile result

Real errors: 13

Resolved runtime globals: 3
  xuanwu
    declaration discovered automatically

  pfbm
    global bridge -> kiwi.pfbm

  gf
    namespace alias -> gameframe

Suspected runtime globals: 2
  lb       85 refs / 31 files
  gfcc     41 refs / 18 files

Noise: 127
```

这比现在的：

```text
real
noise
```

信息量高很多。

---

# `allowUmdGlobalAccess` 也不用浪费时间试

TypeScript 有一个：

```json
"allowUmdGlobalAccess": true
```

看起来似乎就是解决：

> module export 全局访问。

但它专门针对 **UMD 模块**；TypeScript 文档明确说，它允许 UMD export 在 module 文件里按 global 使用。([TypeScript][5])

如果库的声明本身类似：

```ts
export as namespace xxx;
```

才比较匹配这种方案。TypeScript 官方 `.d.ts` 模板也是这么描述 UMD global 的。([TypeScript][6])

你现在：

```ts
export const pfbm
```

不是这个情况。

所以：

```text
allowUmdGlobalAccess
```

不是这里的通用解法。

---

# 我给你的最终推荐

我会把现在 cocoscli compile 的路线改成：

```text
                   compile
                      │
                      ▼
       Load real project tsconfig
                      │
                      ▼
       temp/tsconfig.cocos.json
                      │
                      ▼
           merge *Module paths
                      │
                      ▼
              createProgram
                      │
                      ▼
             diagnostics #1
                      │
                      ▼
        Runtime Global Resolver
                      │
      ┌───────────────┼───────────────┐
      │               │               │
 discover .d.ts   global bridge   namespace alias
   xuanwu            pfbm             gf
      │               │               │
      └───────────────┴───────────────┘
                      │
                      ▼
       virtual runtime-globals.d.ts
                      │
                      ▼
              createProgram
                      │
                      ▼
             diagnostics #2
                      │
                      ▼
       ┌──────────────┼─────────────┐
       ▼              ▼             ▼
     real         suspected       noise
```

这里最关键的变化是：

> **不要试图判断“这个错误要不要忽略”，而应该先问“我是不是缺少了这个项目真实运行环境的类型信息”。**

这是一个更正确的抽象。

你现在的 `judgeNoise` 本质上是在：

```text
修 diagnostics
```

而我建议改成：

```text
修 Type Environment
        ↓
重新生成 diagnostics
```

这会让整个 `cocoscli compile` 从一个“**tsc + 错误过滤器**”，升级成一个真正的：

> **Cocos-aware TypeScript Checker**

尤其对你后面要做的 **AI 自动修复** 很重要：`pfbm/gf` 如果只是被过滤掉，AI 永远检查不到它们真正的属性、参数、返回值错误；而 Global Bridge 建好以后，AI 既不会被 TS2304 骗，又仍然可以发现 `pfbm.xxx()` 真正写错了。这个收益比继续优化 `judgeNoise` 大很多。

[1]: https://docs.cocos.com/creator/3.8/manual/en/scripting/tsconfig.html?utm_source=chatgpt.com "tsconfig.json"
[2]: https://docs.cocos.com/creator/3.8/manual/en/scripting/tsconfig.html "tsconfig.json | Cocos Creator"
[3]: https://www.typescriptlang.org/docs/handbook/2/modules.html?utm_source=chatgpt.com "Documentation - Modules - TypeScript"
[4]: https://www.typescriptlang.org/docs/handbook/declaration-files/templates/global-d-ts.html?utm_source=chatgpt.com "Documentation - Global .d.ts"
[5]: https://www.typescriptlang.org/tsconfig/?utm_source=chatgpt.com "TSConfig Reference - Docs on every TSConfig option"
[6]: https://www.typescriptlang.org/docs/handbook/declaration-files/templates/module-d-ts.html?utm_source=chatgpt.com "Documentation - Modules .d.ts"
