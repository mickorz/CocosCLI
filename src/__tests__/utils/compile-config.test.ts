import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCompileConfig, DEFAULT_COMPILE_CONFIG } from '../../utils/compile-config.js';

/** 构造临时工程目录（含 .cocoscli/） */
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-cfg-'));
  return dir;
}

/** 清理临时目录 */
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 写工程 .cocoscli/compile.config.json */
function writeConfig(dir: string, content: string): void {
  fs.mkdirSync(path.join(dir, '.cocoscli'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cocoscli', 'compile.config.json'), content, 'utf-8');
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('readCompileConfig', () => {
  it('配置文件不存在 → 写默认模板 + 返回默认（strict:false）', () => {
    const dir = tmpProject();
    dirs.push(dir);
    const cfg = readCompileConfig(dir);
    expect(cfg).toEqual(DEFAULT_COMPILE_CONFIG);
    expect(cfg.strict).toBe(false);
    // 默认模板已写入
    const configPath = path.join(dir, '.cocoscli', 'compile.config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.strict).toBe(false);
  });

  it('配置文件 strict:true → 读取并应用', () => {
    const dir = tmpProject();
    dirs.push(dir);
    writeConfig(dir, '{"strict":true}');
    const cfg = readCompileConfig(dir);
    expect(cfg.strict).toBe(true);
  });

  it('配置文件只有部分字段 → 与默认合并（未写字段用默认）', () => {
    const dir = tmpProject();
    dirs.push(dir);
    writeConfig(dir, '{}');
    const cfg = readCompileConfig(dir);
    expect(cfg.strict).toBe(false);
  });

  it('配置文件 JSON 格式错 → 抛 SyntaxError（暴露问题，不吞错）', () => {
    const dir = tmpProject();
    dirs.push(dir);
    writeConfig(dir, '{invalid json');
    expect(() => readCompileConfig(dir)).toThrow(SyntaxError);
  });

  it('二次调用已存在的配置文件 → 不覆盖用户配置', () => {
    const dir = tmpProject();
    dirs.push(dir);
    writeConfig(dir, '{"strict":true}');
    readCompileConfig(dir);
    const cfg2 = readCompileConfig(dir);
    expect(cfg2.strict).toBe(true);
    // 文件内容未被改写
    const content = fs.readFileSync(path.join(dir, '.cocoscli', 'compile.config.json'), 'utf-8');
    expect(content).toBe('{"strict":true}');
  });
});
