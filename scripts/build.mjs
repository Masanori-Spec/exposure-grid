import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
let html=await readFile(path.join(root,'index.html'),'utf8');const css=await readFile(path.join(root,'src/styles.css'),'utf8');
const modules=[];
for(const name of ['core','zip','bundle','samples','app']){
 let source=await readFile(path.join(root,`src/${name}.mjs`),'utf8');
 const names=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map(m=>m[1]);
 source=source.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/([a-z-]+)\.mjs['"];?\s*$/gm,(_,bindings,dep)=>`const {${bindings}}=MODULES[${JSON.stringify(dep)}];`).replace(/^export\s+/gm,'');
 if(/^import\s/m.test(source))throw Error(`Unsupported import in ${name}`);
 modules.push(`MODULES[${JSON.stringify(name)}]=(()=>{\n${source}\nreturn {${names.join(',')}};\n})();`);
}
const code='const MODULES=Object.create(null);\n'+modules.join('\n');
if(/<\/script/i.test(code)||/<\/style/i.test(css))throw Error('Unsafe inline closing tag');
html=html.replace('<link rel="stylesheet" href="src/styles.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="src/app.mjs"></script>',()=>`<script type="module">${code}</script>`);
await mkdir(path.join(root,'dist'),{recursive:true});await writeFile(path.join(root,'dist/exposure-grid.html'),html);
console.log(`Built offline dist/exposure-grid.html (${Buffer.byteLength(html)} bytes; no runtime dependencies)`);
