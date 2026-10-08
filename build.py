import json, base64, io, re
from PIL import Image
src = lambda f: open('src/' + f, encoding='utf-8').read()
shared = src('shared.js')
server = src('server.js')
motion = src('motion.js')
im = Image.open('src/logo_source.webp').convert('RGBA')
bb = im.getchannel('A').point(lambda v: 255 if v > 20 else 0).getbbox()
c = im.crop((bb[0]-8, bb[1]-8, bb[2]+8, bb[3]+8)); c.thumbnail((300, 460), Image.LANCZOS)
buf = io.BytesIO(); c.save(buf, 'WEBP', quality=82)
logo = base64.b64encode(buf.getvalue()).decode()
def make_icon(size, pad_ratio=0.08, bg=(255, 255, 255)):
    src = Image.open('src/icon_source.png').convert('RGBA')
    canvas = Image.new('RGB', (size, size), bg)
    inner = int(size * (1 - pad_ratio * 2))
    im = src.copy(); im.thumbnail((inner, inner), Image.LANCZOS)
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    out = io.BytesIO(); canvas.save(out, 'PNG', optimize=True)
    return base64.b64encode(out.getvalue()).decode()
icons = {n: make_icon(n, 0.08 if n >= 120 else 0.02) for n in (32, 180, 192, 512)}
assets = '\n'.join([
  '/* ===== ここから下は画面とロゴのデータです（書き換え不要） ===== */',
  'const SHARED_SOURCE = ' + json.dumps(shared, ensure_ascii=False) + ';',
  'const CUSTOMER_HTML = ' + json.dumps(src('customer.html').replace('/*__MOTION__*/', motion), ensure_ascii=False) + ';',
  'const ADMIN_HTML = ' + json.dumps(src('admin.html').replace('/*__MOTION__*/', motion), ensure_ascii=False) + ';',
  "const LOGO_B64 = '" + logo + "';",
  'const ICONS = ' + json.dumps(icons) + ';',
  ''
])
out = server.replace('/*__SHARED_CODE__*/', shared).replace('/*__ASSETS__*/', assets)
import os; os.makedirs('dist', exist_ok=True)
open('dist/worker.js', 'w', encoding='utf-8').write(out)
print('worker.js', len(out.encode()), 'bytes; logo', c.size, len(logo))
