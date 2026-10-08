import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'mo1',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        c=await ctx.new_page(); errs=[]; c.on('pageerror',lambda e:errs.append(str(e))); c.on('console', lambda m: m.type=='error' and errs.append(m.text))
        await c.add_init_script(LIFF)
        await c.goto(B+'/'); await c.wait_for_selector('.stepper')
        print('linear()対応:', await c.evaluate("CSS.supports('animation-timing-function','linear(0, 1)')"))
        days=await c.eval_on_selector_all('.day:not(.x)','e=>e.map(x=>x.dataset.date)')
        await c.click(f'.day[data-date="{days[0]}"]'); await c.wait_for_timeout(400)
        # 日付を変える → 選択の印が移動する
        await c.click(f'.day[data-date="{days[4]}"]')
        frames=[]
        for i in range(6):
            await c.wait_for_timeout(45)
            g=await c.evaluate("(()=>{const g=document.querySelector('.m-ghost');if(!g)return null;const r=g.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})()")
            frames.append(g)
            if i==1: await c.screenshot(path='shots/mc_mid.png', clip={'x':0,'y':300,'width':390,'height':400})
        print('移動中の形（左,上,幅,高さ）:', frames)
        await c.wait_for_timeout(500)
        print('残った形:', await c.locator('.m-ghost').count(), '| 選択中:', await c.eval_on_selector('.day.sel','e=>e.dataset.date')==days[4], '| 仮の見た目が残っていない:', await c.locator('.m-pending').count()==0)
        # 時間・メニュー
        await c.click('.slot:not([disabled]) >> nth=0'); await c.wait_for_timeout(400)
        await c.click('.slot:not([disabled]) >> nth=3'); await c.wait_for_timeout(60)
        print('時間の移動中:', await c.locator('.m-ghost').count())
        await c.wait_for_timeout(500)
        await c.click('.course:not([disabled]) >> nth=0'); await c.wait_for_timeout(400)
        await c.fill('#fSei','山田'); await c.fill('#fMei','花子'); await c.fill('#fPhone','09012345678')
        # 送信：丸く縮む → 読み込み中 → チェック → 完了画面
        btn=c.locator('[data-act=submit]')
        w0=(await btn.bounding_box())['width']
        await btn.click()
        await c.wait_for_timeout(200)
        bb=await c.evaluate("(()=>{const b=document.querySelector('[data-act=submit]');if(!b)return null;const r=b.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height),b.classList.contains('m-busy')]})()")
        print('送信ボタン:', round(w0), '→', bb)
        await c.screenshot(path='shots/mc_busy.png', clip={'x':0,'y':500,'width':390,'height':344})
        await c.wait_for_selector('text=リクエストを受け付けました', timeout=8000)
        await c.wait_for_timeout(150)
        await c.screenshot(path='shots/mc_done.png')
        print('完了画面: OK')
        print('errors', errs)
        await b.close()
asyncio.run(main())
