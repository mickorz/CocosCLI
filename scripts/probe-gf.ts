/**
 * P2.5 gf 调查：对比 cocoscli TS5.9 下 gf 的 TS2304/TS2503，解释 vs cocos-mcp TS4.6 的 167
 *
 * 用法：npx tsx scripts/probe-gf.ts <projectPath>
 */
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

const projectPath = path.resolve(process.argv[2] ?? '.');
const tsconfigPath = path.join(projectPath, 'tsconfig.json');
const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (cfg.error) { console.error('读 tsconfig 失败'); process.exit(1); }
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, projectPath, {}, tsconfigPath);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
const flat = (m: any) => ts.flattenDiagnosticMessageText(m, '\n');
const rel = (f: string) => path.relative(projectPath, f).replace(/\\/g, '/');
const inScope = (d: any) => { if (!d.file) return false; const r = rel(d.file.fileName); return !!r && !r.startsWith('..'); };

const gf2304 = diags.filter((d: any) => inScope(d) && d.code === 2304 && flat(d.messageText) === "Cannot find name 'gf'.");
const gf2503 = diags.filter((d: any) => inScope(d) && d.code === 2503 && /namespace 'gf'/.test(flat(d.messageText)));

console.log('TS version:', ts.version);
console.log('gf TS2304 (value position "Cannot find name"): ', gf2304.length);
console.log('gf TS2503 (namespace position "Cannot find namespace"): ', gf2503.length);
console.log('gf total (2304+2503): ', gf2304.length + gf2503.length);
console.log('--- 对比 cocos-mcp TS4.6: gf TS2503 = 167（TS2304 未单独统计，混在 real TS2304 里）---');

const byPrefix: Record<string, number> = {};
const readLine = (d: any) => { try { const ls = fs.readFileSync(d.file.fileName, 'utf-8').split(/\r?\n/); const p = d.file.getLineAndCharacterOfPosition(d.start ?? 0); return (ls[p.line] || '').trim(); } catch { return ''; } };
for (const d of gf2503) { const m = readLine(d).match(/gf\.(\w+)/); const p = m ? 'gf.' + m[1] : '(no-gf)'; byPrefix[p] = (byPrefix[p] || 0) + 1; }
console.log('gf2503 byPrefix:', JSON.stringify(byPrefix));
console.log('--- gf2304 samples ---');
gf2304.slice(0, 6).forEach((d: any) => { const p = d.file.getLineAndCharacterOfPosition(d.start ?? 0); console.log(rel(d.file.fileName) + ':' + (p.line + 1) + ' | ' + readLine(d).slice(0, 100)); });
console.log('--- gf2503 samples ---');
gf2503.slice(0, 6).forEach((d: any) => { const p = d.file.getLineAndCharacterOfPosition(d.start ?? 0); console.log(rel(d.file.fileName) + ':' + (p.line + 1) + ' | ' + readLine(d).slice(0, 100)); });
