import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { getHomeDir, isWindows, isMac, getConfigDir } from './platform.js';

// CocosCreator 定位与打开流程
//
// getCocosCreatorPath(autoSave)
//        ├─> findCocosCreatorPath()        5 级查找
//        │     ├─> 方法1 环境变量 COCOS_CREATOR_PATH / COCOS_CREATOR
//        │     ├─> 方法2 where/which 系统命令
//        │     ├─> 方法3 读 ~/.Cocos/profiles/editor.json
//        │     ├─> 方法4 扫描常见安装目录
//        │     └─> 方法5 配置文件写死值兜底
//        ├─> validateCreatorPath()         验证 exe 真实存在
//        └─> autoSave 时回写本地配置 cocoscli.json
//
// openCocosProject(creatorPath, projectPath)
//        └─> spawn(detached, stdio ignore) + unref()   非阻塞拉起
//
// 实现依据：《CocosCreator路径查找逻辑详解》（移植自 autoBuild/build_helper.js）

/** 偏好版本：本工具面向 3.7.x，优先 3.7.3 */
export const PREFERRED_CREATOR_VERSION = '3.7.3';

/** editor.json 条目结构 */
interface EditorJsonEntry {
  file?: string;
  version?: string;
}

/** editor.Creator / editor.Creator3D 容器 */
interface EditorBucket {
  Creator?: EditorJsonEntry[];
  Creator3D?: EditorJsonEntry[];
}

/** editor.json 结构（editor 可能在顶层或在 config 下，两种都兼容） */
interface EditorJson {
  editor?: EditorBucket;
  config?: {
    editor?: EditorBucket;
  };
}

/** 本地配置文件结构 */
interface CocosCliConfig {
  cocosCreatorPath?: string;
}

/**
 * CocosCreator 可执行文件名（按平台）
 * Windows: CocosCreator.exe  其它: CocosCreator
 */
function creatorExecutableName(): string {
  return isWindows() ? 'CocosCreator.exe' : 'CocosCreator';
}

// ============================== 版本择优 ==============================

/**
 * 版本排序比较：偏好版 3.7.3 永远排最前，其余按语义化版本降序
 * 返回负数表示 a 排在 b 前面
 */
export function sortVersions(a: string, b: string): number {
  if (a === PREFERRED_CREATOR_VERSION) return -1;
  if (b === PREFERRED_CREATOR_VERSION) return 1;
  return compareSemverDesc(a, b);
}

/** 语义化版本降序比较（版本高的排前面） */
function compareSemverDesc(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 解析版本号前几段数字，如 "3.7.3" -> [3,7,3] */
function parseVersionParts(v: string): number[] {
  return v
    .split('.')
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
}

// ============================== 路径验证 ==============================

/**
 * 验证路径是否指向可执行的 CocosCreator
 * 接受三种输入（宽容设计，env/editor.json 填到哪一级都能解析）：
 *   1. 直接是 exe 路径
 *   2. 是版本根目录（如 ...\Creator\3.7.3）
 *   3. 是 editors 父目录（如 ...\Creator，含多个版本子目录）
 *   4. Mac 下是 .app 目录（取 Contents/MacOS/CocosCreator）
 * 验证通过返回 exe 完整路径，否则返回 null
 */
export function validateCreatorPath(p: string): string | null {
  if (!p || !fs.existsSync(p)) return null;

  const exeName = creatorExecutableName();

  // 1. Mac .app 目录
  if (isMac() && p.toLowerCase().endsWith('.app') && fs.statSync(p).isDirectory()) {
    const macExe = path.join(p, 'Contents', 'MacOS', exeName);
    if (fs.existsSync(macExe)) return macExe;
  }

  // 2. 直接是 exe
  if (p.toLowerCase().endsWith(exeName.toLowerCase()) && fs.statSync(p).isFile()) {
    return p;
  }

  // 非目录则到此为止
  if (!fs.statSync(p).isDirectory()) return null;

  // 3. 版本根目录：直接拼 exe
  const directExe = path.join(p, exeName);
  if (fs.existsSync(directExe)) return directExe;

  // 4. editors 父目录：扫描版本子目录
  const versions = scanVersionDirs(p).sort(sortVersions);
  for (const v of versions) {
    const exe = path.join(p, v, exeName);
    if (fs.existsSync(exe)) return exe;
  }

  return null;
}

/** 扫描目录下形如 x.y.z 的版本子目录名 */
function scanVersionDirs(dir: string): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const versionRe = /^\d+\.\d+\.\d+/;
  for (const e of entries) {
    if (e.isDirectory() && versionRe.test(e.name)) {
      result.push(e.name);
    }
  }
  return result;
}

// ============================== 5 级查找 ==============================

/**
 * 5 级查找 CocosCreator 可执行文件
 * 顺序：环境变量 -> 系统命令 -> editor.json -> 常见目录 -> 配置兜底
 * 命中即返回 exe 完整路径，全部失败返回 null
 */
export function findCocosCreatorPath(): string | null {
  const hit =
    findByEnv() ??
    findBySystemCommand() ??
    findByEditorJson() ??
    findByCommonDirs() ??
    findByConfig();
  return hit;
}

/** 方法 1：环境变量 COCOS_CREATOR_PATH / COCOS_CREATOR */
function findByEnv(): string | null {
  const candidates = [process.env.COCOS_CREATOR_PATH, process.env.COCOS_CREATOR];
  for (const c of candidates) {
    if (c) {
      const validated = validateCreatorPath(c);
      if (validated) return validated;
    }
  }
  return null;
}

/** 方法 2：系统命令 where(Windows) / which(类 Unix) */
function findBySystemCommand(): string | null {
  const exe = creatorExecutableName();
  const cmd = isWindows() ? `where ${exe}` : `which ${exe}`;
  try {
    const out = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // where 可能返回多行，取第一个有效
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) {
      return validateCreatorPath(first);
    }
  } catch {
    // 命令不存在或未命中，忽略
  }
  return null;
}

/** 方法 3：读取 ~/.Cocos/profiles/editor.json，Creator 优先，空则 Creator3D */
function findByEditorJson(): string | null {
  const jsonPath = path.join(getHomeDir(), '.Cocos', 'profiles', 'editor.json');
  if (!fs.existsSync(jsonPath)) return null;

  let data: EditorJson;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as EditorJson;
  } catch {
    return null;
  }

  for (const f of pickEditorFiles(data)) {
    const validated = validateCreatorPath(f);
    if (validated) return validated;
  }
  return null;
}

/**
 * 从 editor.json 数据中提取候选 file 列表（按版本择优排序）
 * editor 可能在顶层（本机实测结构）或在 config 下，两种都兼容
 * Creator 优先，Creator 为空才用 Creator3D
 */
export function pickEditorFiles(data: EditorJson): string[] {
  const editor = data?.editor ?? data?.config?.editor;
  if (!editor) return [];
  const list = editor.Creator && editor.Creator.length ? editor.Creator : editor.Creator3D ?? [];
  return extractEditorFiles(list);
}

/** 从 editor.json 条目数组提取有效 file 并按版本择优排序 */
function extractEditorFiles(entries: EditorJsonEntry[]): string[] {
  const items = entries
    .filter((e) => e && typeof e.file === 'string' && fs.existsSync(e.file))
    .map((e) => ({ file: e.file as string, version: String(e.version ?? '') }));
  items.sort((a, b) => sortVersions(a.version, b.version));
  return items.map((i) => i.file);
}

/** 方法 4：扫描常见安装目录（以 Windows 为主） */
function findByCommonDirs(): string | null {
  for (const d of getCommonInstallDirs()) {
    if (!fs.existsSync(d)) continue;
    const validated = validateCreatorPath(d);
    if (validated) return validated;
  }
  return null;
}

/** 常见安装目录列表 */
function getCommonInstallDirs(): string[] {
  const dirs = [
    path.join('C:', 'Program Files (x86)', 'cocos', 'editors', 'Creator'),
    path.join('D:', 'Program Files (x86)', 'cocos', 'editors', 'Creator'),
    path.join('C:', 'Program Files', 'cocos', 'editors', 'Creator'),
    path.join('D:', 'Program Files', 'cocos', 'editors', 'Creator'),
  ];
  const localAppData = process.env.LOCALAPPDATA ?? path.join(getHomeDir(), 'AppData', 'Local');
  dirs.push(path.join(localAppData, 'Programs', 'cocos', 'editors', 'Creator'));
  return dirs;
}

/** 方法 5：本地配置文件 cocoscli.json 的写死值 */
function findByConfig(): string | null {
  const cfg = readConfig();
  if (cfg.cocosCreatorPath) {
    return validateCreatorPath(cfg.cocosCreatorPath);
  }
  return null;
}

// ============================== 配置读写 ==============================

/** 本地配置文件路径 */
function getConfigPath(): string {
  return path.join(getConfigDir(), 'cocoscli.json');
}

/** 读取本地配置，文件不存在或解析失败均返回空对象 */
function readConfig(): CocosCliConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CocosCliConfig;
  } catch {
    return {};
  }
}

/** 写入本地配置（自动创建目录） */
function writeConfig(cfg: CocosCliConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** 找到路径后按需回写配置（路径不同或配置缺失才写） */
function maybeSaveConfig(found: string): void {
  const cfg = readConfig();
  const needSave =
    !cfg.cocosCreatorPath ||
    !fs.existsSync(cfg.cocosCreatorPath) ||
    path.normalize(cfg.cocosCreatorPath) !== path.normalize(found);
  if (needSave) {
    cfg.cocosCreatorPath = found;
    writeConfig(cfg);
  }
}

// ============================== 对外入口 ==============================

/**
 * 对外入口：查找 CocosCreator 路径
 * 1. 走 5 级查找，命中则按 autoSave 决定是否回写配置
 * 2. 全部失败则回退读配置写死值
 * 3. 仍失败则抛错（含三种修复提示），由命令层决定如何退出
 */
export function getCocosCreatorPath(autoSave = true): string {
  const found = findCocosCreatorPath();
  if (found) {
    if (autoSave) maybeSaveConfig(found);
    return found;
  }

  // 兜底：配置写死值（即使磁盘上不存在也返回，交给调用方判断）
  const cfg = readConfig();
  if (cfg.cocosCreatorPath) {
    return cfg.cocosCreatorPath;
  }

  throw new Error(buildNotFoundMessage());
}

/** 构造「未找到 CocosCreator」的提示信息 */
function buildNotFoundMessage(): string {
  return [
    '未找到 CocosCreator，请通过以下任一方式指定：',
    '  1. 设置环境变量 COCOS_CREATOR_PATH 指向 CocosCreator 可执行文件',
    '  2. 确保 CocosCreator 已安装并加入系统 PATH',
    '  3. 在配置文件手动配置 cocosCreatorPath：' + getConfigPath(),
  ].join('\n');
}

/**
 * 用 CocosCreator 打开工程（非阻塞）
 * spawn detached + unref，CLI 拉起编辑器后可立即退出
 */
export function openCocosProject(creatorPath: string, projectPath: string): void {
  const args = ['--project', projectPath];
  const child = spawn(creatorPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
