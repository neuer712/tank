#!/usr/bin/env python3
"""Build tank-standalone.html: index.html + app.js + styles.css merged into one
file, with every audio file under sounds/ embedded as base64.
Usage: python3 build_standalone.py   (run inside this folder)"""
import base64, re, os, json

def uri(path):
    mime = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg'}[os.path.splitext(path)[1].lower()]
    return f'data:{mime};base64,' + base64.b64encode(open(path, 'rb').read()).decode()

html = open('index.html', encoding='utf-8').read()
js = open('app.js', encoding='utf-8').read()
css = open('styles.css', encoding='utf-8').read()

for key, path in re.findall(r"(\w+):\s*'(sounds/[^']+\.(?:wav|mp3|m4a|ogg))'", js):
    if os.path.exists(path):
        js = js.replace(f"'{path}'", f"'{uri(path)}'", 1)

embed = {}
for folder in ('halt', 'losfahren'):
    d = os.path.join('sounds', folder)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if os.path.splitext(f)[1].lower() in ('.wav', '.mp3', '.m4a', '.ogg'):
                embed[f'sounds/{folder}/{f}'] = uri(os.path.join(d, f))
js = js.replace('const EMBED = {};', 'const EMBED = ' + json.dumps(embed) + ';', 1)

html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>\n{css}</style>', 1)
html = html.replace('<script src="app.js"></script>', f'<script>\n{js}</script>', 1)

open('tank-standalone.html', 'w', encoding='utf-8').write(html)
print(f'tank-standalone.html: {len(html)/1e6:.2f} MB, voice files embedded: {sorted(embed)}')
