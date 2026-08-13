/**
 * 阶段0 类型环境探查脚本（实验2 / 实验3 / 实验4）
 *
 * 目的：
 *   1. 验证「直接用项目 tsconfig.json」能否 createProgram（路线C + 修正2 简化版）
 *   2. 量化 baseline 下 pfbm(TS2304) / xuanwu(TS2304) / gf(TS2503) 各报多少
 *   3. 注入验证：xuanwu 声明 recovery + pfbm 强类型 bridge + gf declare const
 *      + 故意写错 pfbm.xxx() 看 bridge 能否抓出来（证明补检查而非降噪）
 *
 * TS 版本：实验阶段用 cocoscli 自带 typescript@5.x（后续路线C Loader 换编辑器 TS 复验）
 * 无侵入：不动业务源码，临时文件写 <project>/.cocoscli/probe/ 跑完即删
 *
 * 用法：
 *   npx tsx scripts/probe-type-env.ts <projectPath>           仅 baseline
 *   npx tsx scripts/probe-type-env.ts <projectPath> inject    baseline + 注入验证
 */
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function flat(d: ts.DiagnosticMessageText): string {
  return ts.flattenDiagnosticMessageText(d, '\n');
}

interface Counts {
  pfbm2304: number;
  xuanwu2304: number;
  gf2503: number;
  total: number;
}

function countGlobals(diags: ts.Diagnostic[], projectPath: string): Counts {
  const inScope = diags.filter(d => {
    if (!d.file) return false;
    const rel = norm(path.relative(projectPath, d.file.fileName));
    return !!rel && !rel.startsWith('..');
  });
  const pick = (code: number, exact: string) =>
    inScope.filter(d => d.code === code && flat(d.messageText) === exact).length;
  return {
    pfbm2304: pick(2304, "Cannot find name 'pfbm'."),
    xuanwu2304: pick(2304, "Cannot find name 'xuanwu'."),
    gf2503: pick(2503, "Cannot find namespace 'gf'."),
    total: inScope.length,
  };
}

function printCounts(label: string, c: Counts): void {
  console.log(`[${label}] 工程内诊断总数: ${c.total}`);
  console.log(`  TS2304 pfbm:   ${c.pfbm2304}`);
  console.log(`  TS2304 xuanwu: ${c.xuanwu2304}`);
  console.log(`  TS2503 gf:     ${c.gf2503}`);
}

function parseProjectTsconfig(projectPath: string) {
  const tsconfigPath = path.join(projectPath, 'tsconfig.json');
  const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    throw new Error('读 tsconfig 出错: ' + flat(cfg.error.messageText));
  }
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, projectPath, {}, tsconfigPath);
  return { tsconfigPath, parsed };
}

function main() {
  const projectPath = path.resolve(process.argv[2] ?? '.');
  const doInject = process.argv[3] === 'inject';
  if (!fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
    console.error('[失败] 找不到 tsconfig.json in', projectPath);
    process.exit(1);
  }

  console.log('工程:', projectPath);
  console.log('TS version:', ts.version);
  console.log('----------------------------------------');

  const { tsconfigPath, parsed } = parseProjectTsconfig(projectPath);
  console.log('tsconfig:', norm(tsconfigPath));
  console.log('target:', ts.ScriptTarget[parsed.options.target ?? ts.ScriptTarget.ES2015]);
  console.log('module:', ts.ModuleKind[parsed.options.module ?? ts.ModuleKind.ES2015]);
  console.log('strict:', parsed.options.strict);
  console.log('isolatedModules:', parsed.options.isolatedModules);
  console.log('skipLibCheck:', parsed.options.skipLibCheck);
  console.log('rootNames 数:', parsed.fileNames.length);
  console.log('paths:', JSON.stringify(parsed.options.paths ?? {}));
  console.log('types:', JSON.stringify(parsed.options.types ?? []));
  console.log('----------------------------------------');

  // 实验3：xuanwu 声明位置 + 是否在 rootNames
  const xuanwuDts = path.join(projectPath, 'xuanwu_tools/build-xuanwusdk/contract/AdapterInterface.d.ts');
  const xuanwuExists = fs.existsSync(xuanwuDts);
  const xuanwuInRoot = parsed.fileNames.some(f => norm(f).includes('xuanwu_tools/'));
  console.log('xuanwu AdapterInterface.d.ts 存在:', xuanwuExists, xuanwuExists ? norm(path.relative(projectPath, xuanwuDts)) : '');
  console.log('xuanwu 在 rootNames:', xuanwuInRoot);
  console.log('----------------------------------------');

  // baseline createProgram
  console.log('baseline createProgram（大工程 10-30 秒）...');
  const t0 = Date.now();
  const baseProgram = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  console.log('createProgram 耗时:', ((Date.now() - t0) / 1000).toFixed(1), '秒');
  const baseDiags = [...baseProgram.getSyntacticDiagnostics(), ...baseProgram.getSemanticDiagnostics()];
  const baseCounts = countGlobals(baseDiags, projectPath);
  printCounts('baseline', baseCounts);
  console.log('----------------------------------------');

  if (!doInject) {
    console.log('（仅 baseline。加 inject 参数跑注入验证）');
    return;
  }

  // 实验4：注入验证
  const probeDir = path.join(projectPath, '.cocoscli', 'probe');
  fs.mkdirSync(probeDir, { recursive: true });

  // 临时文件1：runtime-globals.d.ts（pfbm 强类型 bridge + gf declare const 试）
  const globalsFile = path.join(probeDir, 'runtime-globals.d.ts');
  fs.writeFileSync(
    globalsFile,
    [
      '// cocoscli 探查临时文件（自动生成，跑完即删）',
      '// pfbm 强类型 bridge：保留 PrefabManger 整条类型链',
      'declare const pfbm: typeof import("kiwi").pfbm;',
      '',
      '// gf 暂用 declare const 试（可能消不完全，namespace 用法另换 alias）',
      'declare const gf: typeof gameframe;',
      '',
    ].join('\n'),
    'utf-8',
  );

  // 临时文件2：test.ts 故意写错 pfbm.xxx()，验证 bridge 能抓错（而非降噪放行）
  const testFile = path.join(probeDir, 'probe-test.ts');
  fs.writeFileSync(
    testFile,
    [
      '// cocoscli 探查临时文件（自动生成，跑完即删）',
      '// 故意调用 pfbm 上不存在的方法：bridge 若生效应报 TS2339',
      'pfbm.notExistMethodAbc_xyz();',
      '',
    ].join('\n'),
    'utf-8',
  );

  const injectRoots = [
    ...parsed.fileNames,
    norm(xuanwuDts),   // xuanwu declaration recovery
    norm(globalsFile), // runtime globals bridge
    norm(testFile),    // 故意写错
  ];

  console.log('inject createProgram（追加 xuanwu.d.ts + runtime-globals + probe-test）...');
  const t1 = Date.now();
  const injectProgram = ts.createProgram({
    rootNames: injectRoots,
    options: { ...parsed.options, noEmit: true },
  });
  console.log('createProgram 耗时:', ((Date.now() - t1) / 1000).toFixed(1), '秒');
  const injectDiags = [...injectProgram.getSyntacticDiagnostics(), ...injectProgram.getSemanticDiagnostics()];
  const injectCounts = countGlobals(injectDiags, projectPath);
  printCounts('inject', injectCounts);
  console.log('----------------------------------------');

  // bridge 抓错验证：probe-test.ts 的 pfbm.notExistMethodAbc_xyz 是否被报
  const testRel = norm(path.relative(projectPath, testFile));
  const testDiags = injectDiags.filter(d => d.file && norm(d.file.fileName) === norm(testFile));
  console.log('probe-test.ts 诊断（验证 bridge 抓错能力）:');
  if (testDiags.length === 0) {
    console.log('  [警告] 无诊断 — pfbm bridge 可能未解析成功（import("kiwi").pfbm 失败 → pfbm 隐式 any，写错也不报）');
  } else {
    for (const d of testDiags) {
      console.log(`  TS${d.code}: ${flat(d.messageText)}`);
    }
  }
  console.log('----------------------------------------');

  // runtime-globals.d.ts 自身诊断（bridge 是否解析成功）
  const globalsRel = norm(globalsFile);
  const globalsDiags = injectDiags.filter(d => d.file && norm(d.file.fileName) === globalsRel);
  console.log('runtime-globals.d.ts 自身诊断（bridge 解析是否成功）:');
  if (globalsDiags.length === 0) {
    console.log('  [OK] 无诊断 — pfbm/gf bridge 均解析成功');
  } else {
    for (const d of globalsDiags) {
      console.log(`  TS${d.code}: ${flat(d.messageText)}`);
    }
  }
  console.log('----------------------------------------');

  // 清理临时文件
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
    console.log('已清理临时目录:', norm(path.relative(projectPath, probeDir)));
  } catch (e) {
    console.log('[警告] 清理临时目录失败，请手动删:', probeDir);
  }

  // 汇总
  console.log('========================================');
  console.log('汇总');
  console.log('========================================');
  console.log('pfbm   TS2304:', baseCounts.pfbm2304, '→', injectCounts.pfbm2304, baseCounts.pfbm2304 > 0 && injectCounts.pfbm2304 === 0 ? '[已解决]' : '[未解决]');
  console.log('xuanwu TS2304:', baseCounts.xuanwu2304, '→', injectCounts.xuanwu2304, baseCounts.xuanwu2304 > 0 && injectCounts.xuanwu2304 === 0 ? '[已解决]' : '[未解决]');
  console.log('gf     TS2503:', baseCounts.gf2503, '→', injectCounts.gf2503, baseCounts.gf2503 > 0 && injectCounts.gf2503 === 0 ? '[已解决]' : '[未解决/需 alias]');
}

main();
