import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF = """window.liff = { init: async()=>{}, isLoggedIn:()=>true, login(){}, logout(){}, getIDToken:()=>'hana',
  getProfile: async()=>({displayName:'x'}), getFriendship: async()=>({friendFlag:true}), isInClient:()=>true, closeWindow(){} };"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844})
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        boot=await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json()
        din=[c for c in boot['courses'] if c['name']=='季節の薬膳フレンチ'][0]
        today=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
        d=today+datetime.timedelta(days=6)
        while d.weekday()!=5: d+=datetime.timedelta(days=1)
        D=d.isoformat(); D2=(d+datetime.timedelta(days=7)).isoformat()
        t=(await (await rq.post(B+'/api/login', data={'idToken':'hana'})).json())['token']
        AU={'authorization':'Bearer '+t,'content-type':'application/json'}
        res=await (await rq.post(B+'/api/request', headers=AU, data=json.dumps({'data':{'date':D,'time':'18:00','guests':2,'courseId':din['id'],'name':'山田 花子','phone':'09012345678'}}))).json()
        rid=res['reservation']['id']
        await rq.post(B+'/admin/api/reply', headers=H, data=json.dumps({'id':rid,'mode':'ok','text':'確定'}))
        c=await ctx.new_page(); errs=[]; c.on('pageerror',lambda e:errs.append('c:'+str(e)))
        c.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await c.add_init_script(LIFF)
        await c.goto(B+'/'); await c.wait_for_selector('#mineCard')
        print('card:', (await c.inner_text('#mineCard')).replace('\n',' / ')[:200])
        await c.screenshot(path='shots/g1.png', full_page=True)
        await c.click('[data-act=startChange]'); await c.wait_for_selector('[data-act=stopChange]')
        print('change mode:', (await c.inner_text('.note')).replace('\n',' / ')[:120])
        print('hidden sections:', await c.locator('text=お客様情報').count(), await c.locator('text=第2希望').count())
        if D2[:7]!=D[:7]: await c.click('[data-act=month][data-d="1"]')
        await c.wait_for_selector(f'.day[data-date="{D2}"]')
        await c.click(f'.day[data-date="{D2}"]'); await c.click('.slot:not([disabled]) >> nth=-1'); await c.click('.course:not([disabled]) >> nth=0')
        await c.screenshot(path='shots/g2.png', full_page=True)
        await c.click('[data-act=submit]'); await c.wait_for_selector('text=変更をお申し込み中')
        print('after request:', (await c.inner_text('#mineCard')).replace('\n',' / ')[:220])
        await c.screenshot(path='shots/g3.png', full_page=True)
        # admin
        a=await ctx.new_page(); a.on('pageerror',lambda e:errs.append('a:'+str(e)))
        a.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await a.goto(B+'/admin'); await a.wait_for_timeout(700)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('[data-cid]')
        print('badge:', await a.inner_text('#reqBadge'))
        print('admin card:', (await a.inner_text('[data-cid]')).replace('\n',' / ')[:260])
        await a.screenshot(path='shots/g4.png', full_page=True)
        await a.click('[data-act=csend]'); await a.wait_for_timeout(900)
        print('after reply:', (await a.inner_text('#view')).replace('\n',' / ')[:90])
        await c.reload(); await c.wait_for_selector('#mineCard')
        print('customer after:', (await c.inner_text('#mineCard')).replace('\n',' / ')[:200])
        # menu form shows change rule
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('#cutDays'); await a.click('[data-act=setPart][data-v=menu]'); await a.wait_for_selector('[data-act=new]')
        print('menu list has 変更は:', '変更は' in await a.inner_text('#view'))
        await a.click('[data-act=edit] >> nth=1'); await a.wait_for_selector('#courseForm')
        await a.check('input[name=cChg][value=custom]'); await a.wait_for_timeout(300)
        await a.fill('#cChgDays','1'); await a.click('[data-act=saveCourse]'); await a.wait_for_timeout(600)
        print('saved:', '変更は1日前まで' in await a.inner_text('#view'))
        await a.screenshot(path='shots/g5.png', full_page=True)
        await a.click('[data-act=setPart][data-v=rules]'); await a.wait_for_selector('#chgDays')
        await a.screenshot(path='shots/g6.png', full_page=True)
        print('errors', errs)
        await b.close()
asyncio.run(main())
