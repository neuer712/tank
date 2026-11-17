#!/usr/bin/env python3
"""Build tank-standalone.html: index.html + app.js + styles.css + alpine.min.js
merged into one file, with every audio file under sounds/ embedded as base64.
Usage: python3 build_standalone.py   (run inside this folder)"""
import base64, re, os, json

def uri(path):
    mime = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg'}[os.path.splitext(path)[1].lower()]
    return f'data:{mime};base64,' + base64.b64encode(open(path, 'rb').read()).decode()

html = open('index.html', encoding='utf-8').read()
js = open('app.js', encoding='utf-8').read()
css = open('styles.css', encoding='utf-8').read()
alpine = open('alpine.min.js', encoding='utf-8').read()

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

html, n1 = re.subn(r'<link rel="stylesheet" href="styles\.css(?:\?[^"]*)?">', lambda m: f'<style>\n{css}</style>', html, count=1)
# app.js must stay textually before alpine.min.js inside the merged <script> tag — it
# registers the 'alpine:init' listener that Alpine's own tail (queueMicrotask(start)) needs
# to already be attached by the time it fires. See the comment above these two <script> tags
# in index.html for why the load order matters.
html, n2 = re.subn(r'<script src="app\.js(?:\?[^"]*)?" defer></script>\s*<script src="alpine\.min\.js" defer></script>',
                    lambda m: f'<script>\n{js}\n{alpine}</script>', html, count=1)
assert n1 == 1 and n2 == 1, 'styles.css/app.js+alpine.min.js tags not found in index.html — did the markup change?'

open('tank-standalone.html', 'w', encoding='utf-8').write(html)
print(f'tank-standalone.html: {len(html)/1e6:.2f} MB, voice files embedded: {sorted(embed)}')
