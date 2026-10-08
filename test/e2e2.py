import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF = """window.liff = { init: async()=>{}, isLoggedIn:()=>true, login(){}, logout(){}, getIDToken:()=>'%s',
  getProfile: async()=>({displayName:'x'}), getFriendship: async()=>({friendFlag:%s}), isInClient:()=>true, closeWindow(){} };"""
def add(d,n): return (d+datetime.timedelta(days=n)).isoformat()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ctx=await b.new_context(viewport={'width':375,'height':812}, device_scale_factor=2)
        await ctx.route('**/static.line-scdn.net/**', lambda r: r.abort())
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        ck=r.headers['set-cookie'].split(';')[0]
        H={'x-epii':'1','content-type':'application/json','cookie':ck}
        boot=await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json()
        s=boot['settings']; s['seats']=6; s['maxGuests']=3; s['aheadDays']=40
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(s))
        courses=boot['courses']; din=[c for c in courses if c['name']=='季節の薬膳フレンチ'][0]
        today=(datetime.datetime.utcnow()+datetime.timedelta(hours=9)).date()
        d=today+datetime.timedelta(days=5)
        while d.weekday() not in (4,): d+=datetime.timedelta(days=1)   # Friday
        D=d.isoformat()
        byname={c['name']:c for c in courses}
        async def book(tok, time, g):
            cid = byname['モーニング']['id'] if time < '11:00' else byname['養生ランチ']['id'] if time < '17:00' else din['id']
            t=(await (await rq.post(B+'/api/login', data={'idToken':tok})).json())['token']
            res=await rq.post(B+'/api/request', headers={'authorization':'Bearer '+t,'content-type':'application/json'},
              data=json.dumps({'data':{'date':D,'time':time,'guests':g,'courseId':cid,'name':'テスト 太郎','phone':'09011112222'}}))
            return (await res.json())['ok']
        page=await ctx.new_page(); errs=[]; page.on('pageerror',lambda e:errs.append(str(e)))
        await page.add_init_script(LIFF % ('hana','false'))
        async def state(label):
            await page.goto(B+'/'); await page.wait_for_selector('.stepper')
            await page.evaluate("()=>{}")
            # guests 1
            await page.click('[data-act=guests][data-d="-1"]')
            if D[:7] != (await page.inner_text('.monthnav .min')).replace('年 ','-').replace('月','').zfill(7)[:7]:
                pass
            cal=await page.evaluate(f"()=>{{const b=document.querySelector('.day[data-date=\"{D}\"]');return b?b.innerText.replace(/\\n/g,''):'(not in month)'}}")
            if cal=='(not in month)':
                await page.click('[data-act=month][data-d="1"]')
                cal=await page.evaluate(f"()=>document.querySelector('.day[data-date=\"{D}\"]').innerText.replace(/\\n/g,'')")
            await page.click(f'.day[data-date="{D}"]')
            slots=await page.eval_on_selector_all('.slot','e=>e.map(x=>x.dataset.time+" "+x.innerText.split("\\n")[1])')
            print(label,'| calendar:',cal,'|',' / '.join(slots))
        await state('予約0人')
        await book('a','18:00',1); await state('18:00に1人')
        await book('b','18:00',1); await state('18:00に計2人')
        print('booked', await book('c','11:30',2), await book('d','08:30',2)); await state('朝昼夜すべて2人以上')
        print('booked', await book('e','13:00',2)); await state('13:00も2人')
        # full-page screenshots for line-break check
        await page.goto(B+'/'); await page.wait_for_selector('.stepper')
        await page.screenshot(path='shots/n1.png', full_page=True)
        html=await page.content()
        for w in ['Personnes','Heure','Coordonn','Vos r','Accès','Merci','déjeuner','Déjeuner','Dîner','FRENCH']:
            if w in html: print('FOUND', w)
        href=await page.get_attribute('a:has-text("地図を開く")','href'); print('map:',href)
        await page.click('[data-act=month][data-d="1"]') if D[:7]!=add(today,0)[:7] else None
        await page.click(f'.day[data-date="{D}"]'); await page.click('.slot:not([disabled]) >> nth=0'); await page.click('.course:not([disabled]) >> nth=0')
        await page.click('[data-act=submit]')
        await page.screenshot(path='shots/n2.png', full_page=True)
        print('err:', await page.inner_text('#formErr'))
        # done screen
        await page.evaluate("window.S && 0")
        await page.fill('#fName','山田 花子'); await page.fill('#fPhone','09012345678')
        await page.add_init_script(LIFF % ('hana','true'))
        await page.reload(); await page.wait_for_selector('.stepper')
        if D[:7]!=add(today,0)[:7]: await page.click('[data-act=month][data-d="1"]')
        await page.click(f'.day[data-date="{D}"]'); await page.click('.slot:not([disabled]) >> nth=0'); await page.click('.course:not([disabled]) >> nth=0')
        await page.fill('#fName','山田 花子'); await page.fill('#fPhone','09012345678')
        await page.click('[data-act=submit]'); await page.wait_for_selector('text=Thank you')
        await page.screenshot(path='shots/n3.png', full_page=True)
        await page.click('[data-act=back]'); await page.wait_for_selector('#mineCard')
        await page.screenshot(path='shots/n4.png')
        print('errors', errs)
        await b.close()
asyncio.run(main())
