import {loadProject,retimeProject,validateImageDecoding,ProfileError,LIMITS} from './core.mjs';
const reject=message=>{throw new ProfileError('RECEIPT',message);};
const same=(a,b)=>{if(typeof a!==typeof b||a===null||b===null)return a===b;if(typeof a!=='object')return a===b;if(Array.isArray(a)!==Array.isArray(b))return false;if(Array.isArray(a)&&a.length!==b.length)return false;const ak=Object.keys(a),bk=Object.keys(b);if(ak.length!==bk.length)return false;ak.sort();bk.sort();return ak.every((k,i)=>k===bk[i]&&same(a[k],b[k]));};
function validateReceipt(receipt,project) {
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.schema!=='exposure-grid-review/v1')reject('Unsupported review receipt');
  if(!Number.isInteger(receipt.sourceFPS)||receipt.sourceFPS<1||receipt.sourceFPS>120||!Number.isInteger(receipt.sourceFrames)||receipt.sourceFrames<1||receipt.sourceFrames>LIMITS.frames)reject('Invalid source timing in review receipt');
  if(receipt.targetFPS!==project.fps||receipt.targetFrames!==project.frameCount||!Array.isArray(receipt.layers)||receipt.layers.length!==project.layers.length)reject('Review receipt does not match this CSV');
  const layers=receipt.layers.map((layer,i)=>{
    if(!layer||layer.name!==project.layers[i].name||!Array.isArray(layer.exposures)||layer.exposures.length!==project.layers[i].exposures.length)reject('Invalid receipt layer');
    let previous=0;
    const exposures=layer.exposures.map(e=>{
      if(!e||!Number.isInteger(e.sourceStart)||!Number.isInteger(e.sourceEnd)||e.sourceStart!==previous||e.sourceEnd<=e.sourceStart||e.sourceEnd>receipt.sourceFrames||typeof e.image!=='string')reject('Invalid source exposure in review receipt');
      previous=e.sourceEnd;return {start:e.sourceStart,end:e.sourceEnd,image:e.image};
    });
    if(previous!==receipt.sourceFrames)reject('Receipt exposures do not cover the source clip');
    return {name:layer.name,exposures};
  });
  let expected;
  try {expected=retimeProject({...project,fps:receipt.sourceFPS,frameCount:receipt.sourceFrames,layers},receipt.targetFPS,receipt.mode);} catch {reject('Receipt timing cannot reproduce this conversion');}
  if(!same(expected.layers,project.layers)||!same(expected.receipt,receipt))reject('Review receipt contains inconsistent or unsupported data');
}
/** Only a complete, matching v1 receipt may be omitted from project-file validation. */
export async function loadBundle(entries) {
  if(!Array.isArray(entries)||entries.length<2||entries.length>LIMITS.files)throw new ProfileError('FILES','Unsupported bundle file count');
  let total=0;for(const entry of entries){if(typeof entry?.name!=='string'||!(entry.data instanceof Uint8Array)||entry.data.length>LIMITS.fileBytes)throw new ProfileError('FILE_SIZE','Unsupported bundle file');total+=entry.data.length;if(total>LIMITS.totalBytes)throw new ProfileError('TOTAL_SIZE','Bundle exceeds supported package size');}
  const snapshot=structuredClone(entries);
  const csv=snapshot.filter(e=>!e.name.includes('/')&&e.name.endsWith('.csv'));
  const receiptName=csv.length===1?csv[0].name.slice(0,-4)+'.review.json':null;
  const receiptEntries=snapshot.filter(e=>e.name===receiptName);
  if(receiptEntries.length>1)reject('Duplicate review receipt');
  const project=loadProject(snapshot.filter(e=>e.name!==receiptName));
  if(receiptEntries.length) {
    let receipt;
    try {receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receiptEntries[0].data));} catch {reject('Review receipt must be valid UTF-8 JSON');}
    validateReceipt(receipt,project);
  }
  await validateImageDecoding(project);
  return {project,previousReceipt:receiptEntries.length===1};
}
