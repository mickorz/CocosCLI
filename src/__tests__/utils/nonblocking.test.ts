import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readNonblockingConfig,
  matchNonblockingCompile,
  matchNonblockingBrowserlogs,
  filterNonblockingCompile,
  filterNonblockingBrowserlogs,
  DEFAULT_NONBLOCKING_CONFIG,
  type KnownNonblockingConfig,
} from '../../utils/nonblocking.js';

// 用真实临时目录验证落盘（readNonblockingConfig 会写默认模板）
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-nb-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readNonblockingConfig', () => {
  it('不存在时写默认模板 + created=true', () => {
    const { config, created } = readNonblockingConfig(dir);
    expect(created).toBe(true);
    expect(config.compile).toHaveLength(DEFAULT_NONBLOCKING_CONFIG.compile!.length);
    expect(config.browserlogs).toHaveLength(DEFAULT_NONBLOCKING_CONFIG.browserlogs!.length);
    // 文件已落盘，含 $schema/$matching 注释字段
    const raw = fs.readFileSync(path.join(dir, '.cocoscli', 'known_nonblocking_errors.json'), 'utf-8');
    expect(raw).toContain('$schema');
    expect(raw).toContain('$matching');
  });

  it('存在时读取用户配置 + created=false', () => {
    // 先写一份自定义配置
    const cfgDir = path.join(dir, '.cocoscli');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'known_nonblocking_errors.json'),
      JSON.stringify({ compile: [{ code: 'TS9999', reason: '自定义' }], browserlogs: [] }),
      'utf-8'
    );
    const { config, created } = readNonblockingConfig(dir);
    expect(created).toBe(false);
    expect(config.compile).toEqual([{ code: 'TS9999', reason: '自定义' }]);
    expect(config.browserlogs).toEqual([]);
  });

  it('JSON 解析失败抛错（不吞）', () => {
    const cfgDir = path.join(dir, '.cocoscli');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'known_nonblocking_errors.json'), '{ 不是合法 json', 'utf-8');
    expect(() => readNonblockingConfig(dir)).toThrow(SyntaxError);
  });
});

describe('matchNonblockingCompile', () => {
  // 基础 config：code 精确匹配（无 file/message 细化）
  const config: KnownNonblockingConfig = {
    compile: [
      { code: 'TS2339', reason: '属性不存在' },
      { code: 'TS9999', message_contains: 'specific msg', reason: '特定消息' },
      { message_contains: 'any code ok', reason: '空 code 忽略 code 检查' },
    ],
  };

  it('code 精确匹配', () => {
    const r = matchNonblockingCompile({ code: 'TS2339', file: 'x.ts', message: 'm' }, config);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('属性不存在');
  });

  it('code 不匹配则不命中', () => {
    expect(matchNonblockingCompile({ code: 'TS1111', file: 'x.ts', message: 'm' }, config).matched).toBe(false);
  });

  it('message_contains 细化', () => {
    const r = matchNonblockingCompile({ code: 'TS9999', file: 'x.ts', message: 'this is specific msg here' }, config);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('特定消息');
  });

  it('message_contains 不含则不命中该规则', () => {
    expect(
      matchNonblockingCompile({ code: 'TS9999', file: 'x.ts', message: 'no match' }, config).matched
    ).toBe(false);
  });

  it('空 code 规则忽略 code 检查（仅按 message_contains）', () => {
    const r = matchNonblockingCompile({ code: 'TS0001', file: 'x.ts', message: 'hit any code ok' }, config);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('空 code 忽略 code 检查');
  });

  it('file 细化：file 不含子串则不命中', () => {
    const fileConfig: KnownNonblockingConfig = {
      compile: [{ code: 'TS2339', file: 'biz/a.ts', reason: '特定文件' }],
    };
    expect(matchNonblockingCompile({ code: 'TS2339', file: 'other.ts', message: 'm' }, fileConfig).matched).toBe(false);
  });

  it('file 细化：file 含子串命中', () => {
    const fileConfig: KnownNonblockingConfig = {
      compile: [{ code: 'TS2339', file: 'biz/a.ts', reason: '特定文件' }],
    };
    const r = matchNonblockingCompile({ code: 'TS2339', file: 'src/biz/a.ts', message: 'm' }, fileConfig);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('特定文件');
  });

  it('规则顺序：第一条匹配即返回（宽泛规则会截断细化规则，与 Python 一致）', () => {
    // 宽泛 TS2339 在前，file 细化在后：任何 TS2339 都命中宽泛规则
    const orderedConfig: KnownNonblockingConfig = {
      compile: [
        { code: 'TS2339', reason: '宽泛' },
        { code: 'TS2339', file: 'biz/a.ts', reason: '细化' },
      ],
    };
    const r = matchNonblockingCompile({ code: 'TS2339', file: 'biz/a.ts', message: 'm' }, orderedConfig);
    expect(r.reason).toBe('宽泛');
  });

  it('空配置/空 compile 不命中', () => {
    expect(matchNonblockingCompile({ code: 'TS1' }, null).matched).toBe(false);
    expect(matchNonblockingCompile({ code: 'TS1' }, { compile: [] }).matched).toBe(false);
  });
});

describe('matchNonblockingBrowserlogs', () => {
  const config: KnownNonblockingConfig = {
    browserlogs: [{ message_contains: 'download failed: https://res.gameabc.com', reason: 'CDN 不可达' }],
  };

  it('text 包含子串命中', () => {
    const r = matchNonblockingBrowserlogs({ text: 'GET download failed: https://res.gameabc.com/picad/head1.png 404' }, config);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('CDN 不可达');
  });

  it('message 字段兜底（无 text 时取 message）', () => {
    const r = matchNonblockingBrowserlogs({ message: 'download failed: https://res.gameabc.com/x' }, config);
    expect(r.matched).toBe(true);
  });

  it('不含子串不命中', () => {
    expect(matchNonblockingBrowserlogs({ text: 'normal log line' }, config).matched).toBe(false);
  });

  it('空配置不命中', () => {
    expect(matchNonblockingBrowserlogs({ text: 'x' }, null).matched).toBe(false);
  });
});

describe('filterNonblockingCompile', () => {
  const config: KnownNonblockingConfig = {
    compile: [{ code: 'TS2339', reason: '非阻断' }],
  };

  it('命中移入 filtered（带 reason），其余留 kept', () => {
    const errors = [
      { code: 'TS2339', file: 'a.ts', message: 'm1' },
      { code: 'TS1111', file: 'b.ts', message: 'm2' },
      { code: 'TS2339', file: 'c.ts', message: 'm3' },
    ];
    const { kept, filtered } = filterNonblockingCompile(errors, config);
    expect(kept).toHaveLength(1);
    expect(kept[0].code).toBe('TS1111');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].reason).toBe('非阻断');
    expect(filtered[1].reason).toBe('非阻断');
  });

  it('空配置不过滤（全留 kept，filtered 空）', () => {
    const errors = [{ code: 'TS2339', file: 'a.ts', message: 'm' }];
    const { kept, filtered } = filterNonblockingCompile(errors, null);
    expect(kept).toHaveLength(1);
    expect(filtered).toHaveLength(0);
  });
});

describe('filterNonblockingBrowserlogs', () => {
  const config: KnownNonblockingConfig = {
    browserlogs: [{ message_contains: 'CDN_DOWN', reason: '环境问题' }],
  };

  it('命中移入 filtered，其余留 kept', () => {
    const logs = [
      { text: 'normal log' },
      { text: 'CDN_DOWN image.png' },
      { text: 'another normal' },
    ];
    const { kept, filtered } = filterNonblockingBrowserlogs(logs, config);
    expect(kept).toHaveLength(2);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].reason).toBe('环境问题');
  });

  it('空配置不过滤', () => {
    const logs = [{ text: 'CDN_DOWN' }];
    const { kept, filtered } = filterNonblockingBrowserlogs(logs, null);
    expect(kept).toHaveLength(1);
    expect(filtered).toHaveLength(0);
  });
});
