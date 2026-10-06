import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadProject,retimeProject,exportEntries,validateImageDecoding} from '../src/core.mjs';
const entries=[{name:'source.csv',data:new Uint8Array(await readFile('fixtures/source.csv'))}];
for(const name of await readdir('fixtures/source.frames')) entries.push({name:`source.frames/${name}`,data:new Uint8Array(await readFile(`fixtures/source.frames/${name}`))});
const source=loadProject(entries), converted=retimeProject(source,24);
await validateImageDecoding(source);
await mkdir('artifacts/native',{recursive:true});
async function save(entries) { for(const {name,data} of entries) { const path=`artifacts/native/${name}`; await mkdir(path.substring(0,path.lastIndexOf('/')),{recursive:true}); await writeFile(path,data); } }
await save(entries); await save(await exportEntries(converted,'retimed24'));
const expected=JSON.parse(await readFile('fixtures/png-sha256.json','utf8'));
const hashes={};
for(const [name,data] of converted.images) { const hash=createHash('sha256').update(data).digest('hex'); if(hash!==expected[name]) throw new Error(`PNG bytes changed: ${name}`); hashes[name]={source:hash,output:createHash('sha256').update(await readFile(`artifacts/native/retimed24.frames/${name}`)).digest('hex')}; if(hashes[name].source!==hashes[name].output) throw new Error(`Export changed PNG: ${name}`); }
const shifted=structuredClone(converted); shifted.layers[0].exposures[0].end=13; shifted.layers[0].exposures[1].start=13;
await save(await exportEntries(shifted,'shifted'));
await writeFile('artifacts/native/png-preservation.json',JSON.stringify({passed:true,images:hashes},null,2)+'\n');
await writeFile('artifacts/native/prepared.json',JSON.stringify({sourceFrames:24,targetFrames:48,pngCount:5,negativeControl:'shifted.csv'},null,2)+'\n');
console.log('Prepared 12→24 FPS native gate, all original PNG hashes preserved, and shifted negative control');
