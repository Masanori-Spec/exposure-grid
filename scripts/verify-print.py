#!/usr/bin/env python3
"""Independent PDF text/page-count check after actual Chrome print capture.
Raster pages are produced separately and must also receive visual inspection.
"""
from pathlib import Path
import json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts/browser'
def main():
    report={'passed':False,'files':{}}
    for name in ['rounded-review-ja','rounded-review-en','boundary-page-en']:
        pdf=ART/(name+'.pdf');text_path=ART/(name+'.txt')
        info=subprocess.run(['pdfinfo',str(pdf)],check=True,text=True,capture_output=True).stdout
        pages=int(re.search(r'^Pages:\s+(\d+)',info,re.M).group(1));assert 1<=pages<=3,(name,pages)
        subprocess.run(['pdftotext','-layout',str(pdf),str(text_path)],check=True)
        text=text_path.read_text();compact=re.sub(r'\s+','',text)
        assert 'ExposureGrid' in text
        if name.startswith('rounded'):
            for token in ['rounded30.csv','1/4','4/15','+1/60','-1/120']:assert token in compact,(name,token)
            if name.endswith('ja'):
                assert '現在のプレビュー' in compact and '未チェック' in compact and '1-6/6' in compact
            else:assert 'Currentpreview.' in compact and 'notchecked' in compact and 'rows1-6of6' in compact
        else:
            for token in ['many-reviewed.csv','page6/7','rows126-150of161','first100exposuresonly']:assert token in compact,(name,token)
            assert re.search(r'\b125\b',text) and re.search(r'\b149\b',text)
        assert 'ChooseaZIP' not in compact and 'ZIPを選択' not in compact
        report['files'][name]={'pages':pages,'textCharacters':len(text),'currentPageScopeVerified':True}
    report['passed']=True;(ART/'print-verification.json').write_text(json.dumps(report,indent=2)+'\n')
    print('PASS: three actual print PDFs have readable text, bounded pages, current-page scope and accurate mode/acknowledgment')
if __name__=='__main__':main()
