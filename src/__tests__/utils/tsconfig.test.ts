import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureRootTsconfig } from '../../utils/tsconfig.js';

describe('ensureRootTsconfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-tsconfig-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('不存在时写推荐模板（2 空格缩进 + 末尾换行），hasBase 跟随 temp 目录', () => {
    const r = ensureRootTsconfig(tmp);
    expect(r.status).toBe('written');
    expect(r.hasBase).toBe(false); // 未建 temp/tsconfig.cocos.json
    const raw = fs.readFileSync(path.join(tmp, 'tsconfig.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      extends: './temp/tsconfig.cocos.json',
      compilerOptions: { lib: ['ES2017', 'DOM'], skipLibCheck: true },
      include: ['assets/**/*.ts'],
      exclude: ['node_modules', 'extensions', 'library'],
    });
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "extends"'); // 2 空格缩进
  });

  it('temp/tsconfig.cocos.json 存在时 hasBase 为 true', () => {
    fs.mkdirSync(path.join(tmp, 'temp'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'temp', 'tsconfig.cocos.json'), '{}', 'utf-8');
    const r = ensureRootTsconfig(tmp);
    expect(r.status).toBe('written');
    expect(r.hasBase).toBe(true);
  });

  it('已存在时完全不碰（字节不变），missingSkipLibCheck 为 true', () => {
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{"compilerOptions":{}}', 'utf-8');
    const before = fs.readFileSync(path.join(tmp, 'tsconfig.json'), 'utf-8');
    const r = ensureRootTsconfig(tmp);
    expect(r.status).toBe('exists');
    expect(r.missingSkipLibCheck).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'tsconfig.json'), 'utf-8')).toBe(before);
  });

  it('已存在且含 "skipLibCheck": true 时 missingSkipLibCheck 为 false', () => {
    fs.writeFileSync(
      path.join(tmp, 'tsconfig.json'),
      '{"compilerOptions":{"skipLibCheck": true}}',
      'utf-8'
    );
    const r = ensureRootTsconfig(tmp);
    expect(r.status).toBe('exists');
    expect(r.missingSkipLibCheck).toBe(false);
  });

  it('skipLibCheck 探测容忍 JSONC 注释与空白变体，不抛错', () => {
    fs.writeFileSync(
      path.join(tmp, 'tsconfig.json'),
      '// 工程注释\n{\n  "compilerOptions": { "skipLibCheck" : true }\n}',
      'utf-8'
    );
    const r = ensureRootTsconfig(tmp);
    expect(r.status).toBe('exists');
    expect(r.missingSkipLibCheck).toBe(false);
  });
});
