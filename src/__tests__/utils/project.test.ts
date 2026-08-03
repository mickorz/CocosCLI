import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCocosProject, normalizePath } from '../../utils/project.js';

describe('normalizePath', () => {
  // 以下断言基于 Windows 行为（小写、正斜杠、无尾部分隔符）
  it('反斜杠统一为正斜杠并转小写', () => {
    expect(normalizePath('D:\\A\\B')).toBe('d:/a/b');
  });

  it('去掉尾部分隔符', () => {
    expect(normalizePath('D:/A/B/')).toBe('d:/a/b');
    expect(normalizePath('D:\\A\\B\\')).toBe('d:/a/b');
  });

  it('大小写与分隔符差异不影响等价判断（Windows）', () => {
    expect(normalizePath('D:\\MyGame')).toBe(normalizePath('d:/mygame'));
  });
});

describe('isCocosProject', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-proj-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('同时有 assets 与 settings 视为 Cocos 工程', () => {
    fs.mkdirSync(path.join(tmp, 'assets'));
    fs.mkdirSync(path.join(tmp, 'settings'));
    expect(isCocosProject(tmp)).toBe(true);
  });

  it('缺少 settings 不视为 Cocos 工程', () => {
    fs.mkdirSync(path.join(tmp, 'assets'));
    expect(isCocosProject(tmp)).toBe(false);
  });

  it('缺少 assets 不视为 Cocos 工程', () => {
    fs.mkdirSync(path.join(tmp, 'settings'));
    expect(isCocosProject(tmp)).toBe(false);
  });

  it('空目录不视为 Cocos 工程', () => {
    expect(isCocosProject(tmp)).toBe(false);
  });

  it('目录不存在返回 false', () => {
    expect(isCocosProject(path.join(tmp, 'nope'))).toBe(false);
  });
});
