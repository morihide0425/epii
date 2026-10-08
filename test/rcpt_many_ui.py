import asyncio, os, time
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright
# 写真から大きなレシートを何枚もまとめて選んだとき（iPhoneの写真くらいの大きさ）：すぐに枠が出て、1枚ずつ準備・読み取りされる
B='http://127.0.0.1:8787'
SHOTS='shots'
os.makedirs(SHOTS, exist_ok=True)
big=SHOTS+'/receipt_big.jpg'
im=Image.new('RGB',(3024,4032),'white'); d=ImageDraw.Draw(im)
for y in range(200,3800,120): d.text((300,y),'阿倍野青果 にんじん 1,280 合計 6,480',fill='black')
im.save(big, quality=90)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); a=await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2); errs=[]
        a.on('pageerror',lambda e:errs.append(str(e)))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'): await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('[data-act=rcptOpen]'); await a.click('[data-act=rcptOpen]'); await a.wait_for_timeout(300)
        t=time.time()
        await a.set_input_files('#rcptLib', [big]*10); await a.wait_for_timeout(100)
        print('選んですぐの枠:', await a.locator('.rq').count(), '／準備中:', await a.locator('.rq', has_text='写真を準備しています').count())
        await a.screenshot(path=SHOTS+'/rcpt_many.png')
        await a.wait_for_function("document.querySelectorAll('.rq [data-act=rqSave]').length===10", timeout=60000)
        print('10枚とも読み取った:', round(time.time()-t,1), '秒 ／エラー:', await a.locator('.rq .warn').count())
        print('errors', errs)
        await b.close()
asyncio.run(main())
