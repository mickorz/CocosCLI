import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sortVersions,
  validateCreatorPath,
  getCocosCreatorPath,
  pickEditorFiles,
} from '../../utils/cocos.js';

/** 当前平台的 CocosCreator 可执行文件名 */
function exeName(): string {
  return process.platform === 'win32' ? 'CocosCreator.exe' : 'CocosCreator';
}

/** 还原环境变量到原始值 */
function restoreEnv(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

describe('sortVersions', () => {
  it('偏好版 3.7.3 永远排最前（即使版本号更低）', () => {
    expect(sortVersions('3.7.3', '3.8.0')).toBeLessThan(0);
    expect(sortVersions('3.8.0', '3.7.3')).toBeGreaterThan(0);
  });

  it('非偏好版按语义化版本降序', () => {
    expect(sortVersions('3.7.2', '3.6.0')).toBeLessThan(0);
    expect(sortVersions('3.6.0', '3.7.2')).toBeGreaterThan(0);
    expect(sortVersions('3.8.0', '3.7.2')).toBeLessThan(0);
  });

  it('整组排序：3.7.3 最前，其余降序', () => {
    const list = ['3.6.0', '3.8.0', '3.7.3', '3.7.2'];
    const sorted = [...list].sort(sortVersions);
    expect(sorted).toEqual(['3.7.3', '3.8.0', '3.7.2', '3.6.0']);
  });
});

describe('validateCreatorPath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-val-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('直接 exe 路径存在则原样返回', () => {
    const exe = path.join(tmp, exeName());
    fs.writeFileSync(exe, '');
    expect(validateCreatorPath(exe)).toBe(exe);
  });

  it('版本根目录：拼出 exe 路径返回', () => {
    const versionDir = path.join(tmp, '3.7.3');
    fs.mkdirSync(versionDir);
    const exe = path.join(versionDir, exeName());
    fs.writeFileSync(exe, '');
    expect(validateCreatorPath(versionDir)).toBe(exe);
  });

  it('editors 父目录：扫描版本子目录，按择优返回', () => {
    const editorsDir = path.join(tmp, 'Creator');
    const v373 = path.join(editorsDir, '3.7.3');
    const v360 = path.join(editorsDir, '3.6.0');
    fs.mkdirSync(v373, { recursive: true });
    fs.mkdirSync(v360, { recursive: true });
    fs.writeFileSync(path.join(v373, exeName()), '');
    fs.writeFileSync(path.join(v360, exeName()), '');
    // 偏好版 3.7.3 应被选中
    expect(validateCreatorPath(editorsDir)).toBe(path.join(v373, exeName()));
  });

  it('不存在的路径返回 null', () => {
    expect(validateCreatorPath(path.join(tmp, 'nope'))).toBeNull();
  });

  it('目录下无 exe 也无版本子目录返回 null', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(validateCreatorPath(empty)).toBeNull();
  });
});

describe('getCocosCreatorPath', () => {
  let tmp: string;
  let origAppData: string | undefined;
  let origXdg: string | undefined;
  let origCocosPath: string | undefined;
  let origCocos: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-cfg-'));
    origAppData = process.env.APPDATA;
    origXdg = process.env.XDG_CONFIG_HOME;
    origCocosPath = process.env.COCOS_CREATOR_PATH;
    origCocos = process.env.COCOS_CREATOR;
    // 用临时目录作为本地配置目录，避免污染真实配置
    process.env.APPDATA = tmp;
    process.env.XDG_CONFIG_HOME = tmp;
  });
  afterEach(() => {
    restoreEnv('APPDATA', origAppData);
    restoreEnv('XDG_CONFIG_HOME', origXdg);
    restoreEnv('COCOS_CREATOR_PATH', origCocosPath);
    restoreEnv('COCOS_CREATOR', origCocos);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('环境变量 COCOS_CREATOR_PATH 命中则返回并回写配置', () => {
    const exe = path.join(tmp, exeName());
    fs.writeFileSync(exe, '');
    process.env.COCOS_CREATOR_PATH = exe;

    const result = getCocosCreatorPath();
    expect(result).toBe(exe);

    // 应触发回写：配置文件存在且记录该路径
    const cfgPath = path.join(tmp, 'cocoscli', 'cocoscli.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.cocosCreatorPath).toBe(exe);
  });
});

describe('pickEditorFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoscli-pick-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('顶层 editor.Creator3D 命中（本机实测结构），Creator 空时回退 Creator3D', () => {
    const exe = path.join(tmp, exeName());
    fs.writeFileSync(exe, '');
    const data = {
      editor: {
        Creator: [],
        Creator3D: [{ file: exe, version: '3.7.3' }],
      },
    };
    expect(pickEditorFiles(data)).toEqual([exe]);
  });

  it('Creator 优先于 Creator3D', () => {
    const exeCreator = path.join(tmp, exeName());
    fs.writeFileSync(exeCreator, '');
    const data = {
      editor: {
        Creator: [{ file: exeCreator, version: '3.8.0' }],
        Creator3D: [{ file: path.join(tmp, 'other'), version: '3.7.3' }],
      },
    };
    expect(pickEditorFiles(data)).toEqual([exeCreator]);
  });

  it('config.editor 结构同样兼容', () => {
    const exe = path.join(tmp, exeName());
    fs.writeFileSync(exe, '');
    const data = {
      config: { editor: { Creator3D: [{ file: exe, version: '3.7.3' }] } },
    };
    expect(pickEditorFiles(data)).toEqual([exe]);
  });

  it('多版本按偏好排序，3.7.3 排前', () => {
    const dir373 = path.join(tmp, '373');
    const dir380 = path.join(tmp, '380');
    fs.mkdirSync(dir373);
    fs.mkdirSync(dir380);
    const exe373 = path.join(dir373, exeName());
    const exe380 = path.join(dir380, exeName());
    fs.writeFileSync(exe373, '');
    fs.writeFileSync(exe380, '');
    const data = {
      editor: {
        Creator3D: [
          { file: exe380, version: '3.8.0' },
          { file: exe373, version: '3.7.3' },
        ],
      },
    };
    expect(pickEditorFiles(data)).toEqual([exe373, exe380]);
  });

  it('无 editor 字段返回空数组', () => {
    expect(pickEditorFiles({})).toEqual([]);
  });
});
