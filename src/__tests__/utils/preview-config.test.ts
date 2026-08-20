import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readPreviewConfig,
  resolvePreviewQuery,
  appendPreviewQuery,
  DEFAULT_PREVIEW_CONFIG,
} from '../../utils/preview-config.js';

// 用真实临时目录验证落盘（readPreviewConfig 会写默认模板）
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-pv-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readPreviewConfig', () => {
  it('不存在时写默认模板 + created=true', () => {
    const { config, created } = readPreviewConfig(dir);
    expect(created).toBe(true);
    expect(config.default).toBe(DEFAULT_PREVIEW_CONFIG.default);
    expect(config.scenes).toEqual(DEFAULT_PREVIEW_CONFIG.scenes);
    // 文件已落盘，含 $schema 注释字段
    const raw = fs.readFileSync(path.join(dir, '.cocoscli', 'preview.config.json'), 'utf-8');
    expect(raw).toContain('$schema');
  });

  it('存在时读取用户配置 + created=false', () => {
    const cfgDir = path.join(dir, '.cocoscli');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'preview.config.json'),
      JSON.stringify({ default: 'ui=1', scenes: { hall: 'gameid=2' } }),
      'utf-8'
    );
    const { config, created } = readPreviewConfig(dir);
    expect(created).toBe(false);
    expect(config.default).toBe('ui=1');
    expect(config.scenes).toEqual({ hall: 'gameid=2' });
  });

  it('JSON 解析失败抛错（不吞）', () => {
    const cfgDir = path.join(dir, '.cocoscli');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'preview.config.json'), '{ 不是合法 json', 'utf-8');
    expect(() => readPreviewConfig(dir)).toThrow(SyntaxError);
  });
});

describe('resolvePreviewQuery 优先级：--query > scenes[场景] > default > 空', () => {
  const config = {
    default: 'ui=10000&gameid=42272',
    scenes: { loading: 'gameid=999', empty: '' },
  };

  it('--query 临时覆盖一切', () => {
    expect(resolvePreviewQuery('loading', config, 'ui=1&gameid=2')).toBe('ui=1&gameid=2');
  });

  it('无 --query 时场景级覆盖 default', () => {
    expect(resolvePreviewQuery('loading', config)).toBe('gameid=999');
  });

  it('场景名匹配 previewscene 入参原样（如 main.scene 也算不同 key）', () => {
    expect(resolvePreviewQuery('main.scene', config)).toBe('ui=10000&gameid=42272');
  });

  it('场景无配置时落到 default', () => {
    expect(resolvePreviewQuery('hall', config)).toBe('ui=10000&gameid=42272');
  });

  it('场景配置为空串时跳过落到 default（空串视为未配置）', () => {
    expect(resolvePreviewQuery('empty', config)).toBe('ui=10000&gameid=42272');
  });

  it('无任何配置返回空串', () => {
    expect(resolvePreviewQuery('hall', {})).toBe('');
    expect(resolvePreviewQuery('hall', null)).toBe('');
  });

  it('--query 空白串视为未传（落到配置）', () => {
    expect(resolvePreviewQuery('loading', config, '   ')).toBe('gameid=999');
  });
});

describe('appendPreviewQuery', () => {
  it('裸地址拼 /?query', () => {
    expect(appendPreviewQuery('http://localhost:7456', 'ui=10000&gameid=42272')).toBe(
      'http://localhost:7456/?ui=10000&gameid=42272'
    );
  });

  it('已带 ? 用 & 衔接', () => {
    expect(appendPreviewQuery('http://localhost:7456/?x=1', 'ui=10000')).toBe(
      'http://localhost:7456/?x=1&ui=10000'
    );
  });

  it('query 为空原样返回', () => {
    expect(appendPreviewQuery('http://localhost:7456', '')).toBe('http://localhost:7456');
    expect(appendPreviewQuery('http://localhost:7456', '   ')).toBe('http://localhost:7456');
  });
});
