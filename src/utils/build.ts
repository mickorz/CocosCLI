import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getCocosCreatorPath } from './cocos.js';

// 工程构建流程（cocoscli 内置，不依赖 autobuild 脚本）
//
// buildProject(projectPath, platform)
//        ├─> normalizePlatform()      简称 → Cocos 原生 platform
//        ├─> getCocosCreatorPath()    复用 5 级查找
//        ├─> generateBuildConfig()    生成通用默认 buildConfig（不含 scenes）
//        ├─> 写到 <project>/.cocoscli/buildConfig-<platform>.json
//        └─> spawnSync CocosCreator --project <project> --build configPath=<相对路径>
//
// 实现依据：autoBuild/build_helper.js（mahjong 工程），核心命令为
//   CocosCreator.exe --project <工程> --build "configPath=<buildConfig.json>"

/** 平台简称 → Cocos 原生 platform 映射 */
const PLATFORM_ALIASES: Record<string, string> = {
  web: 'web-desktop',
  'web-desktop': 'web-desktop',
  'web-mobile': 'web-mobile',
  wechat: 'wechatgame',
  wechatgame: 'wechatgame',
  douyin: 'bytedancegame',
  bytedance: 'bytedancegame',
  bytedancegame: 'bytedancegame',
};

/** cocoscli 在工程内放 buildConfig 的目录 */
const COCOSCLI_BUILD_DIR = '.cocoscli';

/** 构建结果 */
export interface BuildResult {
  success: boolean;
  outputDir?: string;
  message: string;
}

/**
 * 规范化平台名：简称 → Cocos 原生 platform
 * 未识别的名称原样返回（交给 CocosCreator 报错）
 */
export function normalizePlatform(input: string): string {
  return PLATFORM_ALIASES[input.toLowerCase()] ?? input;
}

/**
 * 生成通用默认 buildConfig（不含 scenes/startScene 等工程特定字段）
 * CocosCreator 会用默认主场景与默认参数补全
 */
export function generateBuildConfig(platform: string): Record<string, unknown> {
  return {
    platform,
    buildPath: 'project://build',
    debug: false,
    md5Cache: true,
    skipCompressTexture: false,
    sourceMaps: false,
    polyfills: { asyncFunctions: true },
    experimentalEraseModules: false,
    useBuiltinServer: false,
    mainBundleIsRemote: false,
    mainBundleCompressionType: 'merge_dep',
    useSplashScreen: false,
    packAutoAtlas: true,
    outputName: platform,
    packages: {},
  };
}

/**
 * 构建工程到指定平台
 *
 * @param projectPath 工程根目录
 * @param platform 平台（简称或 Cocos 原生名）
 * @returns 构建结果（成功时含产物目录）
 */
export function buildProject(projectPath: string, platform: string): BuildResult {
  const cocosPlatform = normalizePlatform(platform);
  const creatorPath = getCocosCreatorPath();

  // 生成 buildConfig 到 <project>/.cocoscli/
  const configDir = path.join(projectPath, COCOSCLI_BUILD_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  const configRelPath = `${COCOSCLI_BUILD_DIR}/buildConfig-${cocosPlatform}.json`;
  const configAbsPath = path.join(projectPath, configRelPath);
  fs.writeFileSync(
    configAbsPath,
    JSON.stringify(generateBuildConfig(cocosPlatform), null, 2),
    'utf-8'
  );

  // 调 CocosCreator 构建（同步等待，输出直传终端）
  const args = ['--project', projectPath, '--build', `configPath=${configRelPath}`];
  const result = spawnSync(creatorPath, args, { stdio: 'inherit' });

  // 验证产物（CocosCreator 常返回警告级非零码但实际成功，以产物目录为准）
  const outputDir = path.join(projectPath, 'build', cocosPlatform);
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
    return { success: true, outputDir, message: '构建成功' };
  }

  return {
    success: false,
    message: `构建失败（CocosCreator 退出码 ${result.status}），产物目录不存在或为空：${outputDir}`,
  };
}
