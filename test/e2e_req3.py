import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'mf',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['lunch','dinner']
        st['weekly']['0']=['morning','lunch','dinner']; st['weekly']['6']=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        c=await ctx.new_page(); errs=[]; c.on('pageerror',lambda e:errs.append(str(e)))
        await c.add_init_script(LIFF)
        await c.goto(B+'/'); await c.wait_for_selector('.finder')
        await c.click('.fchip:has-text("モーニング")'); await c.wait_for_timeout(300)
        print('案内:', (await c.inner_text('.findhint')).replace('\n',' '))
        ok=await c.eval_on_selector_all('.day:not(.x)','e=>e.map(x=>x.dataset.date)')
        print('表示中の月で予約できる日:', [d[5:]+'('+'月火水木金土日'[datetime.date.fromisoformat(d).weekday()]+')' for d in ok])
        cal=await c.query_selector('.card:has(.finder)'); await cal.screenshot(path='shots/F1.png')
        await c.click(f'.day[data-date="{ok[0]}"]'); await c.wait_for_timeout(300)
        print('時間の欄:', await c.eval_on_selector_all('.sess','e=>e.map(x=>x.innerText.replace(/\\n/g," "))'))
        await c.click('.slot:not([disabled]) >> nth=0'); await c.wait_for_timeout(300)
        print('メニューが選ばれた状態:', await c.eval_on_selector_all('.course.sel .name','e=>e.map(x=>x.innerText)'))
        D=ok[0]
        a=await ctx.new_page(); a.on('pageerror',lambda e:errs.append('a:'+str(e)))
        a.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await a.goto(B+'/admin'); await a.wait_for_timeout(700)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis')
        await a.evaluate(f"goDay('{D}')"); await a.wait_for_selector('[data-act=planToggle]')
        await a.click('[data-act=planToggle]'); await a.wait_for_timeout(300)
        print('早じまいの行:', [t.replace('\n',' ') for t in await a.eval_on_selector_all('.ecrow','e=>e.map(x=>x.innerText)')])
        await a.click('.ecrow:has-text("ランチ") [data-act=stopFrom] >> nth=2'); await a.wait_for_timeout(900)
        print('ランチを止めた後:', [t.replace('\n',' ') for t in await a.eval_on_selector_all('.ecrow','e=>e.map(x=>x.innerText)')])
        print('停止の表示:', [t.replace('\n',' ') for t in await a.eval_on_selector_all('.panel .tag.red','e=>e.map(x=>x.parentElement.innerText)')])
        el=await a.query_selector('.panel'); await el.screenshot(path='shots/F2.png')
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('#cutDays')
        await a.click('[data-act=setPart][data-v=menu]'); await a.wait_for_timeout(300)
        await a.click('[data-act=edit] >> nth=2'); await a.wait_for_selector('#cCap')
        await a.fill('#cCap','4'); await a.click('[data-act=saveCourse]'); await a.wait_for_timeout(700)
        print('メニュー一覧:', [t for t in (await a.inner_text('#view')).split('\n') if '同じ時間に' in t])
        print('errors', errs)
        await b.close()
asyncio.run(main())
