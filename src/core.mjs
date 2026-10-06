/** Original ExposureGrid source. No project-wide open-source license selected. */
export class ProfileError extends Error { constructor(code, message) { super(message); this.name = 'ProfileError'; this.code = code; } }
const fail = (code, message) => { throw new ProfileError(code, message); };
export const LIMITS = Object.freeze({frames: 100000, layers: 64, dimension: 16384, csvBytes: 16*1024*1024, files: 4096, fileBytes: 32*1024*1024, totalBytes: 128*1024*1024, decodedImageBytes: 64*1024*1024, totalDecodedBytes: 256*1024*1024});
const HEADERS = ['Project Name','Width','Height','Frame Count','Layer Count','Frame Rate','Pixel Aspect Ratio','Field Mode'];
export const safeBasename = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/.test(name) && !name.includes('..') && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export function parseCSV(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > LIMITS.csvBytes) fail('CSV_SIZE','CSV exceeds the supported size');
  text = text.replace(/^\uFEFF/,'');
  if (text.includes('\0')) fail('CSV_SYNTAX','NUL is not allowed');
  const lines = text.replace(/\r\n/g,'\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    if (!line || line.includes('\r')) fail('CSV_SYNTAX',`Invalid line ${index+1}`);
    const fields = []; let p=0;
    while (true) {
      while (line[p] === ' ' || line[p] === '\t') p++;
      let field='';
      if (line[p] === '"') {
        p++; let closed=false;
        while (p<line.length) { if (line[p] === '"') { if (line[p+1] === '"') { field+='"'; p+=2; } else { p++; closed=true; break; } } else field+=line[p++]; }
        if (!closed) fail('CSV_SYNTAX',`Unclosed quote on line ${index+1}`);
        while (line[p] === ' ' || line[p] === '\t') p++;
        if (p<line.length && line[p]!==',') fail('CSV_SYNTAX',`Unexpected character on line ${index+1}`);
      } else { while (p<line.length && line[p]!==',') field+=line[p++]; field=field.trim(); if (field.includes('"')) fail('CSV_SYNTAX',`Unexpected quote on line ${index+1}`); }
      fields.push(field);
      if (p>=line.length) break;
      p++; if (p===line.length) { fields.push(''); break; }
    }
    return fields;
  });
}
function integer(value, label, max) { if (!/^\d+(?:\.0+)?$/.test(String(value))) fail('INTEGER',`${label} must be a whole number`); const number=Number(value); if (!Number.isSafeInteger(number)||number<1||number>max) fail('RANGE',`${label} must be 1–${max}`); return number; }
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
function textField(value,label) { if (!value || value.length>120 || /[\x00-\x1f\x7f]/.test(value)) fail('TEXT',`Invalid ${label}`); return value; }
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function validatePNG(bytes,width,height) {
  if (!(bytes instanceof Uint8Array) || bytes.length<45 || bytes.length>LIMITS.fileBytes) fail('PNG','Invalid PNG size');
  const signature=[137,80,78,71,13,10,26,10];
  if (!signature.every((b,i)=>b===bytes[i])) fail('PNG','Only PNG images are supported');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (view.getUint32(8)!==13 || String.fromCharCode(...bytes.slice(12,16))!=='IHDR' || view.getUint32(16)!==width || view.getUint32(20)!==height || bytes[24]!==8 || ![2,6].includes(bytes[25]) || bytes[26]!==0 || bytes[27]!==0 || bytes[28]!==0) fail('PNG_PROFILE','PNG must match canvas dimensions and be non-interlaced 8-bit RGB/RGBA');
  let p=8, idat=false, ended=false;
  while (p+12<=bytes.length) { const len=view.getUint32(p); if(len>bytes.length-p-12) fail('PNG','Truncated PNG'); const type=String.fromCharCode(...bytes.slice(p+4,p+8));
    if(crc32(bytes.subarray(p+4,p+8+len))!==view.getUint32(p+8+len)) fail('PNG','PNG chunk checksum does not match');
    if(p!==8&&type==='IHDR') fail('PNG','Duplicate PNG header');
    if(!['IHDR','PLTE','IDAT','IEND'].includes(type)&&/^[A-Z]/.test(type)) fail('PNG_PROFILE','Unknown critical PNG chunk');
    if(['acTL','fcTL','fdAT'].includes(type)) fail('PNG_PROFILE','Animated PNG is unsupported');
    if (type==='IDAT') idat=true;
    p+=len+12;
    if (type==='IEND') { if(len!==0||p!==bytes.length) fail('PNG','Invalid PNG ending'); ended=true; break; }
  }
  if(!idat||!ended) fail('PNG','Incomplete PNG');
}
/** Bounded zlib/scanline validation before any export; no raster re-encoding. */
export async function validateImageDecoding(project) {
  let total=0;
  for(const [name,bytes] of project.images) {
    validatePNG(bytes,project.width,project.height);
    const stride=project.width*(bytes[25]===6?4:3)+1, expected=stride*project.height;
    total+=expected;
    if(expected>LIMITS.decodedImageBytes||total>LIMITS.totalDecodedBytes) fail('DECODE_LIMIT','Decoded PNG size exceeds supported limits');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const chunks=[];
    for(let p=8;p+12<=bytes.length;) {const size=view.getUint32(p);if(String.fromCharCode(...bytes.slice(p+4,p+8))==='IDAT')chunks.push(bytes.subarray(p+8,p+8+size));p+=size+12;}
    let reader,count=0;
    try {
      reader=new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        if(count+value.length>expected) {await reader.cancel();fail('PNG_DECODE',`PNG expands beyond its declared dimensions: ${name}`);}
        for(let offset=(stride-count%stride)%stride;offset<value.length;offset+=stride)if(value[offset]>4) {await reader.cancel();fail('PNG_DECODE',`Invalid PNG scanline filter: ${name}`);}
        count+=value.length;
      }
      if(count!==expected)fail('PNG_DECODE',`PNG scanline length does not match dimensions: ${name}`);
    } catch(error) {
      if(error instanceof ProfileError)throw error;
      fail('PNG_DECODE',`PNG image data cannot be decoded: ${name}`);
    } finally {if(reader)reader.releaseLock();}
  }
  return true;
}

/** Structural preflight; exportEntries additionally performs bounded IDAT decoding. */
export function loadProject(entries) {
  if(!Array.isArray(entries)||entries.length<2||entries.length>LIMITS.files) fail('FILES','Unsupported file count');
  const folded=new Set(); const files=new Map(); let total=0;
  for(const entry of entries) {
    const {name,data}=entry;
    if(typeof name!=='string'||name.includes('\\')||name.startsWith('/')||name.includes(':')||name.split('/').some(x=>!safeBasename(x))) fail('PATH','Only safe relative basenames and one matching .frames directory are supported');
    const lower=name.toLowerCase(); if(folded.has(lower)) fail('DUPLICATE','Duplicate or case-ambiguous filenames'); folded.add(lower);
    if(!(data instanceof Uint8Array)||data.length>LIMITS.fileBytes) fail('FILE_SIZE','Unsupported file size'); total+=data.length; if(total>LIMITS.totalBytes) fail('TOTAL_SIZE','Package is too large'); files.set(name,data);
  }
  const csvNames=[...files.keys()].filter(x=>!x.includes('/')&&x.endsWith('.csv'));
  if(csvNames.length!==1) fail('CSV_COUNT','Exactly one root .csv file is required');
  const csvName=csvNames[0], base=csvName.slice(0,-4); if(!safeBasename(base)) fail('PATH','Unsafe CSV basename');
  let text; try { text=new TextDecoder('utf-8',{fatal:true}).decode(files.get(csvName)); } catch { fail('ENCODING','CSV must be valid UTF-8'); }
  const rows=parseCSV(text);
  if(rows.length<8||!same(rows[0],['UTF-8','TVPaint','CSV 1.0'])||!same(rows[1],HEADERS)||rows[2].length!==8) fail('PROFILE','Only the strict CSV 1.0 exported scene profile is supported');
  const s=rows[2]; const project={name:textField(s[0],'project name'),width:integer(s[1],'Width',LIMITS.dimension),height:integer(s[2],'Height',LIMITS.dimension),frameCount:integer(s[3],'Frame count',LIMITS.frames),layerCount:integer(s[4],'Layer count',LIMITS.layers),fps:integer(s[5],'Frame rate',120),base,csvName};
  if(!/^1(?:\.0+)?$/.test(s[6])||s[7]!=='Progressive') fail('PROFILE','Only square pixels and progressive field mode are supported');
  const expected=['#Layers','#Density','#Blending','#Visible'];
  for(let i=0;i<4;i++) if(rows[i+3]?.[0]!==expected[i]||rows[i+3].length!==project.layerCount+1) fail('LAYER_HEADERS','Missing, unknown, or inconsistent layer metadata');
  project.layers=rows[3].slice(1).map((name,i)=>({name:textField(name,'layer name'),exposures:[]}));
  if(new Set(project.layers.map(x=>x.name)).size!==project.layers.length) fail('LAYER_NAMES','Layer names must be distinct');
  if(rows[4].slice(1).some(x=>!/^1(?:\.0+)?$/.test(x))||rows[5].slice(1).some(x=>x!=='Color')||rows[6].slice(1).some(x=>x!=='1')) fail('LAYER_PROFILE','Only visible, fully opaque, normal-blend layers are supported');
  const frames=rows.slice(7);
  if(frames.length!==project.frameCount) fail('FRAME_COUNT','Declared frame count does not match exposure rows');
  const used=new Set();
  for(let f=0;f<frames.length;f++) {
    const row=frames[f]; if(!/^#\d+$/.test(row[0])||Number(row[0].slice(1))!==f||row.length!==project.layerCount+1) fail('FRAME_ROWS','Frame rows must start at zero, be contiguous, and match layer count');
    for(let l=0;l<project.layerCount;l++) { const image=row[l+1]; if(image&&(!safeBasename(image)||!image.endsWith('.png'))) fail('IMAGE_REF','PNG references must be exact safe basenames');
      if(image) { const path=`${base}.frames/${image}`; if(!files.has(path)) fail('MISSING_IMAGE',`Missing exact image: ${image}`); used.add(path); }
      const exposures=project.layers[l].exposures; if(!exposures.length||exposures.at(-1).image!==image) exposures.push({start:f,end:f+1,image}); else exposures.at(-1).end=f+1;
    }
  }
  if(project.layers.some(l=>l.exposures.every(x=>!x.image))) fail('EMPTY_LAYER','Entirely blank layers are unsupported because Krita drops them');
  for(const [name,data] of files) { if(name===csvName) continue; if(!used.has(name)) fail('EXTRA_FILE','Unexpected or unused file in package'); validatePNG(data,project.width,project.height); }
  project.images=new Map([...used].map(name=>[name.slice(base.length+8),files.get(name)]));
  return project;
}
const gcd=(a,b)=>b?gcd(b,a%b):Math.abs(a);
export function rational(n,d) { const g=gcd(n,d)||1; return {numerator:n/g,denominator:d/g}; }
export function mapBoundary(k,sourceFPS,targetFPS) { return Math.floor((2*k*targetFPS+sourceFPS)/(2*sourceFPS)); }
export function retimeProject(project,target,mode='exact') {
  const targetFPS=integer(target,'Target frame rate',120);
  if(!['exact','rounded'].includes(mode)) fail('MODE','Choose exact or rounded mode');
  const end=mapBoundary(project.frameCount,project.fps,targetFPS); if(end<1||end>LIMITS.frames) fail('TARGET_LENGTH','Unsupported target frame count');
  const boundary=k=>({sourceFrame:k,targetFrame:mapBoundary(k,project.fps,targetFPS),errorSeconds:rational(mapBoundary(k,project.fps,targetFPS)*project.fps-k*targetFPS,project.fps*targetFPS)});
  const boundaries=[...new Set([0,project.frameCount,...project.layers.flatMap(x=>x.exposures.map(e=>e.start))])].sort((a,b)=>a-b).map(boundary);
  if(mode==='exact'&&boundaries.some(b=>b.errorSeconds.numerator!==0)) fail('NOT_EXACT','An exposure boundary or clip end falls between target frames; choose rounded mode to review drift');
  const layers=project.layers.map(layer=>({name:layer.name,exposures:layer.exposures.map(e=>{const start=mapBoundary(e.start,project.fps,targetFPS),finish=mapBoundary(e.end,project.fps,targetFPS); if(finish<=start) fail('COLLAPSED_EXPOSURE',`An exposure in ${layer.name} would disappear; conversion is blocked`); return {start,end:finish,image:e.image};})}));
  return {...project,fps:targetFPS,frameCount:end,layers,receipt:{schema:'exposure-grid-review/v1',mode,sourceFPS:project.fps,targetFPS,sourceFrames:project.frameCount,targetFrames:end,sourceDurationSeconds:rational(project.frameCount,project.fps),targetDurationSeconds:rational(end,targetFPS),durationErrorSeconds:rational(end*project.fps-project.frameCount*targetFPS,project.fps*targetFPS),boundaries,layers:layers.map((x,i)=>({name:x.name,exposures:x.exposures.map((e,j)=>({...e,sourceStart:project.layers[i].exposures[j].start,sourceEnd:project.layers[i].exposures[j].end}))})),images:'Copied byte-for-byte after bounded validation; no re-encoding'}};
}
const quote = value => `"${String(value).replaceAll('"','""')}"`;
function headerRows(project) {
  return [['UTF-8','TVPaint','CSV 1.0'],HEADERS,[project.name,project.width,project.height,project.frameCount,project.layerCount,project.fps.toFixed(6),'1.000000','Progressive'],['#Layers',...project.layers.map(l=>l.name)],['#Density',...project.layers.map(()=> '1.000000')],['#Blending',...project.layers.map(()=> 'Color')],['#Visible',...project.layers.map(()=> '1')]];
}
export function estimateCSVBytes(project) {
  let size=new TextEncoder().encode(headerRows(project).map(row=>row.map(quote).join(', ')).join('\r\n')+'\r\n').length;
  // Supported frame indices are 0..99999, serialized with five digits.
  size+=project.frameCount*(8+2+2*project.layerCount);
  for(const layer of project.layers)for(const exposure of layer.exposures)size+=(exposure.end-exposure.start)*(exposure.image.length+2);
  return size;
}
export function serializeProject(project) {
  if(estimateCSVBytes(project)>LIMITS.csvBytes)fail('CSV_SIZE','The converted CSV would exceed the 16 MiB limit');
  const rows=headerRows(project);
  const cursors=project.layers.map(()=>0);
  for(let f=0;f<project.frameCount;f++) rows.push([`#${String(f).padStart(5,'0')}`,...project.layers.map((layer,i)=>{ while(layer.exposures[cursors[i]].end<=f) cursors[i]++; return layer.exposures[cursors[i]].image; })]);
  return rows.map(row=>row.map(quote).join(', ')).join('\r\n')+'\r\n';
}
function boundedJSON(value,maxBytes) {
  function* fragments(value,level=0) {
    if(level>32)fail('RECEIPT','Review receipt nesting is unsupported');
    if(value===null||typeof value!=='object') {yield JSON.stringify(value)??'null';return;}
    const array=Array.isArray(value), keys=array?value.map((_,i)=>i):Object.keys(value).filter(key=>value[key]!==undefined);
    yield array?'[':'{';
    for(let i=0;i<keys.length;i++) {yield (i?',\n':'\n')+'  '.repeat(level+1);if(!array)yield JSON.stringify(keys[i])+': ';yield* fragments(value[keys[i]],level+1);}
    if(keys.length)yield '\n'+'  '.repeat(level);yield array?']':'}';
  }
  let pending='',size=0;const parts=[],encoder=new TextEncoder();
  const flush=()=>{if(!pending)return;const bytes=encoder.encode(pending);size+=bytes.length;if(size>maxBytes)fail('RECEIPT_SIZE','Review receipt exceeds the supported file limit');parts.push(bytes);pending='';};
  for(const fragment of fragments(value)) {pending+=fragment;if(pending.length>=8192)flush();}pending+='\n';flush();
  const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
export async function exportEntries(project,base) {
  if(!safeBasename(base)||![`${base}.csv`,`${base}.frames`,`${base}.review.json`].every(safeBasename)) fail('PATH','Choose a safe output basename of at most 108 characters');
  // Capture review state and every byte synchronously before asynchronous decoding.
  const snapshot=structuredClone(project);
  const csvSize=estimateCSVBytes(snapshot);
  if(csvSize>LIMITS.csvBytes)fail('CSV_SIZE','The converted CSV would exceed the 16 MiB limit');
  const receipt=boundedJSON(snapshot.receipt,LIMITS.fileBytes);
  const total=csvSize+receipt.length+[...snapshot.images.values()].reduce((sum,data)=>sum+data.length,0);
  if(total>LIMITS.totalBytes)fail('TOTAL_SIZE','The converted package exceeds the 128 MiB limit');
  await validateImageDecoding(snapshot);
  const csv=new TextEncoder().encode(serializeProject(snapshot));
  if(csv.length!==csvSize)fail('CSV_SIZE','Converted CSV size could not be established safely');
  return [{name:`${base}.csv`,data:csv},...[...snapshot.images].map(([name,data])=>({name:`${base}.frames/${name}`,data})),{name:`${base}.review.json`,data:receipt}];
}
