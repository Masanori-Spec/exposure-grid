#!/usr/bin/env python3
"""External CLI-only test harness. No Krita Python plugin or imported libkis code.
Compares official exported KRA metadata and rendered PNGs with a handwritten oracle.
"""
from pathlib import Path
import hashlib, json, os, re, struct, subprocess, sys, tempfile, traceback, zipfile, zlib
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts'/'native'
ORACLE=json.loads((ROOT/'fixtures'/'oracle.json').read_text())

def png_rgba(path):
    data=path.read_bytes()
    assert data[:8]==b'\x89PNG\r\n\x1a\n', 'PNG signature'
    pos=8; payload=b''; header=None
    while pos<len(data):
        size=struct.unpack('>I',data[pos:pos+4])[0]; kind=data[pos+4:pos+8]; value=data[pos+8:pos+8+size]
        assert zlib.crc32(kind+value)&0xffffffff==struct.unpack('>I',data[pos+8+size:pos+12+size])[0], 'PNG checksum'
        if kind==b'IHDR': header=struct.unpack('>IIBBBBB',value)
        if kind==b'IDAT': payload+=value
        pos+=size+12
        if kind==b'IEND': break
    w,h,depth,color,compress,filter_method,interlace=header
    assert (w,h)==(16,16) and depth==8 and color in (2,6) and interlace==0, header
    bpp=3 if color==2 else 4; stride=w*bpp; raw=zlib.decompress(payload)
    assert len(raw)==h*(stride+1), 'PNG decoded length'
    previous=bytearray(stride); out=bytearray()
    def paeth(a,b,c):
        p=a+b-c; pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
        return a if pa<=pb and pa<=pc else b if pb<=pc else c
    for y in range(h):
        flag=raw[y*(stride+1)]; scan=bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
        for x in range(stride):
            left=scan[x-bpp] if x>=bpp else 0; up=previous[x]; ul=previous[x-bpp] if x>=bpp else 0
            assert flag in range(5), flag
            predictor=[0,left,up,(left+up)//2,paeth(left,up,ul)][flag]
            scan[x]=(scan[x]+predictor)&255
        if bpp==4: out+=scan
        else:
            for x in range(0,stride,3):out+=scan[x:x+3]+b'\xff'
        previous=scan
    return bytes(out)

def pixel(symbol,x,y):
    spec=ORACLE['pixels'][symbol]; x0,y0,x1,y1=spec['rect']
    return tuple(spec['rgba']) if x0<=x<x1 and y0<=y<y1 else (0,0,0,0)

def expected_frame(spec,frame):
    symbols=[next(symbol for start,end,symbol in layer['spans'] if start<=frame<end) for layer in spec['layers']]
    result=bytearray()
    for y in range(16):
        for x in range(16):
            rgba=(0,0,0,0)
            for symbol in reversed(symbols):
                top=pixel(symbol,x,y)
                if top[3]:rgba=top
            result+=bytes(rgba)
    return bytes(result)

def command(executable,args,log):
    with log.open('wb') as output:
        result=subprocess.run([executable,'--nosplash',*args],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,timeout=180)
    assert result.returncode==0, f'Krita CLI exit {result.returncode}; see {log.name}'

def xml_root(data):
    root=ET.fromstring(data)
    for node in root.iter():node.tag=node.tag.rsplit('}',1)[-1]
    return root

def inspect_kra(path,spec):
    with zipfile.ZipFile(path) as archive:
        main=archive.read('maindoc.xml'); (path.parent/(path.stem+'-maindoc.xml')).write_bytes(main)
        root=xml_root(main)
        image=root.find('IMAGE')
        assert image is not None, 'KRA IMAGE element'
        assert int(image.get('width'))==16 and int(image.get('height'))==16
        layers=image.findall('./layers/layer')
        assert [l.get('name') for l in layers]==[l['name'] for l in spec['layers']], ('Layer order', [l.attrib for l in layers])
        assert all(l.get('nodetype')=='paintlayer' and l.get('opacity')=='255' and l.get('visible')=='1' and l.get('compositeop')=='normal' for l in layers), [l.attrib for l in layers]
        animation=image.find('animation'); assert animation is not None
        assert int(animation.find('framerate').get('value'))==spec['fps']
        span=animation.find('range'); assert span is not None
        assert int(span.get('from'))==0 and int(span.get('to'))==spec['frames']-1, span.attrib
        keys={}
        for layer,expected in zip(layers,spec['layers']):
            suffix='/'+layer.get('keyframes')
            members=[n for n in archive.namelist() if n.endswith(suffix)]
            assert len(members)==1, (suffix,members)
            xml=archive.read(members[0]); (path.parent/(path.stem+'-'+layer.get('filename')+'-keys.xml')).write_bytes(xml)
            element=xml_root(xml)
            channels=element.findall('channel'); assert len(channels)==1 and channels[0].get('name')=='content'
            actual=[int(k.get('time')) for k in channels[0].findall('keyframe')]
            assert actual==expected['keys'], (layer.get('name'),actual,expected['keys'])
            keys[layer.get('name')]=actual
        return {'fps':spec['fps'],'range':[0,spec['frames']-1],'layerOrder':[l.get('name') for l in layers],'keyframes':keys}

def check_sequence(directory,spec):
    members=list(directory.glob('*.png'))
    by_index={}
    for path in members:
        match=re.search(r'(\d+)\.png$',path.name); assert match, path.name
        index=int(match.group(1)); assert index not in by_index; by_index[index]=path
    assert sorted(by_index)==list(range(spec['frames'])), ('Rendered frame count/index',sorted(by_index))
    mismatches=[]; hashes=[]
    for frame in range(spec['frames']):
        actual=png_rgba(by_index[frame]); expected=expected_frame(spec,frame)
        if actual!=expected:
            points=[{'x':i//4%16,'y':i//4//16,'expected':list(expected[i:i+4]),'actual':list(actual[i:i+4])} for i in range(0,len(actual),4) if actual[i:i+4]!=expected[i:i+4]]
            mismatches.append({'frame':frame,'pixels':points})
        hashes.append({'frame':frame,'rgbaSHA256':hashlib.sha256(actual).hexdigest()})
    return {'checkedFrames':len(by_index),'pixelsPerFrame':256,'mismatches':mismatches,'frameHashes':hashes}

def fresh_outputs(artifact_directory):
    artifact_directory.mkdir(parents=True,exist_ok=True)
    return Path(tempfile.mkdtemp(prefix='native-render-',dir=artifact_directory))

def require_created(path):
    assert path.is_file(), f'No native output was written at fresh path: {path.name}'

def main():
    executable=os.environ['KRITA_BIN']; report={'passed':False,'consumer':'Official Krita CLI','cases':{}}
    try:
        outputs=fresh_outputs(ART)
        report['outputDirectory']=outputs.relative_to(ART).as_posix()
        version=subprocess.run([executable,'--version'],text=True,capture_output=True,timeout=30)
        report['version']=(version.stdout+version.stderr).strip()
        assert version.returncode==0, f'Krita version query failed: {version.returncode}'
        assert re.search(r'\b5\.3\.4\b',report['version']), report['version']
        for name,key in [('source','source'),('retimed24','doubled'),('shifted','doubled')]:
            spec=ORACLE[key]; csv=ART/(name+'.csv'); kra=outputs/(name+'.kra'); sequence=outputs/(name+'-sequence');sequence.mkdir()
            command(executable,['--export','--export-filename',str(kra),str(csv)],outputs/(name+'-import.log'))
            require_created(kra)
            metadata=inspect_kra(kra,ORACLE['shifted'] if name=='shifted' else spec)
            # Reopen the saved native KRA, rather than rendering the CSV directly.
            command(executable,['--export-sequence','--export-filename',str(sequence/'frame.png'),str(kra)],outputs/(name+'-render.log'))
            pixels=check_sequence(sequence,spec); report['cases'][name]={'metadata':metadata,'pixels':pixels}
            if name=='shifted':
                assert [m['frame'] for m in pixels['mismatches']]==ORACLE['negativeControl']['expectedMismatchFrames'], 'Negative control did not fail exactly at shifted frame 12'
                intended=check_sequence(sequence,ORACLE['shifted'])
                report['cases'][name]['intendedShiftedPixels']=intended
                assert not intended['mismatches'], 'Negative control differs from its exact intended shifted pixel planes'
            else: assert not pixels['mismatches'], f'{name}: native projected pixels differ from handwritten oracle'
        preserve=json.loads((ART/'png-preservation.json').read_text()); assert preserve['passed'] and len(preserve['images'])==5
        for record in preserve['images'].values():assert record['source']==record['output']
        report['pngPreservation']=preserve; report['passed']=True
    except Exception:
        report['error']=traceback.format_exc(); raise
    finally:
        (ART/'native-gate-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print('PASS: official Krita 5.3.4 imported source/output, preserved keyframes/layer order/clip FPS, rendered 24+48 full pixel planes, and rejected the shifted-exposure control')

if __name__=='__main__':main()
