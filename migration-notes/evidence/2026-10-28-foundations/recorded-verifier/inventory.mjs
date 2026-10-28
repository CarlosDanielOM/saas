import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root='/source/dimabot';
const ts=createRequire(path.join(root,'package.json'))('typescript');
const files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.tsx?$/.test(p))files.push(p);}}
walk(path.join(root,'src'));
const output={schemaVersion:1,baselineDate:'2026-10-28',baselineCommit:process.env.MIGRATION_BASELINE_COMMIT,scope:'All dimabot TypeScript source and tests; presence of a Rust filename is not evidence of feature or dependency completeness.',files:{}};
for(const file of files.sort()){
 const source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),imports=new Set(),exports=[];
 function visit(node){
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.add(node.moduleSpecifier.text);
  if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(tree)==='require'))imports.add(node.arguments[0].text);
  if(node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
   if(node.name?.text)exports.push(node.name.text);
   if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)exports.push(d.name.getText(tree));
  }
  ts.forEachChild(node,visit);
 }
 visit(tree);
 const rel=path.relative(root,file),isTest=/\.(test|spec)\.tsx?$/.test(rel);
 output.files[rel]={sha256:createHash('sha256').update(source).digest('hex'),lines:source.split('\n').length-(source.endsWith('\n')?1:0),role:isTest?'test':rel.startsWith('src/utils/email/templates/')?'react-email-template':'application',imports:[...imports].sort(),exports:[...new Set(exports)].sort()};
}
output.counts={total:files.length,application:Object.values(output.files).filter(x=>x.role==='application').length,tests:Object.values(output.files).filter(x=>x.role==='test').length,reactEmailTemplates:Object.values(output.files).filter(x=>x.role==='react-email-template').length,lines:Object.values(output.files).reduce((s,x)=>s+x.lines,0)};
console.log(JSON.stringify(output,null,2));
