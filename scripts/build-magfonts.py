# Build-time font prep for the magazine PDF writer: WinAnsi (cp1252) widths + metrics -> src/magfonts.json,
# zlib-deflated TTF files -> public/mag/*.bin (embedded verbatim as /FlateDecode FontFile2: zero runtime CPU).
import json, zlib, sys
from fontTools.ttLib import TTFont
SRC = '/workspace/aichef/fonts/'
FONTS = {'serif': 'cormorant-garamond-latin-500-normal', 'serifI': 'cormorant-garamond-latin-500-italic', 'serifB': 'cormorant-garamond-latin-700-normal', 'sans': 'inter-latin-400-normal', 'sansB': 'inter-latin-600-normal'}
NAMES = {'serif': 'CormorantGaramond-Medium', 'serifI': 'CormorantGaramond-MediumItalic', 'serifB': 'CormorantGaramond-Bold', 'sans': 'Inter-Regular', 'sansB': 'Inter-SemiBold'}
out = {}
for k, f in FONTS.items():
    raw = open(SRC + f + '.ttf', 'rb').read(); t = TTFont(SRC + f + '.ttf'); upm = t['head'].unitsPerEm; cmap = t.getBestCmap(); hm = t['hmtx']
    s = lambda v: round(v * 1000 / upm)
    widths = []
    for code in range(32, 256):
        try: ch = bytes([code]).decode('cp1252')
        except UnicodeDecodeError: widths.append(0); continue
        g = cmap.get(ord(ch)); widths.append(s(hm[g][0]) if g else 0)
    os2 = t['OS/2']; h = t['head']
    out[k] = {'name': NAMES[k], 'file': f'/mag/{k}.bin', 'len1': len(raw), 'widths': widths, 'ascent': s(t['hhea'].ascent), 'descent': s(t['hhea'].descent),
              'cap': s(getattr(os2, 'sCapHeight', 700) or 700), 'bbox': [s(h.xMin), s(h.yMin), s(h.xMax), s(h.yMax)], 'italic': -12 if k == 'serifI' else 0, 'serif': k.startswith('serif')}
    open(f'public/mag/{k}.bin', 'wb').write(zlib.compress(raw, 9))
json.dump(out, open('src/magfonts.json', 'w'))
print({k: (v['len1'], v['widths'][33]) for k, v in out.items()})
