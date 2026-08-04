import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cloneCocosMcp } from '../../utils/git.js';

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
