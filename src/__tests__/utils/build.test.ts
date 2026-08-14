import { describe, it, expect } from 'vitest';
import {
  normalizePlatform,
  generateBuildConfig,
  cleanBuildErrorLine,
  classifyBuildErrorLine,
  summarizeBuildErrors,
} from '../../utils/build.js';

describe('normalizePlatform', () => {
  it('简称映射到 Cocos 原生 platform', () => {
    expect(normalizePlatform('web')).toBe('web-desktop');
    expect(normalizePlatform('wechat')).toBe('wechatgame');
    expect(normalizePlatform('douyin')).toBe('bytedancegame');
    expect(normalizePlatform('bytedance')).toBe('bytedancegame');
  });

  it('原生名保持不变', () => {
    expect(normalizePlatform('web-desktop')).toBe('web-desktop');
    expect(normalizePlatform('web-mobile')).toBe('web-mobile');
    expect(normalizePlatform('wechatgame')).toBe('wechatgame');
    expect(normalizePlatform('bytedancegame')).toBe('bytedancegame');
  });

  it('大小写不敏感', () => {
    expect(normalizePlatform('WEB')).toBe('web-desktop');
    expect(normalizePlatform('WeChat')).toBe('wechatgame');
    expect(normalizePlatform('DouYin')).toBe('bytedancegame');
  });

  it('未识别的名称原样返回（交给 CocosCreator 报错）', () => {
    expect(normalizePlatform('android')).toBe('android');
    expect(normalizePlatform('ios')).toBe('ios');
  });
});

describe('generateBuildConfig', () => {
  it('含 platform / buildPath / outputName 等通用字段', () => {
    const cfg = generateBuildConfig('web-desktop');
    expect(cfg.platform).toBe('web-desktop');
    expect(cfg.buildPath).toBe('project://build');
    expect(cfg.outputName).toBe('web-desktop');
    expect(cfg.md5Cache).toBe(true);
  });

  it('outputName 跟随 platform', () => {
    expect(generateBuildConfig('wechatgame').outputName).toBe('wechatgame');
  });

  it('不含 scenes / startScene 等工程特定字段', () => {
    const cfg = generateBuildConfig('web-desktop') as Record<string, unknown>;
    expect(cfg.scenes).toBeUndefined();
    expect(cfg.startScene).toBeUndefined();
    expect(cfg.name).toBeUndefined();
  });
});

describe('classifyBuildErrorLine（构建日志报错分类）', () => {
  it('模块找不到 → module', () => {
    const line = `  "error": "Error: Module \\"./not-exist-module\\" not found for file:///E:/x/assets/scripts/testerror/06-module-reference-error.ts",`;
    expect(classifyBuildErrorLine(line)).toBe('module');
  });

  it('URL 编码的语法错误 → syntax', () => {
    const encoded =
      'data:text/javascript,' +
      encodeURIComponent('\nthrow new Error(`SyntaxError: file.ts: Unexpected token (10:23)`);\n');
    expect(classifyBuildErrorLine(`[Programming] SyntaxError: E:\\proj\\${encoded}`)).toBe('syntax');
  });

  it('运行时引用错误 → runtime', () => {
    expect(classifyBuildErrorLine('2026-8-14 15:59:05-warn: ReferenceError: gfcc is not defined')).toBe('runtime');
    expect(classifyBuildErrorLine('TypeError: cannot read properties of undefined')).toBe('runtime');
  });

  it('编辑器 -error 级别日志 → editor', () => {
    expect(classifyBuildErrorLine('2026-8-14 15:59:53-error: Error: excute-taskbuild-script failed!')).toBe('editor');
  });

  it('普通日志行不命中', () => {
    expect(classifyBuildErrorLine('2026-8-14 15:59:12-debug: Json group(0846c28f0) compile success，json number: 6')).toBeNull();
    expect(classifyBuildErrorLine('[Package] menu@1.0.0 enable')).toBeNull();
  });
});

describe('cleanBuildErrorLine（报错行清洗）', () => {
  it('去掉 ANSI 颜色码与首尾空白', () => {
    expect(cleanBuildErrorLine('\x1b[31m  ReferenceError: gfcc is not defined  \x1b[0m')).toBe(
      'ReferenceError: gfcc is not defined'
    );
  });

  it('URL 编码的语法错误解码出可读信息', () => {
    const inner = 'SyntaxError: E:\\proj\\assets\\scripts\\testerror\\01-syntax-error.ts: Unexpected token, expected "," (10:23)';
    const encoded = 'data:text/javascript,' + encodeURIComponent(`\nthrow new Error(\`${inner}\`);\n`);
    expect(cleanBuildErrorLine(`[Programming] SyntaxError: ${encoded}`)).toBe(inner);
  });

  it('URL 解码失败（非法转义）时保留原文', () => {
    const line = 'SyntaxError: data:text/javascript,%E0%A4%A throw new Error(`bad`);';
    const cleaned = cleanBuildErrorLine(line);
    expect(cleaned.startsWith('SyntaxError: data:text/javascript,')).toBe(true);
  });

  it('超长行截断到 300 字符', () => {
    const cleaned = cleanBuildErrorLine('ReferenceError: ' + 'x'.repeat(500));
    expect(cleaned.length).toBe(300 + 3); // 300 字符 + "..."
    expect(cleaned.endsWith('...')).toBe(true);
  });
});

describe('summarizeBuildErrors（报错去重聚合）', () => {
  it('同类报错去重计数，记录首次行号', () => {
    const lines = [
      '[Package] menu@1.0.0 enable',                                  // 1 普通
      '2026-8-14 15:59:05-warn: ReferenceError: gfcc is not defined',  // 2 runtime
      '2026-8-14 15:59:06-warn: ReferenceError: gfcc is not defined',  // 3 runtime 同类
      '2026-8-14 15:59:53-error: Error: excute-taskbuild-script failed!', // 4 editor
    ];
    const summary = summarizeBuildErrors(lines);
    expect(summary).toHaveLength(2);
    const runtime = summary.find((e) => e.category === 'runtime');
    expect(runtime?.count).toBe(2);
    expect(runtime?.firstLine).toBe(2);
    const editor = summary.find((e) => e.category === 'editor');
    expect(editor?.count).toBe(1);
    expect(editor?.firstLine).toBe(4);
  });

  it('不同 message 不合并', () => {
    const lines = [
      'ReferenceError: aaa is not defined',
      'ReferenceError: bbb is not defined',
    ];
    expect(summarizeBuildErrors(lines)).toHaveLength(2);
  });

  it('空输入返回空数组', () => {
    expect(summarizeBuildErrors([])).toEqual([]);
  });
});
