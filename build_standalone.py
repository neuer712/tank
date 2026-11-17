#!/usr/bin/env python3
"""Build tank-standalone.html: index.html with every audio file under sounds/ embedded.
Usage: python3 build_standalone.py   (run inside this folder)"""
import base64, re, os, json, mimetypes
s = open('index.html', encoding='utf-8').read()
def uri(path):
    mime = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg'}[os.path.splitext(path)[1].lower()]
    return f'data:{mime};base64,' + base64.b64encode(open(path, 'rb').read()).decode()
for key, path in re.findall(r"(\w+):\s*'(sounds/[^']+\.(?:wav|mp3|m4a|ogg))'", s):
    if os.path.exists(path):
        s = s.replace(f"'{path}'", f"'{uri(path)}'", 1)
embed = {}
for folder in ('halt', 'losfahren'):
    d = os.path.join('sounds', folder)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if os.path.splitext(f)[1].lower() in ('.wav', '.mp3', '.m4a', '.ogg'):
                embed[f'sounds/{folder}/{f}'] = uri(os.path.join(d, f))
s = s.replace('const EMBED = {};', 'const EMBED = ' + json.dumps(embed) + ';', 1)
open('tank-standalone.html', 'w', encoding='utf-8').write(s)
print(f'tank-standalone.html: {len(s)/1e6:.2f} MB, voice files embedded: {sorted(embed)}')
