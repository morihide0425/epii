# 横スクロールしたメニューで探すを選んだとき、動いている塗りの中の文字が、その場所のボタンと同じか
import asyncio, json
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'cf1',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
NAMES=['養生ランチコース《選べるメイン料理》','養生ランチコース《メイン2種》','ディナーセット','薬膳養生　ディナーコース']
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort()); await ctx.route('**/static.line-scdn.net/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        cs=(await (await rq.post(B+'/admin/api/courses', headers=H, data='{}')).json())['courses']
        for i,n in enumerate(NAMES):
            c=dict(cs[i%len(cs)]); c['name']=n; c['visible']=1
            if i>=len(cs): c.pop('id',None)
            await rq.post(B+'/admin/api/saveCourse', headers=H, data=json.dumps(c))
        c=await ctx.new_page(); errs=[]; c.on('pageerror',lambda e:errs.append(str(e)))
        await c.add_init_script(LIFF); await c.goto(B+'/'); await c.wait_for_selector('.stepper'); await c.wait_for_timeout(500)
        n=await c.locator('.fchip').count(); print('chips', n)
        await c.eval_on_selector('.fchips','g=>g.scrollLeft=g.scrollWidth')
        await c.wait_for_timeout(200)
        sl0=await c.eval_on_selector('.fchips','g=>g.scrollLeft')
        await c.click('.fchip >> nth=-2'); await c.wait_for_timeout(60)
        # 塗りの中で、本物のボタンと重なっている写しの文字が同じか
        res=await c.evaluate('''()=>{const gh=document.querySelector('.m-ghost'); if(!gh) return 'no ghost';
          const gr=gh.getBoundingClientRect(); const out=[];
          document.querySelectorAll('.m-ghost .fchip').forEach((cp,i)=>{const r=cp.getBoundingClientRect(); if(r.right<gr.left||r.left>gr.right) return;
            const real=document.querySelectorAll('.fchips:not(.m-inv) .fchip')[i]; const rr=real.getBoundingClientRect();
            out.push([cp.textContent, Math.round(r.left-rr.left)])}); return out}''')
        print('塗りの中の文字とずれ(px):', res)
        await c.wait_for_timeout(900)
        sl1=await c.eval_on_selector('.fchips','g=>g.scrollLeft')
        print('スクロール', sl0, '→', sl1, '| 同じ要素のまま:', await c.evaluate("document.querySelector('.fchips')===window.__g") if False else '')
        # 続けて別のを選ぶ（同じ要素が残るか）
        await c.evaluate("window.__g=document.querySelector('.fchips')")
        await c.click('.fchip >> nth=-1'); await c.wait_for_timeout(900)
        print('枠の要素がそのまま:', await c.evaluate("document.querySelector('.fchips')===window.__g"), '| 選択:', await c.eval_on_selector('.fchip.on','e=>e.textContent'), '| m-pending残り:', await c.locator('.m-pending').count(), '| ghost残り:', await c.locator('.m-ghost').count())
        # 入力中の欄が保たれるか
        await c.fill('#fSei','山田'); await c.click('[data-act=guests][data-d="1"]'); await c.wait_for_timeout(300)
        print('入力保持:', await c.input_value('#fSei'), '| 人数:', await c.text_content('.stepper .n'))
        print('errors', errs)
        await b.close()
asyncio.run(main())
