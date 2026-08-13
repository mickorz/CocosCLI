/**
 * P2.5 第4问：gf alias 注入实验（TS5.9）
 * 测三种 namespaceAlias 全局化写法，看哪种让 gf 诊断 0 + virtual 自身 0 error
 *
 * 用法：npx tsx scripts/probe-gf-alias.ts <projectPath>
 */
import * as ts from 'typescript';
import * as path from 'path';

const projectPath = path.resolve(process.argv[2] ?? '.');
const tsconfigPath = path.join(projectPath, 'tsconfig.json');
const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, projectPath, {}, tsconfigPath);
const programOptions = { ...parsed.options, noEmit: true };
const aliasFile = '__gf_alias__.d.ts';

const flat = (m: any) => ts.flattenDiagnosticMessageText(m, '\n');
const rel = (f: string) => path.relative(projectPath, f).replace(/\\/g, '/');

function countGf(program: any) {
  const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const inScope = (d: any) => { if (!d.file) return false; const r = rel(d.file.fileName); return !!r && !r.startsWith('..'); };
  const gf2304 = diags.filter((d: any) => inScope(d) && d.code === 2304 && flat(d.messageText) === "Cannot find name 'gf'.");
  const gf2503 = diags.filter((d: any) => inScope(d) && d.code === 2503 && /namespace 'gf'/.test(flat(d.messageText)));
  const aliasSelf = diags.filter((d: any) => d.file && rel(d.file.fileName) === aliasFile);
  return { gf2304: gf2304.length, gf2503: gf2503.length, aliasSelf };
}

function runAlias(content: string, label: string) {
  const virtualMap = new Map([[aliasFile, content]]);
  const host = ts.createCompilerHost(programOptions);
  const oGE = host.getSourceFile.bind(host);
  const oFE = host.fileExists.bind(host);
  const oRF = host.readFile.bind(host);
  host.fileExists = (fn: string) => virtualMap.has(fn) || oFE(fn);
  host.readFile = (fn: string) => (virtualMap.has(fn) ? virtualMap.get(fn)! : oRF(fn));
  host.getSourceFile = (fn: any, lv: any, onErr: any, shouldNew: any) => {
    if (virtualMap.has(fn)) return ts.createSourceFile(fn, virtualMap.get(fn)!, lv, true, ts.ScriptKind.TS);
    return oGE(fn, lv, onErr, shouldNew);
  };
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, aliasFile], options: programOptions, host });
  const r = countGf(program);
  console.log(`\n[${label}]`);
  console.log('  content:', JSON.stringify(content));
  console.log('  gf TS2304:', r.gf2304, ' gf TS2503:', r.gf2503, ' aliasSelf:', r.aliasSelf.length);
  r.aliasSelf.slice(0, 3).forEach((d: any) => console.log('    self TS' + d.code + ':', flat(d.messageText)));
}

console.log('TS version:', ts.version);

// baseline
const base = ts.createProgram({ rootNames: parsed.fileNames, options: programOptions });
const baseR = countGf(base);
console.log('baseline: gf TS2304', baseR.gf2304, ' gf TS2503', baseR.gf2503);

// 写法 A：import gf = gameframe（namespace alias，但文件成模块 → gf 不全局）
runAlias('import gf = gameframe;\n', 'A: import gf = gameframe');

// 写法 B：declare global const gf（gf 全局 value，但 namespace 用法可能不工作）
runAlias('export {}; declare global { const gf: typeof gameframe; }\n', 'B: declare global const gf');

// 写法 C：declare namespace gf 重新导出 gameframe（namespace 全局）
runAlias('declare namespace gf { export = gameframe; }\n', 'C: declare namespace gf export=gameframe');

// E: gf alias + 故意写错（验证强类型抓 TS2339，证明恢复检查能力而非消 diagnostic）
{
  const aliasContent = 'import gf = gameframe;\n';
  const testFile = '__gf_test__.ts';
  const testContent = '// 故意写错：gf.sp.NotExistType 类型不存在 / gf.sp.notExistMethod 方法不存在\nconst x: gf.sp.NotExistType = null as any;\ngf.sp.notExistMethodAbc();\n';
  const virtualMap = new Map([[aliasFile, aliasContent], [testFile, testContent]]);
  const host = ts.createCompilerHost(programOptions);
  const oGE = host.getSourceFile.bind(host);
  const oFE = host.fileExists.bind(host);
  const oRF = host.readFile.bind(host);
  host.fileExists = (fn: string) => virtualMap.has(fn) || oFE(fn);
  host.readFile = (fn: string) => (virtualMap.has(fn) ? virtualMap.get(fn)! : oRF(fn));
  host.getSourceFile = (fn: any, lv: any, onErr: any, shouldNew: any) => {
    if (virtualMap.has(fn)) return ts.createSourceFile(fn, virtualMap.get(fn)!, lv, true, ts.ScriptKind.TS);
    return oGE(fn, lv, onErr, shouldNew);
  };
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, aliasFile, testFile], options: programOptions, host });
  const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const testDiags = diags.filter((d: any) => d.file && rel(d.file.fileName) === testFile);
  console.log('\n[E: gf alias + 故意写错] probe-test 诊断（期望 TS2339，证明强类型恢复）:');
  if (testDiags.length === 0) console.log('  [警告] 无诊断，gf.sp 可能被 any 放行');
  testDiags.forEach((d: any) => console.log('  TS' + d.code + ':', flat(d.messageText)));
}
