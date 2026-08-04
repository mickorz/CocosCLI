import { describe, it, expect } from 'vitest';
import { normalizePlatform, generateBuildConfig } from '../../utils/build.js';

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
