#!/usr/bin/env python3
"""Independent standard-library ZIPs for real browser deflate compatibility.
No product ZIP writer/parser is imported. Bad streams keep ZIP CRC and all
local/central sizes/offsets consistent, isolating raw-deflate framing checks.
"""
from pathlib import Path
import hashlib,io,json,struct,zipfile,zlib
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/browser/fixtures'
def patch_first_stream(raw,kind):
    data=bytearray(raw)
    eocd=data.rfind(b'PK\x05\x06'); central=struct.unpack_from('<I',data,eocd+16)[0]
    assert data[:4]==b'PK\x03\x04' and data[central:central+4]==b'PK\x01\x02'
    size=struct.unpack_from('<I',data,18)[0]
    n,e=struct.unpack_from('<HH',data,26);start=30+n+e;end=start+size
    if kind=='trailing': insert=b'\x00';delete=0
    elif kind=='concatenated':
        compressor=zlib.compressobj(level=9,wbits=-15);insert=compressor.compress(b'unexpected second stream')+compressor.flush();delete=0
    elif kind=='truncated':insert=b'';delete=1
    else:raise ValueError(kind)
    cut=end-delete;delta=len(insert)-delete
    data[cut:end]=insert
    struct.pack_into('<I',data,18,size+delta)
    new_central=central+delta;new_eocd=eocd+delta
    struct.pack_into('<I',data,new_eocd+16,new_central)
    count=struct.unpack_from('<H',data,new_eocd+10)[0];pos=new_central
    for i in range(count):
        assert data[pos:pos+4]==b'PK\x01\x02'
        if i==0:struct.pack_into('<I',data,pos+20,size+delta)
        offset=struct.unpack_from('<I',data,pos+42)[0]
        if offset>=end:struct.pack_into('<I',data,pos+42,offset+delta)
        names,extra,comment=struct.unpack_from('<HHH',data,pos+28);pos+=46+names+extra+comment
    assert pos==new_eocd
    return bytes(data)
def main():
    OUT.mkdir(parents=True,exist_ok=True)
    inputs={'source.csv':(ROOT/'fixtures/source.csv').read_bytes()}
    inputs.update({'source.frames/'+p.name:p.read_bytes() for p in sorted((ROOT/'fixtures/source.frames').glob('*.png'))})
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name,data in inputs.items():z.writestr(name,data)
    clean=stream.getvalue();results={}
    for kind,data in [('valid',clean),*((kind,patch_first_stream(clean,kind)) for kind in ['trailing','concatenated','truncated'])]:
        filename=f'independent-deflate-{kind}.zip';(OUT/filename).write_bytes(data)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            assert all(i.compress_type==8 for i in z.infolist())
            assert z.namelist()==list(inputs)
            try:ordinary_accepts=all(z.read(name)==payload for name,payload in inputs.items())
            except (zipfile.BadZipFile,zlib.error,EOFError):ordinary_accepts=False
        if kind in ('valid','trailing','concatenated'):assert ordinary_accepts
        results[kind]={'filename':filename,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'expectedBrowserAcceptance':kind=='valid','pythonZipfileReturnsOriginalBytes':ordinary_accepts}
    (OUT/'independent-fixtures.json').write_text(json.dumps({'producer':'Python zipfile and zlib; no product helper','cases':results},indent=2)+'\n')
    print('Created independent deflated source ZIP and CRC-consistent trailing/concatenated/truncated stream controls')
if __name__=='__main__':main()
