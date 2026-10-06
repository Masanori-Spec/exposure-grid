import importlib.util, pathlib, unittest, json, tempfile, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gate',ROOT/'scripts/native-gate.py'); gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
class OracleTests(unittest.TestCase):
    def test_original_fixture_pixels(self):
        for symbol in ['A','B','C','X','Y']:
            actual=gate.png_rgba(ROOT/'fixtures/source.frames'/f'{symbol}.png')
            expected=b''.join(bytes(gate.pixel(symbol,x,y)) for y in range(16) for x in range(16))
            self.assertEqual(actual,expected)
    def test_handwritten_boundaries_not_converter_derived(self):
        spec=gate.ORACLE['doubled']
        for frame in range(48):
            data=gate.expected_frame(spec,frame)
            self.assertEqual(len(data),16*16*4)
            self.assertEqual(tuple(data[:4]),(255,0,0,255) if frame<12 else (0,0,255,255) if frame<24 else (255,0,255,255))
            self.assertEqual(tuple(data[-4:]),(0,0,0,0) if frame<6 or 18<=frame<30 else (0,255,0,255) if frame<18 else (255,255,0,255))
    def test_stale_artifacts_cannot_satisfy_noop_native_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            (root/'source.kra').write_bytes(b'stale')
            (root/'source-sequence').mkdir()
            old=gate.fresh_outputs(root); (old/'source.kra').write_bytes(b'stale')
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
if __name__=='__main__':unittest.main()
