#!/usr/bin/env python3
"""Independent Python ZIP consumer for the two actual browser downloads.
Extracts only the exact fixture allowlist into a fresh directory. No product ZIP
reader, CSV serializer, converter or export generator is imported here.
"""
from pathlib import Path
import hashlib,json,stat,tempfile,zipfile
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts/browser'
def main():
    destination=Path(tempfile.mkdtemp(prefix='native-handoff-',dir=ART))
    evidence={'extractor':'Python standard-library zipfile','directory':destination.name,'packages':{}}
    for base in ['retimed24','rounded30']:
        source=ART/(base+'.zip');raw=source.read_bytes()
        if len(raw)>1024*1024:raise ValueError('Browser fixture ZIP is unexpectedly large')
        expected={base+'.csv',base+'.review.json',*(base+'.frames/'+name+'.png' for name in ['A','B','C','X','Y'])}
        files={}
        with zipfile.ZipFile(source) as archive:
            names=archive.namelist()
            if len(names)!=len(expected) or set(names)!=expected:raise ValueError('Unexpected browser export file set')
            for info in archive.infolist():
                mode=(info.external_attr>>16)&0xffff
                if info.flag_bits&1 or info.is_dir() or stat.S_ISLNK(mode) or info.file_size>1024*1024:raise ValueError('Unsupported browser fixture entry')
            if archive.testzip() is not None:raise ValueError('Browser ZIP CRC failure')
            for info in archive.infolist():
                data=archive.read(info);target=destination/info.filename
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
                files[info.filename]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        evidence['packages'][base]={'zipSHA256':hashlib.sha256(raw).hexdigest(),'zipBytes':len(raw),'files':files}
    (ART/'independent-zip-handoff.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(destination)
if __name__=='__main__':main()
