import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getRegistryPath,
  readProjects,
  upsertProject,
  removeProject,
  RegisteredProject,
} from '../../utils/registry.js';

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    dir: 'E:\\proj\\demo',
    cocosMcpVersion: '0.3.0',
    port: 3001,
    initAt: '2026-08-17T03:04:05.000Z',
    ...overrides,
  };
}

describe('registry', () => {
  let home: string;
  let registryPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-registry-'));
    registryPath = getRegistryPath(home);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('getRegistryPath：home 下拼 .cocoscli/projects.json（跨平台 path.join）', () => {
    expect(getRegistryPath(path.join('C:', 'Users', 'u'))).toBe(
      path.join('C:', 'Users', 'u', '.cocoscli', 'projects.json')
    );
  });

  it('readProjects：文件不存在返回 []，不报错', () => {
    expect(readProjects(registryPath)).toEqual([]);
  });

  it('readProjects：正常读取 projects 数组', () => {
    const p = makeProject();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ projects: [p] }, null, 2), 'utf-8');
    expect(readProjects(registryPath)).toEqual([p]);
  });

  it('readProjects：坏 JSON 抛错且错误消息含文件路径（不吞错）', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{ 坏 JSON', 'utf-8');
    expect(() => readProjects(registryPath)).toThrow(registryPath);
  });

  it('upsertProject：新增一条，2 空格缩进 + 末尾换行，自动创建 .cocoscli 目录', () => {
    const p = makeProject();
    expect(upsertProject(registryPath, p)).toBe('added');
    const raw = fs.readFileSync(registryPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ projects: [p] });
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "projects"'); // 2 空格缩进
    expect(fs.existsSync(path.dirname(registryPath))).toBe(true); // 目录已自动创建
  });

  it('upsertProject：同 dir 二次登记是更新，不追加，字段刷新', () => {
    upsertProject(registryPath, makeProject());
    const r = upsertProject(
      registryPath,
      makeProject({ cocosMcpVersion: '0.4.0', port: 3002, initAt: '2026-08-18T00:00:00.000Z' })
    );
    expect(r).toBe('updated');
    const projects = readProjects(registryPath);
    expect(projects).toHaveLength(1);
    expect(projects[0].cocosMcpVersion).toBe('0.4.0');
    expect(projects[0].port).toBe(3002);
    expect(projects[0].initAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('removeProject：存在时移除并保留其余记录', () => {
    upsertProject(registryPath, makeProject());
    const other = makeProject({ dir: 'E:\\proj\\other', port: 3002 });
    upsertProject(registryPath, other);
    expect(removeProject(registryPath, makeProject().dir)).toBe(true);
    expect(readProjects(registryPath)).toEqual([other]);
  });

  it('removeProject：记录不存在返回 false 且文件字节不变', () => {
    upsertProject(registryPath, makeProject());
    const before = fs.readFileSync(registryPath, 'utf-8');
    expect(removeProject(registryPath, 'E:\\proj\\不存在')).toBe(false);
    expect(fs.readFileSync(registryPath, 'utf-8')).toBe(before);
  });
});
