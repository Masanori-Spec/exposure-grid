#!/usr/bin/env python3
"""External CLI-only test harness. No Krita Python plugin or imported libkis code.
Compares official exported KRA metadata and rendered PNGs with a handwritten oracle.
"""
from pathlib import Path
import csv, hashlib, io, json, os, re, struct, subprocess, sys, tempfile, traceback, zipfile, zlib
from fractions import Fraction
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

# These checks deliberately use only the handwritten oracle, Python's rational
# arithmetic, and the actual files. No converter module or timing helper is used.
CASE_SPECS={'source':'source','retimed24':'doubled','shifted':'shifted','rounded-source':'roundedSource','rounded30':'rounded'}
IMAGE_NAMES=['A.png','B.png','C.png','X.png','Y.png']

def read_regular(path,limit=32*1024*1024):
    assert not path.is_symlink() and path.is_file(), f'Not a regular input file: {path}'
    assert path.stat().st_size<=limit, f'Oversized input file: {path}'
    return path.read_bytes()

def rational(value,label):
    assert isinstance(value,dict) and set(value)=={'numerator','denominator'}, (label,value)
    n,d=value['numerator'],value['denominator']
    assert type(n) is int and type(d) is int and d>0, (label,value)
    fraction=Fraction(n,d)
    assert (fraction.numerator,fraction.denominator)==(n,d), f'{label}: rational must be reduced with positive denominator'
    return fraction

def inspect_receipt(path,name):
    receipt=json.loads(read_regular(path).decode('utf-8'))
    expected=ORACLE['reviews'][name]; source=ORACLE[expected['source']]; target=ORACLE[expected['target']]
    assert receipt['schema']=='exposure-grid-review/v1'
    for key,value in {'mode':expected['mode'],'sourceFPS':source['fps'],'targetFPS':target['fps'],'sourceFrames':source['frames'],'targetFrames':target['frames']}.items():
        assert receipt[key]==value and type(receipt[key]) is type(value), (name,key,receipt[key],value)
    durations={'sourceDurationSeconds':Fraction(source['frames'],source['fps']),'targetDurationSeconds':Fraction(target['frames'],target['fps']),'durationErrorSeconds':Fraction(target['frames'],target['fps'])-Fraction(source['frames'],source['fps'])}
    for key,value in durations.items():
        assert receipt[key]==expected[key], (name,key,receipt[key],expected[key])
        assert rational(receipt[key],key)==value, (name,key,value)
    assert receipt['boundaries']==expected['boundaries'], (name,'literal boundaries',receipt['boundaries'])
    expected_source_keys=sorted({0,source['frames'],*(start for layer in source['layers'] for start,_,_ in layer['spans'])})
    assert [b['sourceFrame'] for b in receipt['boundaries']]==expected_source_keys
    for boundary in receipt['boundaries']:
        before,after=boundary['sourceFrame'],boundary['targetFrame']
        assert type(before) is int and type(after) is int
        assert rational(boundary['errorSeconds'],'boundary error')==Fraction(after,target['fps'])-Fraction(before,source['fps'])
    assert len(receipt['layers'])==len(target['layers'])
    for actual,old,new in zip(receipt['layers'],source['layers'],target['layers']):
        assert actual['name']==new['name']==old['name']
        assert len(old['spans'])==len(new['spans'])==len(actual['exposures'])
        for exposure,(source_start,source_end,source_symbol),(start,end,symbol) in zip(actual['exposures'],old['spans'],new['spans']):
            assert symbol==source_symbol, 'Drawing or blank changed in handwritten receipt'
            assert exposure=={'start':start,'end':end,'image':'' if symbol=='blank' else symbol+'.png','sourceStart':source_start,'sourceEnd':source_end}, (name,exposure)
            assert all(type(exposure[key]) is int for key in ['start','end','sourceStart','sourceEnd'])
    return {'passed':True,'mode':receipt['mode'],'boundaryCount':len(receipt['boundaries']),'sourceDurationSeconds':receipt['sourceDurationSeconds'],'targetDurationSeconds':receipt['targetDurationSeconds'],'durationErrorSeconds':receipt['durationErrorSeconds'],'receiptSHA256':hashlib.sha256(path.read_bytes()).hexdigest()}

def inspect_csv(path,spec):
    rows=list(csv.reader(io.StringIO(read_regular(path).decode('utf-8-sig')),skipinitialspace=True,strict=True))
    assert rows[0]==['UTF-8','TVPaint','CSV 1.0']
    assert rows[1]==['Project Name','Width','Height','Frame Count','Layer Count','Frame Rate','Pixel Aspect Ratio','Field Mode']
    assert len(rows[2])==8 and rows[2][0]
    settings=rows[2]
    assert [int(settings[i]) for i in range(1,5)]==[16,16,spec['frames'],len(spec['layers'])]
    assert Fraction(settings[5])==spec['fps'] and Fraction(settings[6])==1 and settings[7]=='Progressive'
    assert rows[3]==['#Layers',*[layer['name'] for layer in spec['layers']]]
    assert rows[4][0]=='#Density' and len(rows[4])==len(spec['layers'])+1 and all(Fraction(value)==1 for value in rows[4][1:])
    assert rows[5]==['#Blending',*['Color' for _ in spec['layers']]]
    assert rows[6]==['#Visible',*['1' for _ in spec['layers']]]
    assert len(rows)==7+spec['frames']
    for frame,row in enumerate(rows[7:]):
        assert re.fullmatch(r'#\d+',row[0]) and int(row[0][1:])==frame
        symbols=[next(symbol for start,end,symbol in layer['spans'] if start<=frame<end) for layer in spec['layers']]
        assert row[1:]==['' if symbol=='blank' else symbol+'.png' for symbol in symbols], (path.name,frame,row)
    return {'passed':True,'fps':spec['fps'],'frames':spec['frames'],'layerOrder':[layer['name'] for layer in spec['layers']]}

def expected_files(name):
    return {name+'.csv',*[name+'.frames/'+image for image in IMAGE_NAMES],*([name+'.review.json'] if name in ORACLE['reviews'] else [])}

def verify_prepared_inputs(artifact_directory,browser_directory=None):
    manifest=json.loads(read_regular(artifact_directory/'prepared.json',1024*1024).decode('utf-8'))
    assert manifest['schema']=='exposure-grid-native-input/v2'
    assert re.fullmatch(r'native-input-[A-Za-z0-9_-]+',manifest['inputDirectory']), 'Unsafe native input directory'
    inputs=artifact_directory/manifest['inputDirectory']
    assert not inputs.is_symlink() and inputs.is_dir() and inputs.resolve().parent==artifact_directory.resolve()
    assert set(manifest['packages'])==set(CASE_SPECS), 'Prepared case set differs from gate cases'
    assert manifest['inputSource'] in ['browser-downloads','generated-core']
    if manifest['inputSource']=='browser-downloads':
        assert browser_directory is not None, 'Browser inputs require EXPOSURE_BROWSER_EXPORT_DIR for independent source-byte recheck'
    if browser_directory is not None:
        assert manifest['inputSource']=='browser-downloads', 'Browser gate cannot use generated output packages'
        browser_directory=Path(browser_directory)
        assert not browser_directory.is_symlink() and browser_directory.is_dir()
        assert not browser_directory.resolve().is_relative_to(artifact_directory.resolve()), 'Browser handoff must be outside native artifacts'
        roots={name+extension for name in ORACLE['reviews'] for extension in ['.csv','.frames','.review.json']}
        assert {p.name for p in browser_directory.iterdir()}==roots, 'Unexpected browser handoff entries'
    roots={name+'.csv' for name in CASE_SPECS}|{name+'.frames' for name in CASE_SPECS}|{name+'.review.json' for name in ORACLE['reviews']}
    assert {p.name for p in inputs.iterdir()}==roots, 'Unexpected prepared input entries'
    fixed_hashes=json.loads((ROOT/'fixtures/png-sha256.json').read_text())
    assert set(fixed_hashes)==set(IMAGE_NAMES)
    result={'passed':True,'inputSource':manifest['inputSource'],'browserOriginalsRechecked':browser_directory is not None,'packages':{},'reviews':{}}
    for name,key in CASE_SPECS.items():
        package=manifest['packages'][name]
        provenance=('browser-download' if browser_directory is not None else 'generated-core') if name in ORACLE['reviews'] else 'controlled-negative' if name=='shifted' else 'controlled-fixture'
        assert package['provenance']==provenance, (name,'Unexpected provenance')
        assert set(package['files'])==expected_files(name), (name,'Unexpected manifest file set')
        frames=inputs/(name+'.frames')
        assert not frames.is_symlink() and frames.is_dir()
        assert {p.name for p in frames.iterdir()}==set(IMAGE_NAMES)
        if browser_directory is not None and name in ORACLE['reviews']:
            browser_frames=browser_directory/(name+'.frames')
            assert not browser_frames.is_symlink() and browser_frames.is_dir()
            assert {p.name for p in browser_frames.iterdir()}==set(IMAGE_NAMES)
        hashes={}
        for filename in sorted(expected_files(name)):
            data=read_regular(inputs/filename)
            actual={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
            assert actual==package['files'][filename], (name,filename,'Prepared-byte hash mismatch')
            if browser_directory is not None and name in ORACLE['reviews']:
                assert read_regular(browser_directory/filename)==data, (name,filename,'Browser download bytes changed')
            hashes[filename]=actual
        for image in IMAGE_NAMES:
            assert hashlib.sha256(read_regular(ROOT/'fixtures/source.frames'/image)).hexdigest()==fixed_hashes[image]
            assert hashes[name+'.frames/'+image]['sha256']==fixed_hashes[image], (name,image,'Original PNG bytes changed')
        if name in ['source','rounded-source']:
            assert read_regular(inputs/(name+'.csv'))==read_regular(ROOT/'fixtures'/(name+'.csv')), 'Controlled source fixture changed'
        result['packages'][name]={'provenance':provenance,'csv':inspect_csv(inputs/(name+'.csv'),ORACLE[key]),'files':hashes,'pngCount':len(IMAGE_NAMES)}
        if name in ORACLE['reviews']:result['reviews'][name]=inspect_receipt(inputs/(name+'.review.json'),name)
    return inputs,result

def main():
    report={'passed':False,'consumer':'Official Krita CLI','cases':{}}
    ART.mkdir(parents=True,exist_ok=True)
    try:
        browser=os.environ.get('EXPOSURE_BROWSER_EXPORT_DIR')
        if 'EXPOSURE_BROWSER_EXPORT_DIR' in os.environ:assert browser and browser.strip(), 'EXPOSURE_BROWSER_EXPORT_DIR cannot be empty'
        inputs,prepared=verify_prepared_inputs(ART,browser)
        report['preparedInputs']=prepared
        if sys.argv[1:]==['--verify-inputs-only']:
            print(json.dumps(prepared,indent=2))
            return
        assert not sys.argv[1:], 'Supported option: --verify-inputs-only'
        executable=os.environ['KRITA_BIN']
        outputs=fresh_outputs(ART)
        report['outputDirectory']=outputs.relative_to(ART).as_posix()
        version=subprocess.run([executable,'--version'],text=True,capture_output=True,timeout=30)
        report['version']=(version.stdout+version.stderr).strip()
        assert version.returncode==0, f'Krita version query failed: {version.returncode}'
        assert re.search(r'\b5\.3\.4\b',report['version']), report['version']
        for name,key in CASE_SPECS.items():
            spec=ORACLE[key]; source_csv=inputs/(name+'.csv'); kra=outputs/(name+'.kra'); sequence=outputs/(name+'-sequence');sequence.mkdir()
            command(executable,['--export','--export-filename',str(kra),str(source_csv)],outputs/(name+'-import.log'))
            require_created(kra)
            metadata=inspect_kra(kra,spec)
            # Reopen the saved native KRA, rather than rendering the CSV directly.
            command(executable,['--export-sequence','--export-filename',str(sequence/'frame.png'),str(kra)],outputs/(name+'-render.log'))
            pixels=check_sequence(sequence,ORACLE['doubled'] if name=='shifted' else spec)
            report['cases'][name]={'metadata':metadata,'pixels':pixels}
            if name=='shifted':
                assert [m['frame'] for m in pixels['mismatches']]==ORACLE['negativeControl']['expectedMismatchFrames'], 'Negative control did not fail exactly at shifted frame 12'
                intended=check_sequence(sequence,ORACLE['shifted'])
                report['cases'][name]['intendedShiftedPixels']=intended
                assert not intended['mismatches'], 'Negative control differs from its exact intended shifted pixel planes'
            else: assert not pixels['mismatches'], f'{name}: native projected pixels differ from handwritten oracle'
        # Re-read all inputs after the consumer runs; hashes are evidence of actual
        # files, rather than trusting the preparation script's preservation claim.
        _,rechecked=verify_prepared_inputs(ART,browser)
        assert rechecked==prepared, 'Native inputs changed during rendering'
        report['pngPreservation']={'passed':True,'imagesPerCase':5,'caseCount':len(CASE_SPECS)}
        report['passed']=True
    except Exception:
        report['error']=traceback.format_exc(); raise
    finally:
        destination='prepared-input-check.json' if sys.argv[1:]==['--verify-inputs-only'] else 'native-gate-result.json'
        if destination=='prepared-input-check.json':
            report['inputVerificationPassed']='preparedInputs' in report and 'error' not in report
            report['nativeConsumerRun']=False
        (ART/destination).write_text(json.dumps(report,indent=2)+'\n')
    print('PASS: official Krita 5.3.4 verified source 24 + exact 48 + rounded source 6 + rounded target 8 full pixel planes, native FPS/range/layer order/keys, independent rational receipts, original PNG bytes, and shifted negative control')

if __name__=='__main__':main()
