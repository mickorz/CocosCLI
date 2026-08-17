import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 全局工程注册表（~/.cocoscli/projects.json）
//
// registry.ts
//        ├─> getRegistryPath(home)   ~/.cocoscli/projects.json（home 参数化便于单测）
//        ├─> readProjects(path)      读全部记录（文件不存在返回 []，坏 JSON 抛错）
//        ├─> upsertProject(...)      init 第八步：同 dir 更新（版本/端口/时间刷新），否则追加
//        └─> removeProject(...)      remove 第五步：按精确 dir 移除（不存在不写文件）

/** 单个已注册工程 */
export interface RegisteredProject {
  /** 工程绝对路径（唯一键，init/remove 两端都 path.resolve 过） */
  dir: string;
  /** init 时 CocosMCP package.json 的 version 快照 */
  cocosMcpVersion: string;
  /** init 时 settings/mcp-server.json 的端口（实际生效端口，非 init 参数） */
  port: number;
  /** init 完成时间（ISO 8601） */
  initAt: string;
}

/**
 * 全局配置文件路径（~/.cocoscli/projects.json）
 *
 * @param home 用户主目录，默认 os.homedir()（单测传临时目录）
 */
export function getRegistryPath(home: string = os.homedir()): string {
  return path.join(home, '.cocoscli', 'projects.json');
}

/**
 * 读全部已注册工程
 *
 * @param registryPath 配置文件路径（getRegistryPath 的返回值）
 * @returns 记录数组；文件不存在返回 []
 * @throws 文件存在但 JSON 解析失败时抛错（错误消息含路径，精准暴露，不吞）
 */
export function readProjects(registryPath: string): RegisteredProject[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  let data: { projects?: RegisteredProject[] };
  try {
    data = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as { projects?: RegisteredProject[] };
  } catch (e) {
    throw new Error(
      `${registryPath} 解析失败：${e instanceof Error ? e.message : e}`
    );
  }
  return data.projects ?? [];
}

/** 写回配置文件（自动创建 ~/.cocoscli 目录，2 空格缩进 + 末尾换行） */
function writeProjects(registryPath: string, projects: RegisteredProject[]): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ projects }, null, 2) + '\n', 'utf-8');
}

/**
 * 登记/更新一条工程记录（init 第八步调用）
 *
 * 以 dir 为唯一键 upsert：同 dir 二次 init 是更新（版本/端口/时间刷新），
 * 与 init 幂等语义一致（扩展已存在跳过、mcp-server.json 已存在跳过）。
 *
 * @returns added 新增 / updated 更新已有记录
 */
export function upsertProject(
  registryPath: string,
  project: RegisteredProject
): 'added' | 'updated' {
  const projects = readProjects(registryPath);
  const idx = projects.findIndex((p) => p.dir === project.dir);
  if (idx >= 0) {
    projects[idx] = project;
    writeProjects(registryPath, projects);
    return 'updated';
  }
  projects.push(project);
  writeProjects(registryPath, projects);
  return 'added';
}

/**
 * 按精确 dir 移除一条记录（remove 第五步调用）
 *
 * @returns true 已移除 / false 记录不存在（此时不写文件，保持字节不变）
 */
export function removeProject(registryPath: string, dir: string): boolean {
  const projects = readProjects(registryPath);
  const idx = projects.findIndex((p) => p.dir === dir);
  if (idx < 0) {
    return false;
  }
  projects.splice(idx, 1);
  writeProjects(registryPath, projects);
  return true;
}
