import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCompileLog, readSnippet } from '../../utils/compile-log.js';

// 用真实临时目录验证落盘路径（writeCompileLog 是薄封装，无需 mock fs）
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-log-'));
const sep = path.sep;

describe('writeCompileLog', () => {
  it('无 category：写到 .cocoscli 根目录（向后兼容）', () => {
    const dir = tmpDir();
    const p = writeCompileLog(dir, 'compile-log-', { a: 1 });
    expect(p).toContain(['.cocoscli'].join(sep));
    expect(p).not.toContain(['.cocoscli', 'logs'].join(sep));
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ a: 1 });
  });

  it('有 category：写到 .cocoscli/logs/<category>/ 子目录', () => {
    const dir = tmpDir();
    const p = writeCompileLog(dir, 'eval-log-', { b: 2 }, 'eval');
    expect(p).toContain(['.cocoscli', 'logs', 'eval'].join(sep));
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ b: 2 });
  });

  it('timestamp 参数控制文件名（build-log 与 build-raw 同名配对用）', () => {
    const dir = tmpDir();
    const ts = '2024-01-02T03-04-05';
    const p = writeCompileLog(dir, 'build-log-', { c: 3 }, 'build', ts);
    expect(path.basename(p)).toBe(`build-log-${ts}.json`);
    expect(p).toContain(['.cocoscli', 'logs', 'build'].join(sep));
  });

  it('多次写同 category 落同一子目录', () => {
    const dir = tmpDir();
    const p1 = writeCompileLog(dir, 'eslint-log-', { i: 1 }, 'lint');
    const p2 = writeCompileLog(dir, 'eslint-log-', { i: 2 }, 'lint');
    expect(path.dirname(p1)).toBe(path.dirname(p2));
  });

  it('JSON 内容 2 空格缩进 + 末尾换行', () => {
    const dir = tmpDir();
    const p = writeCompileLog(dir, 'browserlogs-', { x: 1 }, 'browserlogs');
    const raw = fs.readFileSync(p, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "x": 1');
  });
});

describe('readSnippet', () => {
  it('读指定行附近片段（上下文 1 行）', () => {
    const f = path.join(os.tmpdir(), `snippet-${Date.now()}.txt`);
    fs.writeFileSync(f, 'a\nb\nc\nd\ne\n', 'utf-8');
    expect(readSnippet(f, 3, 1)).toBe('b\nc\nd');
  });

  it('文件不存在返回空串（不抛）', () => {
    expect(readSnippet(path.join(os.tmpdir(), `nope-${Date.now()}.txt`), 1)).toBe('');
  });
});
