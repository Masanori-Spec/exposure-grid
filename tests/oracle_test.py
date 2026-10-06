import copy, importlib.util, json, os, pathlib, shutil, struct, subprocess, tempfile, unittest, zipfile, zlib
from fractions import Fraction

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gate',ROOT/'scripts/native-gate.py');gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)


def literal_receipt(name):
    expected=gate.ORACLE['reviews'][name];source=gate.ORACLE[expected['source']];target=gate.ORACLE[expected['target']]
    return {'schema':'exposure-grid-review/v1','mode':expected['mode'],'sourceFPS':source['fps'],'targetFPS':target['fps'],'sourceFrames':source['frames'],'targetFrames':target['frames'],
        **{key:copy.deepcopy(expected[key]) for key in ['sourceDurationSeconds','targetDurationSeconds','durationErrorSeconds','boundaries']},
        'layers':[{'name':layer['name'],'exposures':[{'start':start,'end':end,'image':'' if symbol=='blank' else symbol+'.png','sourceStart':source['layers'][i]['spans'][j][0],'sourceEnd':source['layers'][i]['spans'][j][1]} for j,(start,end,symbol) in enumerate(layer['spans'])]} for i,layer in enumerate(target['layers'])]}


def write_png(path,pixels):
    def chunk(kind,value):return struct.pack('>I',len(value))+kind+value+struct.pack('>I',zlib.crc32(kind+value)&0xffffffff)
    scanlines=b''.join(b'\0'+pixels[y*64:(y+1)*64] for y in range(16))
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(scanlines))+chunk(b'IEND',b''))


class OracleTests(unittest.TestCase):
    def test_original_and_rounded_fixture_pixels_and_bytes(self):
        for symbol in ['A','B','C','X','Y']:
            path=ROOT/'fixtures/source.frames'/f'{symbol}.png'
            actual=gate.png_rgba(path)
            expected=b''.join(bytes(gate.pixel(symbol,x,y)) for y in range(16) for x in range(16))
            self.assertEqual(actual,expected)
            self.assertEqual(path.read_bytes(),(ROOT/'fixtures/rounded-source.frames'/path.name).read_bytes())
        gate.inspect_csv(ROOT/'fixtures/rounded-source.csv',gate.ORACLE['roundedSource'])

    def test_handwritten_boundaries_not_converter_derived(self):
        spec=gate.ORACLE['doubled']
        for frame in range(48):
            data=gate.expected_frame(spec,frame)
            self.assertEqual(len(data),16*16*4)
            self.assertEqual(tuple(data[:4]),(255,0,0,255) if frame<12 else (0,0,255,255) if frame<24 else (255,0,255,255))
            self.assertEqual(tuple(data[-4:]),(0,0,0,0) if frame<6 or 18<=frame<30 else (0,255,0,255) if frame<18 else (255,255,0,255))

    def test_rounded_source_six_and_target_eight_literal_full_planes(self):
        cases=[('roundedSource',['A','A','B','B','B','C'],['blank','X','X','X','Y','Y']),('rounded',['A','A','A','B','B','B','C','C'],['blank','X','X','X','X','Y','Y','Y'])]
        colors={'A':bytes([255,0,0,255]),'B':bytes([0,0,255,255]),'C':bytes([255,0,255,255]),'blank':bytes([0,0,0,0]),'X':bytes([0,255,0,255]),'Y':bytes([255,255,0,255])}
        for key,top,bottom in cases:
            spec=gate.ORACLE[key]
            self.assertEqual(spec['frames'],len(top))
            for frame in range(len(top)):
                # Explicit planes, not a converter operation or call to pixel().
                expected=b''.join(colors[top[frame]] if x<10 and y<10 else colors[bottom[frame]] for y in range(16) for x in range(16))
                self.assertEqual(gate.expected_frame(spec,frame),expected,(key,frame))
        self.assertEqual(gate.ORACLE['rounded']['layers'][0]['keys'],[0,3,6])
        self.assertEqual(gate.ORACLE['rounded']['layers'][1]['keys'],[0,1,5])

    def test_rounded_literal_rationals_are_independently_consistent(self):
        expected=gate.ORACLE['reviews']['rounded30']
        self.assertEqual(expected['sourceDurationSeconds'],{'numerator':1,'denominator':4})
        self.assertEqual(expected['targetDurationSeconds'],{'numerator':4,'denominator':15})
        self.assertEqual(expected['durationErrorSeconds'],{'numerator':1,'denominator':60})
        self.assertEqual([(b['sourceFrame'],b['targetFrame']) for b in expected['boundaries']],[(0,0),(1,1),(2,3),(4,5),(5,6),(6,8)])
        self.assertEqual([gate.rational(b['errorSeconds'],'test') for b in expected['boundaries']],[Fraction(0),Fraction(-1,120),Fraction(1,60),Fraction(0),Fraction(-1,120),Fraction(1,60)])
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'rounded30.review.json'
            path.write_text(json.dumps(literal_receipt('rounded30')))
            self.assertTrue(gate.inspect_receipt(path,'rounded30')['passed'])

    def test_receipt_rejects_false_sign_unreduced_value_float_and_wrong_trace(self):
        mutations=[lambda r:r['durationErrorSeconds'].update(numerator=-1),lambda r:r['boundaries'][1]['errorSeconds'].update(numerator=1),lambda r:r['boundaries'][2]['errorSeconds'].update(numerator=2,denominator=120),lambda r:r.update(targetFPS=30.0),lambda r:r['layers'][1]['exposures'][0].update(image='X.png'),lambda r:r['layers'][0]['exposures'][1].update(sourceStart=3)]
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'rounded30.review.json'
            for mutate in mutations:
                receipt=literal_receipt('rounded30');mutate(receipt);path.write_text(json.dumps(receipt))
                with self.assertRaises(AssertionError):gate.inspect_receipt(path,'rounded30')

    def test_sequence_checks_every_rounded_frame_and_pixel(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);spec=gate.ORACLE['rounded']
            for frame in range(8):write_png(root/f'frame{frame:04d}.png',gate.expected_frame(spec,frame))
            result=gate.check_sequence(root,spec)
            self.assertEqual((result['checkedFrames'],result['pixelsPerFrame'],result['mismatches']),(8,256,[]))
            bad=bytearray(gate.expected_frame(spec,7));bad[-4:]=bytes([1,2,3,255]);write_png(root/'frame0007.png',bad)
            self.assertEqual(gate.check_sequence(root,spec)['mismatches'],[{'frame':7,'pixels':[{'x':15,'y':15,'expected':[255,255,0,255],'actual':[1,2,3,255]}]}])
            (root/'frame0007.png').unlink()
            with self.assertRaises(AssertionError):gate.check_sequence(root,spec)

    def test_stale_artifacts_cannot_satisfy_noop_native_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            (root/'source.kra').write_bytes(b'stale');(root/'source-sequence').mkdir()
            old=gate.fresh_outputs(root);(old/'source.kra').write_bytes(b'stale')
            fresh=gate.fresh_outputs(root)
            self.assertNotEqual(old,fresh)
            self.assertFalse((fresh/'source.kra').exists())
            with self.assertRaises(AssertionError):gate.require_created(fresh/'source.kra')

    def test_shifted_oracle_is_exactly_the_intended_frame12_red_rectangle(self):
        original=gate.ORACLE['doubled'];shifted=gate.ORACLE['shifted']
        self.assertEqual(shifted['layers'][0]['keys'],[0,13,24])
        for frame in range(48):
            before=gate.expected_frame(original,frame);after=gate.expected_frame(shifted,frame)
            changed=[i//4 for i in range(0,len(before),4) if before[i:i+4]!=after[i:i+4]]
            self.assertEqual(changed,[y*16+x for y in range(10) for x in range(10)] if frame==12 else [])
            for position in changed:
                self.assertEqual(before[position*4:position*4+4],bytes([0,0,255,255]))
                self.assertEqual(after[position*4:position*4+4],bytes([255,0,0,255]))

    def test_namespaced_xml(self):
        self.assertIsNotNone(gate.xml_root(b'<DOC xmlns="urn:krita"><IMAGE/></DOC>').find('IMAGE'))

    def test_rounded_native_metadata_requires_fps_range_order_and_every_key(self):
        spec=gate.ORACLE['rounded']
        def kra(path,fps=30,end=7,names=('Layer A','Layer B'),keys=((0,3,6),(0,1,5))):
            layers=''.join(f'<layer name="{name}" nodetype="paintlayer" opacity="255" visible="1" compositeop="normal" filename="layer{i}" keyframes="layer{i}.xml"/>' for i,name in enumerate(names))
            main=f'<DOC><IMAGE width="16" height="16"><layers>{layers}</layers><animation><framerate value="{fps}"/><range from="0" to="{end}"/></animation></IMAGE></DOC>'
            with zipfile.ZipFile(path,'w') as archive:
                archive.writestr('maindoc.xml',main)
                for i,times in enumerate(keys):archive.writestr(f'data/layer{i}.xml','<keyframes><channel name="content">'+''.join(f'<keyframe time="{time}"/>' for time in times)+'</channel></keyframes>')
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'rounded30.kra';kra(path)
            self.assertEqual(gate.inspect_kra(path,spec)['keyframes'],{'Layer A':[0,3,6],'Layer B':[0,1,5]})
            for changed in [{'fps':24},{'end':6},{'names':('Layer B','Layer A')},{'keys':((0,2,6),(0,1,5))}]:
                kra(path,**changed)
                with self.assertRaises(AssertionError):gate.inspect_kra(path,spec)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=pathlib.Path(self.temporary.name)/'project';self.root.mkdir()
        for folder in ['fixtures','scripts','src']:(self.root/folder).mkdir()
        for name in ['source.csv','rounded-source.csv','oracle.json','png-sha256.json']:shutil.copyfile(ROOT/'fixtures'/name,self.root/'fixtures'/name)
        for name in ['source.frames','rounded-source.frames']:shutil.copytree(ROOT/'fixtures'/name,self.root/'fixtures'/name)
        shutil.copyfile(ROOT/'scripts/prepare-native.mjs',self.root/'scripts/prepare-native.mjs')
        shutil.copyfile(ROOT/'src/core.mjs',self.root/'src/core.mjs')
        self.artifacts=self.root/'artifacts/native'
        self.browser=pathlib.Path(self.temporary.name)/'browser-exports'
        self.env={key:value for key,value in os.environ.items() if key!='EXPOSURE_BROWSER_EXPORT_DIR'}
        self.run_prepare()

    def run_prepare(self,browser=None,succeeds=True):
        env={**self.env,**({'EXPOSURE_BROWSER_EXPORT_DIR':str(browser)} if browser is not None else {})}
        result=subprocess.run(['node',str(self.root/'scripts/prepare-native.mjs')],cwd=self.root,env=env,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode==0,succeeds,result.stdout+result.stderr)
        return result

    def synthetic_browser_handoff(self):
        # Synthetic downloaded files exercise the handoff API only; they are not
        # presented as evidence that an actual browser exported these packages.
        manifest=json.loads((self.artifacts/'prepared.json').read_text());inputs=self.artifacts/manifest['inputDirectory']
        self.browser.mkdir()
        for name in ['retimed24','rounded30']:
            for filename in gate.expected_files(name):
                destination=self.browser/filename;destination.parent.mkdir(exist_ok=True);shutil.copyfile(inputs/filename,destination)
        # Valid text differs from core serialization, so regeneration fails the
        # equality assertion even if its timeline would otherwise be equivalent.
        csv=self.browser/'retimed24.csv';csv.write_bytes(csv.read_bytes().replace(b'Original two-layer timing study',b'Browser handed-off timing study'))
        receipt=self.browser/'rounded30.review.json';receipt.write_text(json.dumps(json.loads(receipt.read_text()),separators=(',',':'))+'\n')
        return self.browser

    def test_generated_preparation_checks_all_five_cases(self):
        inputs,report=gate.verify_prepared_inputs(self.artifacts)
        self.assertEqual(set(report['packages']),{'source','retimed24','shifted','rounded-source','rounded30'})
        self.assertEqual(report['inputSource'],'generated-core')
        self.assertFalse(report['browserOriginalsRechecked'])
        self.assertEqual(report['reviews']['rounded30']['durationErrorSeconds'],{'numerator':1,'denominator':60})
        self.assertTrue(inputs.is_dir())

    def test_browser_bytes_are_copied_unchanged_and_rechecked_independently(self):
        browser=self.synthetic_browser_handoff()
        before={p.relative_to(browser).as_posix():p.read_bytes() for p in browser.rglob('*') if p.is_file()}
        self.run_prepare(browser)
        inputs,report=gate.verify_prepared_inputs(self.artifacts,browser)
        self.assertTrue(report['browserOriginalsRechecked']);self.assertEqual(report['inputSource'],'browser-downloads')
        for name,data in before.items():
            self.assertEqual((inputs/name).read_bytes(),data)
            self.assertEqual((browser/name).read_bytes(),data)
        for name in ['retimed24','rounded30']:self.assertEqual(report['packages'][name]['provenance'],'browser-download')

    def test_browser_mode_cannot_use_generated_or_unverified_originals(self):
        browser=self.synthetic_browser_handoff()
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts,browser)
        self.run_prepare(browser)
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts)
        path=browser/'retimed24.csv';path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts,browser)

    def test_missing_browser_file_invalidates_stale_manifest_without_fallback(self):
        browser=self.synthetic_browser_handoff();(browser/'rounded30.review.json').unlink()
        self.run_prepare(browser,succeeds=False)
        self.assertFalse((self.artifacts/'prepared.json').exists())
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts,browser)

    def test_wrong_receipt_and_changed_png_fail_preparation(self):
        browser=self.synthetic_browser_handoff();path=browser/'rounded30.review.json';original=path.read_bytes()
        receipt=json.loads(original);receipt['durationErrorSeconds']['numerator']=-1;path.write_text(json.dumps(receipt))
        self.run_prepare(browser,succeeds=False);self.assertFalse((self.artifacts/'prepared.json').exists())
        path.write_bytes(original);image=browser/'rounded30.frames/A.png';image.write_bytes((ROOT/'fixtures/source.frames/B.png').read_bytes())
        self.run_prepare(browser,succeeds=False);self.assertFalse((self.artifacts/'prepared.json').exists())

    def test_symlink_and_extra_file_fail_closed(self):
        browser=self.synthetic_browser_handoff();image=browser/'rounded30.frames/A.png';image.unlink();image.symlink_to(ROOT/'fixtures/source.frames/A.png')
        self.run_prepare(browser,succeeds=False)
        image.unlink();shutil.copyfile(ROOT/'fixtures/source.frames/A.png',image)
        extra=browser/'README.txt';extra.write_text('unexpected');self.run_prepare(browser,succeeds=False)
        self.assertFalse((self.artifacts/'prepared.json').exists())

    def test_empty_handoff_and_native_artifact_directory_fail_closed(self):
        self.run_prepare('',succeeds=False)
        self.assertFalse((self.artifacts/'prepared.json').exists())
        self.run_prepare(self.artifacts,succeeds=False)
        self.assertFalse((self.artifacts/'prepared.json').exists())

    def test_native_gate_rejects_tampered_prepared_bytes_and_manifest_path(self):
        manifest_path=self.artifacts/'prepared.json';manifest=json.loads(manifest_path.read_text())
        path=self.artifacts/manifest['inputDirectory']/'rounded30.csv';path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts)
        manifest['inputDirectory']='../fixtures';manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(AssertionError):gate.verify_prepared_inputs(self.artifacts)


if __name__=='__main__':unittest.main()
