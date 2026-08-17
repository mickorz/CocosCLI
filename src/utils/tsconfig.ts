import * as fs from 'fs';
import * as path from 'path';

// 工程根 tsconfig.json 保障（compile 检查4 用）
//
// ensureRootTsconfig(projectPath)
//        ├─> tsconfig.json 已存在  返回 exists（完全不碰，对齐 writeDefaultMcpServerConfig /
//        │                          readCompileConfig 的「不存在才写默认」先例）
//        │                          └─> 正则探测 skipLibCheck，缺失时仅黄字提醒（不自动改）
//        └─> 不存在  写推荐模板（extends ./temp/tsconfig.cocos.json + skipLibCheck + include assets）
//                    └─> 顺带报告 temp/tsconfig.cocos.json 是否存在（编辑器打开过才生成）

/**
 * 推荐模板（真实工程实测归零配置）
 *
 * - skipLibCheck 折叠引擎 .d.ts 声明噪音（jsb.d.ts TS7010 / cc.d.ts TS1165 等 58 条）
 * - lib ES2017 消 TS2550（Array.includes 需 es2016+）
 * - exclude 掉非业务目录（extensions/library 是编辑器与扩展生成物）
 */
const DEFAULT_ROOT_TSCONFIG = {
  extends: './temp/tsconfig.cocos.json',
  compilerOptions: {
    lib: ['ES2017', 'DOM'],
    skipLibCheck: true,
  },
  include: ['assets/**/*.ts'],
  exclude: ['node_modules', 'extensions', 'library'],
};

/** ensureRootTsconfig 结果 */
export interface RootTsconfigSetup {
  status: 'exists' | 'written';
  /** temp/tsconfig.cocos.json 是否存在（written 且 false 时命令层提示先 cocoscli open） */
  hasBase: boolean;
  /** exists 且未见 "skipLibCheck": true 时为 true（仅黄字提醒，不自动改用户配置） */
  missingSkipLibCheck?: boolean;
}

/**
 * 保障工程根 tsconfig.json 存在：不存在则写推荐模板，已存在完全不碰
 *
 * @param projectPath 工程根目录
 * @returns status（written/exists）+ hasBase + missingSkipLibCheck
 */
export function ensureRootTsconfig(projectPath: string): RootTsconfigSetup {
  const tsconfigPath = path.join(projectPath, 'tsconfig.json');
  const hasBase = fs.existsSync(path.join(projectPath, 'temp', 'tsconfig.cocos.json'));
  if (fs.existsSync(tsconfigPath)) {
    // skipLibCheck 探测用正则而非 JSON.parse：tsconfig 是 JSONC（允许注释/尾逗号），parse 会误炸
    const raw = fs.readFileSync(tsconfigPath, 'utf-8');
    return { status: 'exists', hasBase, missingSkipLibCheck: !/"skipLibCheck"\s*:\s*true/.test(raw) };
  }
  fs.writeFileSync(tsconfigPath, JSON.stringify(DEFAULT_ROOT_TSCONFIG, null, 2) + '\n', 'utf-8');
  return { status: 'written', hasBase };
}
