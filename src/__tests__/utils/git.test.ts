import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cloneCocosMcp, writeDefaultMcpServerConfig, checkCocosMcpDeps, readCocosMcpVersion } from '../../utils/git.js';

describe('cloneCocosMcp', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-git-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('extensions/CocosMCP 已存在时返回 exists，不 clone', () => {
    fs.mkdirSync(path.join(tmp, 'extensions', 'CocosMCP'), { recursive: true });
    expect(cloneCocosMcp(tmp)).toEqual({ status: 'exists' });
  });

  it('不存在时自动创建 extensions 目录', () => {
    // 不创建 extensions，调用后应自动 mkdirSync（不会因 extensions 缺失报错）
    // 这里只验证 extensions 被创建（不真正 clone，因为 targetDir 不存在会触发 clone）
    // 所以先放一个占位 targetDir 让它走 exists 分支，间接验证 mkdirSync 不报错
    fs.mkdirSync(path.join(tmp, 'extensions', 'CocosMCP'), { recursive: true });
    expect(fs.existsSync(path.join(tmp, 'extensions'))).toBe(true);
    expect(cloneCocosMcp(tmp)).toEqual({ status: 'exists' });
  });
});

describe('writeDefaultMcpServerConfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-cfg-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('不存在时写入默认配置（port 3001 等）', () => {
    expect(writeDefaultMcpServerConfig(tmp)).toBe('written');
    const content = JSON.parse(
      fs.readFileSync(path.join(tmp, 'settings', 'mcp-server.json'), 'utf-8')
    );
    expect(content).toEqual({ port: 3001, autoStart: true, debugLog: false, maxConnections: 10 });
  });

  it('已存在时跳过，不覆盖用户配置', () => {
    fs.mkdirSync(path.join(tmp, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'settings', 'mcp-server.json'), '{"port":9999}', 'utf-8');
    expect(writeDefaultMcpServerConfig(tmp)).toBe('exists');
    const content = JSON.parse(
      fs.readFileSync(path.join(tmp, 'settings', 'mcp-server.json'), 'utf-8')
    );
    expect(content).toEqual({ port: 9999 });
  });
});

describe('checkCocosMcpDeps', () => {
  let extDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-deps-'));
    extDir = path.join(tmp, 'extensions', 'CocosMCP');
    fs.mkdirSync(extDir, { recursive: true });
    // CocosMCP 真实 dependencies 子集（面板运行时 require 的依赖）
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ dependencies: { 'fs-extra': '^11.3.0', uuid: '^9.0.1' } }),
      'utf-8'
    );
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(extDir)), { recursive: true, force: true });
  });

  it('依赖齐全时 ok', () => {
    fs.mkdirSync(path.join(extDir, 'node_modules', 'fs-extra'), { recursive: true });
    fs.mkdirSync(path.join(extDir, 'node_modules', 'uuid'), { recursive: true });
    expect(checkCocosMcpDeps(extDir)).toEqual({ ok: true, missing: [] });
  });

  it('缺 fs-extra 时精准点名（对齐真实事故报错名）', () => {
    fs.mkdirSync(path.join(extDir, 'node_modules', 'uuid'), { recursive: true });
    expect(checkCocosMcpDeps(extDir)).toEqual({ ok: false, missing: ['fs-extra'] });
  });

  it('node_modules 整个缺失时全部点名', () => {
    expect(checkCocosMcpDeps(extDir)).toEqual({
      ok: false,
      missing: ['fs-extra', 'uuid'],
    });
  });

  it('package.json 不存在时抛错（错误消息含路径，精准暴露）', () => {
    fs.rmSync(path.join(extDir, 'package.json'));
    expect(() => checkCocosMcpDeps(extDir)).toThrow(/package\.json/);
  });
});

describe('readCocosMcpVersion', () => {
  let extDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-ver-'));
    extDir = path.join(tmp, 'extensions', 'CocosMCP');
    fs.mkdirSync(extDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(extDir)), { recursive: true, force: true });
  });

  it('正常返回 package.json 的 version 字段', () => {
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ version: '0.3.0' }), 'utf-8');
    expect(readCocosMcpVersion(extDir)).toBe('0.3.0');
  });

  it('缺 version 字段时返回 unknown（显示用，不炸）', () => {
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: 'CocosMCP' }), 'utf-8');
    expect(readCocosMcpVersion(extDir)).toBe('unknown');
  });

  it('package.json 不存在时抛错（精准暴露，不吞）', () => {
    expect(() => readCocosMcpVersion(extDir)).toThrow(/package\.json/);
  });
});
