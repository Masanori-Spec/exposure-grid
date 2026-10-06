import {readFile,writeFile,mkdir,readdir,lstat,mkdtemp,rename,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {loadProject,retimeProject,exportEntries,validateImageDecoding} from '../src/core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=join(root,'artifacts/native');
const oracle=JSON.parse(await readFile(join(root,'fixtures/oracle.json'),'utf8'));
const pngHashes=JSON.parse(await readFile(join(root,'fixtures/png-sha256.json'),'utf8'));
const imageNames=Object.keys(pngHashes).sort();
const outputNames=['retimed24','rounded30'];
const browserRequested=Object.hasOwn(process.env,'EXPOSURE_BROWSER_EXPORT_DIR');
const sha256=data=>createHash('sha256').update(data).digest('hex');
const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
const same=(actual,expected,label)=>ensure(isDeepStrictEqual(actual,expected),`Unexpected ${label}`);

// Only regular files/directories from the extraction wrapper are accepted. Nothing
// in the handoff is executed, unpacked, reserialized, or silently regenerated.
async function regular(path,directory=false) {
  const info=await lstat(path);
  ensure(!info.isSymbolicLink()&&(directory?info.isDirectory():info.isFile()),`Not a regular ${directory?'directory':'file'}: ${path}`);
  if(!directory)ensure(info.size<=32*1024*1024,`Oversized gate input: ${path}`);
}
async function readPackage(directory,base,receipt) {
  await regular(directory,true);
  const frameDirectory=join(directory,`${base}.frames`);
  await regular(frameDirectory,true);
  same((await readdir(frameDirectory)).sort(),imageNames,`${base} PNG file set`);
  const names=[`${base}.csv`,...imageNames.map(name=>`${base}.frames/${name}`),...(receipt?[`${base}.review.json`]:[])];
  const entries=[];
  for(const name of names) {const path=join(directory,name);await regular(path);entries.push({name,data:new Uint8Array(await readFile(path))});}
  return entries;
}
function checkTimeline(project,spec,label) {
  same([project.width,project.height,project.fps,project.frameCount],[16,16,spec.fps,spec.frames],`${label} canvas/FPS/length`);
  same(project.layers,spec.layers.map(layer=>({name:layer.name,exposures:layer.spans.map(([start,end,symbol])=>({start,end,image:symbol==='blank'?'':`${symbol}.png`}))})),`${label} layer order/exposures`);
  same([...project.images.keys()].sort(),imageNames,`${label} image names`);
  for(const [name,data] of project.images)ensure(sha256(data)===pngHashes[name],`${label} changed original PNG bytes: ${name}`);
}
function checkReceipt(receipt,base) {
  const expected=oracle.reviews[base], source=oracle[expected.source], target=oracle[expected.target];
  same(receipt.schema,'exposure-grid-review/v1',`${base} receipt schema`);
  for(const [key,value] of Object.entries({mode:expected.mode,sourceFPS:source.fps,targetFPS:target.fps,sourceFrames:source.frames,targetFrames:target.frames,sourceDurationSeconds:expected.sourceDurationSeconds,targetDurationSeconds:expected.targetDurationSeconds,durationErrorSeconds:expected.durationErrorSeconds,boundaries:expected.boundaries}))same(receipt[key],value,`${base} receipt ${key}`);
  const layers=target.layers.map((layer,index)=>({name:layer.name,exposures:layer.spans.map(([start,end,symbol],i)=>({start,end,image:symbol==='blank'?'':`${symbol}.png`,sourceStart:source.layers[index].spans[i][0],sourceEnd:source.layers[index].spans[i][1]}))}));
  same(receipt.layers,layers,`${base} receipt layer exposure trace`);
}
async function checkPackage(entries,base,spec,receipt=false) {
  const project=loadProject(entries.filter(entry=>!entry.name.endsWith('.review.json')));
  checkTimeline(project,spec,base);
  await validateImageDecoding(project);
  if(receipt)checkReceipt(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entries.find(entry=>entry.name===`${base}.review.json`).data)),base);
  return project;
}

await mkdir(artifacts,{recursive:true});
// A failed attempt invalidates the previous pointer, even when old artifacts exist.
await rm(join(artifacts,'prepared.json'),{force:true});
const inputDirectory=await mkdtemp(join(artifacts,'native-input-'));
const manifest={schema:'exposure-grid-native-input/v2',inputDirectory:relative(artifacts,inputDirectory),inputSource:browserRequested?'browser-downloads':'generated-core',sourceFrames:24,targetFrames:48,roundedSourceFrames:6,roundedTargetFrames:8,pngCount:5,negativeControl:'shifted.csv',packages:{}};
async function save(entries,base,provenance) {
  const files={};
  for(const {name,data} of entries) {
    const path=join(inputDirectory,name);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,data);
    const copied=await readFile(path);
    ensure(sha256(copied)===sha256(data),`Native input copy changed bytes: ${name}`);
    files[name]={sha256:sha256(data),bytes:data.length};
  }
  manifest.packages[base]={provenance,files};
}

const sourceEntries=await readPackage(join(root,'fixtures'),'source',false);
const roundedEntries=await readPackage(join(root,'fixtures'),'rounded-source',false);
const source=await checkPackage(sourceEntries,'source',oracle.source);
const roundedSource=await checkPackage(roundedEntries,'rounded-source',oracle.roundedSource);
await save(sourceEntries,'source','controlled-fixture');
await save(roundedEntries,'rounded-source','controlled-fixture');
if(browserRequested) {
  ensure(process.env.EXPOSURE_BROWSER_EXPORT_DIR.trim().length>0,'EXPOSURE_BROWSER_EXPORT_DIR cannot be empty');
  const browserDirectory=resolve(process.env.EXPOSURE_BROWSER_EXPORT_DIR);
  await regular(browserDirectory,true);
  const resolved=await realpath(browserDirectory),relativeInput=relative(await realpath(artifacts),resolved);
  ensure(relativeInput==='..'||relativeInput.startsWith(`..${sep}`),'Browser handoff directory must be outside artifacts/native');
  same((await readdir(browserDirectory)).sort(),outputNames.flatMap(base=>[`${base}.csv`,`${base}.frames`,`${base}.review.json`]).sort(),'browser handoff root file set');
  for(const base of outputNames) {
    const entries=await readPackage(browserDirectory,base,true);
    await checkPackage(entries,base,oracle[oracle.reviews[base].target],true);
    await save(entries,base,'browser-download');
  }
} else {
  for(const [base,project,fps,mode] of [['retimed24',source,24,'exact'],['rounded30',roundedSource,30,'rounded']]) {
    const entries=await exportEntries(retimeProject(project,fps,mode),base);
    await checkPackage(entries,base,oracle[oracle.reviews[base].target],true);
    await save(entries,base,'generated-core');
  }
}
// Deliberately shifted control remains generated from the controlled source. It
// has no review receipt because its intentional shift is outside the conversion.
const shifted=retimeProject(source,24);
shifted.layers[0].exposures[0].end=13;shifted.layers[0].exposures[1].start=13;
const shiftedEntries=(await exportEntries(shifted,'shifted')).filter(entry=>!entry.name.endsWith('.review.json'));
await checkPackage(shiftedEntries,'shifted',oracle.shifted);
await save(shiftedEntries,'shifted','controlled-negative');
const preservation={passed:true,images:Object.fromEntries(imageNames.map(name=>[name,{source:pngHashes[name],output:manifest.packages.retimed24.files[`retimed24.frames/${name}`].sha256,rounded:manifest.packages.rounded30.files[`rounded30.frames/${name}`].sha256}]))};
await writeFile(join(artifacts,'png-preservation.json'),JSON.stringify(preservation,null,2)+'\n');
const pending=join(inputDirectory,'prepared-manifest.json');
await writeFile(pending,JSON.stringify(manifest,null,2)+'\n');
await rename(pending,join(artifacts,'prepared.json'));
console.log(`Prepared 12→24 exact and 24→30 rounded native gates from ${manifest.inputSource}; original PNG hashes, literal timelines/receipts, and shifted control verified`);
