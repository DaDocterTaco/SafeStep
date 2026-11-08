import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from './stage1.mjs';

// Run from the project root after the production output has been frozen.
const id=process.argv[2];
assert.match(id??'',/^stage-8-[a-f0-9]{12}$/);
const directory='artifacts/'+id+'/chrome-mv3';
const actual=await fingerprint(directory);
assert.equal(id,'stage-8-'+actual.sha256.slice(0,12));
const manifest=JSON.parse(await readFile(directory+'/manifest.json','utf8'));
assert.match(manifest.version,/^0\.8\./);
assert.equal((await fingerprint('apps/extension/.output/chrome-mv3')).sha256,actual.sha256);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(dir,extension){
  const entries=await readdir(dir,{withFileTypes:true});
  const paths=await Promise.all(entries.map(entry=>{
    if(entry.name.startsWith('.')||['node_modules','dist'].includes(entry.name))return [];
    const item=dir+'/'+entry.name;
    return entry.isDirectory()?files(item,extension):entry.isFile()&&extension.test(entry.name)?[item]:[];
  }));
  return paths.flat().sort();
}
async function digests(list){
  const map={};const total=createHash('sha256');
  for(const name of [...new Set(list)].sort()){
    const bytes=await readFile(name);map[name]=hash(bytes);total.update(name+'\0'+bytes.length+'\0');total.update(bytes);
  }
  return {sha256:total.digest('hex'),files:map};
}
const source=await digests([...await files('apps/extension',/\.(?:ts|tsx|css|html|json)$/),...await files('apps/api/src',/\.ts$/),...await files('packages/contracts',/\.(?:ts|json)$/),
  'apps/api/package.json','apps/api/tsconfig.json','package.json','package-lock.json','tsconfig.base.json',
  ...(Number(manifest.version.split('.')[2])>=6?['scripts/stage8-paid-ledger.mjs']:[])]);
const api=await digests(await files('apps/api/dist',/\.js$/));
const compiledContracts=await digests(await files('packages/contracts/dist',/\.js$/));
const schema='packages/contracts/src/chat-route.ts';
assert(source.files[schema]);
for(const n of actual.names){
  assert(!/\.env|\.pem$|\.p12$/i.test(n));
  assert(!/AIza[\w-]{30,}|ss3_[\w-]{32,}/.test(await readFile(path.join(directory,n),'utf8')));
}
const ev='docs/evidence/'+id;
await mkdir(ev,{recursive:true});
const file=ev+'/reference-'+source.sha256.slice(0,16)+'.json';
const functional=Number(manifest.version.split('.')[2]) >= 2;
const expanded=Number(manifest.version.split('.')[2])>=6;
const ref={role:'builder',stage:8,revision:expanded?'stage8-all-nine-three-sites-3':functional?'stage8-navigation-reputation-first-2':'stage8-chat-first-1',...(expanded?{supplement:'automatic-web-risk-1'}:{}),id,version:manifest.version,directory,
  extensionSHA256:actual.sha256,extensionFiles:actual.names,source,api,compiledContracts,
  router:{schema,schemaSHA256:source.files[schema],endpoint:'/v1/chat/route',schemaVersion:1,
    liveModel:functional?'gemini-3.5-flash-lite':process.env.SAFESTEP_FUNDED_VERIFICATION==='1'?'gemini-3.5-flash-lite':null,
    liveVerification:functional?'Configured model only. See the functional build report for matching genuine requests and their outcomes; this identity carries no live or independent acceptance credit.':process.env.SAFESTEP_FUNDED_VERIFICATION==='1'
      ?'Owner authorized bounded real tests on the separate model-enabled API. Refer to the funded run receipts for the verified operations. The manifest fingerprint alone does not establish live success.'
      :'Deferred by user. Keyless mode and labelled local verification are separate from genuine Gemini routing.'}};
try{
  await writeFile(file,JSON.stringify(ref,null,2)+'\n',{flag:'wx'});
}catch(error){
  if(error.code!=='EEXIST')throw error;assert.deepEqual(JSON.parse(await readFile(file,'utf8')),ref);
}
await writeFile(ev+'/current-reference.json',JSON.stringify({id,path:file,extensionSHA256:actual.sha256,sourceSHA256:source.sha256},null,2)+'\n');
console.log(file,actual.sha256,source.sha256,api.sha256);
