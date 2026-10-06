#!/usr/bin/env python3
"""Fetch a pinned official Krita release from a KDE-listed non-university mirror.
Runs only in hosted CI or an explicitly supplied temporary test directory.
"""
from pathlib import Path
import hashlib, json, os, subprocess, urllib.request, urllib.parse
ROOT=Path(__file__).resolve().parents[1]
PIN=json.loads((ROOT/'scripts/krita-release.json').read_text())

def allowed(url):
    parsed=urllib.parse.urlsplit(url)
    return parsed.scheme=='https' and parsed.hostname in PIN['allowedDownloadHosts'] and parsed.port in (None,443) and not parsed.username and not parsed.password

class RestrictedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if not allowed(newurl): raise RuntimeError('Download redirected outside the explicit non-university mirror allowlist; stopped before following')
        return super().redirect_request(request,fp,code,msg,headers,newurl)

def main():
    temp=os.environ.get('RUNNER_TEMP')
    if not temp:raise RuntimeError('RUNNER_TEMP is required: this is a hosted-CI test download, not a local runtime installation')
    folder=Path(temp)/'exposuregrid-krita';folder.mkdir(parents=True,exist_ok=True)
    binary=folder/PIN['filename'];partial=binary.with_suffix('.partial')
    assert allowed(PIN['downloadURL'])
    digest=hashlib.sha256();size=0
    opener=urllib.request.build_opener(RestrictedRedirect())
    try:
        with opener.open(PIN['downloadURL'],timeout=120) as response,partial.open('wb') as output:
            if not allowed(response.url):raise RuntimeError('Unexpected download origin')
            while chunk:=response.read(1024*1024):
                size+=len(chunk)
                if size>PIN['sizeBytes']:raise RuntimeError('Download exceeds pinned artifact size')
                digest.update(chunk);output.write(chunk)
        if size!=PIN['sizeBytes'] or digest.hexdigest()!=PIN['sha256']:raise RuntimeError('Official artifact size/SHA-256 mismatch; execution blocked')
        partial.replace(binary)
    finally:
        partial.unlink(missing_ok=True)
    binary.chmod(0o755)
    # The binary is verified before this first execution. No FUSE or privilege changes.
    with (folder/'extract.log').open('wb') as log:
        subprocess.run([str(binary),'--appimage-extract'],cwd=folder,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
    executable=folder/'squashfs-root'/'AppRun'
    if not executable.is_file():raise RuntimeError('AppImage extraction did not provide AppRun')
    art=ROOT/'artifacts/native';art.mkdir(parents=True,exist_ok=True)
    (art/'official-consumer-pin.json').write_text(json.dumps({**PIN,'actualSHA256':digest.hexdigest(),'actualSizeBytes':size,'verifiedBeforeExecution':True},indent=2)+'\n')
    print(f'Verified official Krita {PIN["version"]}: {digest.hexdigest()} ({size} bytes); test-only extraction ready')

if __name__=='__main__':main()
