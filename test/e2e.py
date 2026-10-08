import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF = """
window.__friend = %s;
window.liff = { init: async()=>{}, isLoggedIn:()=>true, login(){}, logout(){}, getIDToken:()=>'%s',
  getProfile: async()=>({displayName:'はなこ'}), getFriendship: async()=>({friendFlag: window.__friend}),
  isInClient:()=>true, closeWindow(){ document.title='closed' } };
"""
def jst(): return (datetime.datetime.utcnow()+datetime.timedelta(hours=9)).date()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ctx=await b.new_context(viewport={'width':390,'height':844})
        await ctx.route('**/static.line-scdn.net/**', lambda r: r.abort())
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        errs=[]
        c=await ctx.new_page(); c.on('pageerror',lambda e:errs.append('c:'+str(e)))
        c.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await c.add_init_script(LIFF % ('true','hana'))
        t0=datetime.datetime.now()
        await c.goto(B+'/'); await c.wait_for_selector('.stepper')
        print('customer first load ms', int((datetime.datetime.now()-t0).total_seconds()*1000))
        await c.screenshot(path='shots/c1.png',full_page=True)
        # pick first enabled date >= +5 that is saturday-ish: choose first non-x day
        # go next month if needed
        days = await c.eval_on_selector_all('.day:not(.x)', 'e=>e.map(x=>x.dataset.date)')
        print('enabled days', days[:6])
        target = days[3] if len(days)>3 else days[0]
        await c.click(f'.day[data-date="{target}"]')
        slots = await c.eval_on_selector_all('.slot', 'e=>e.map(x=>x.dataset.time+":"+x.innerText.split("\\n")[1]+(x.disabled?"(x)":""))')
        print('slots', slots)
        await c.click('.slot:not([disabled]) >> nth=-1')
        names = await c.eval_on_selector_all('.course', 'e=>e.map(x=>x.querySelector(".name").innerText+(x.disabled?"(x)":""))')
        print('courses', names)
        await c.click('.course:not([disabled]) >> nth=0')
        await c.select_option('#fAlt', index=1)
        await c.click('[data-act=submit]'); print('err:', await c.inner_text('#formErr'))
        await c.fill('#fName','山田 花子'); await c.fill('#fPhone','090-1234-5678'); await c.fill('#fNote','くるみアレルギー')
        await c.screenshot(path='shots/c2.png',full_page=True)
        await c.click('[data-act=submit]'); await c.wait_for_selector('text=リクエストを受け付けました')
        await c.screenshot(path='shots/c3.png',full_page=True)
        await c.click('[data-act=back]'); await c.wait_for_selector('#mineCard')
        # reload uses cache + token
        t0=datetime.datetime.now()
        await c.reload(); await c.wait_for_selector('#mineCard')
        print('customer reload (cached) ms', int((datetime.datetime.now()-t0).total_seconds()*1000))
        # admin
        a=await ctx.new_page(); a.on('pageerror',lambda e:errs.append('a:'+str(e)))
        a.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await a.goto(B+'/admin'); await a.wait_for_selector('#pw')
        await a.fill('#pw','wrong'); await a.click('#loginBtn'); await a.wait_for_timeout(900); print('login err:', await a.inner_text('#loginErr'))
        await a.fill('#pw','pw-test-123'); await a.click('#loginBtn'); await a.wait_for_selector('[data-rid]')
        await a.screenshot(path='shots/a1.png',full_page=True)
        await a.click('[data-mode=offer]'); await a.select_option('[data-act=offer]', index=1)
        await a.screenshot(path='shots/a2.png',full_page=True)
        await a.click('[data-act=send]'); await a.wait_for_selector('text=未返信のリクエストはありません')
        # customer sees offer
        await c.goto(B+'/?view=offer&id=x'); await c.wait_for_selector('[data-act=accept]')
        await c.screenshot(path='shots/c4.png',full_page=True)
        await c.click('[data-act=accept]'); await c.wait_for_selector('text=ご予約確定')
        await c.click('[data-act=ask]'); await c.screenshot(path='shots/c5.png',full_page=True)
        await c.click('[data-act=noask]')
        # admin day view with blocks
        await a.click('.tab[data-tab=day]'); await a.wait_for_selector('#dayInput')
        await a.fill('#dayInput', target); await a.dispatch_event('#dayInput','change'); await a.wait_for_timeout(500)
        await a.click('[data-act=blockOpen]'); await a.fill('#bSeats','4'); await a.fill('#bMemo','Instagram 田中様 4名'); await a.click('[data-act=blockSave]'); await a.wait_for_timeout(500)
        await a.click('[data-act=blockOpen]'); await a.click('[data-act=blockType][data-type=stop]'); await a.fill('#bStart','19:00'); await a.click('[data-act=blockSave]'); await a.wait_for_timeout(500)
        await a.click('[data-act=addOpen]'); await a.fill('#aName','電話 太郎'); await a.select_option('#aSource','Instagram'); await a.click('[data-act=addSave]'); await a.wait_for_timeout(500)
        await a.screenshot(path='shots/a3.png',full_page=True)
        # calendar
        await a.click('.tab[data-tab=cal]'); await a.wait_for_selector('.week')
        await a.click(f'.day[data-date="{target}"]'); await a.click('[data-act=session][data-k=morning]'); await a.wait_for_timeout(500)
        await a.click('[data-act=weekly][data-w="1"][data-k=dinner]'); await a.wait_for_timeout(500)
        await a.screenshot(path='shots/a4.png',full_page=True)
        # menu
        await a.click('.tab[data-tab=menu]'); await a.wait_for_selector('[data-act=new]')
        await a.click('[data-act=new]'); await a.fill('#cName','週末ブランチ'); await a.fill('#cPrice','3000'); await a.select_option('#cPriceType','from')
        await a.click('[data-act=cSession][data-k=morning]'); await a.click('[data-act=cDay][data-d="3"]')
        await a.check('input[name=cMode][value=custom]'); await a.fill('#cDays','0'); await a.fill('#cTime','09:00')
        await a.screenshot(path='shots/a5.png',full_page=True)
        await a.click('[data-act=saveCourse]'); await a.wait_for_timeout(500)
        txt = await a.inner_text('#view'); print('menu has brunch:', '週末ブランチ' in txt, '¥3,000〜' in txt)
        await a.screenshot(path='shots/a6.png',full_page=True)
        # settings
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('#cutDays')
        await a.fill('#morning_last','12:00'); await a.click('[data-act=save]'); await a.wait_for_timeout(400); print('set err:', await a.inner_text('#setErr'))
        await a.fill('#morning_last','09:30'); await a.click('[data-act=save]'); await a.wait_for_timeout(400); print('set err2:', repr(await a.inner_text('#setErr')))
        await a.screenshot(path='shots/a7.png',full_page=True)
        # customer page reflects block/stop
        await c.reload(); await c.wait_for_selector('.stepper')
        await c.click(f'.day[data-date="{target}"]') if await c.locator(f'.day[data-date="{target}"]:not(.x)').count() else None
        await c.screenshot(path='shots/c6.png',full_page=True)
        # friend missing view
        f=await ctx.new_page(); await f.add_init_script(LIFF % ('false','jiro')); await f.goto(B+'/'); await f.wait_for_selector('.alert')
        await f.screenshot(path='shots/c7.png')
        print('errors', errs)
        await b.close()
asyncio.run(main())
