import asyncio, json, datetime, random
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        boot=await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json()
        cs={c['name']:c['id'] for c in boot['courses']}
        T=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
        sat=T+datetime.timedelta(days=(5-T.weekday())%7 or 7)
        random.seed(1)
        # 40人分の閲覧（Googleが多い、土曜の満席が多い、シェフおまかせは見られるが予約されない）
        for i in range(40):
            t=(await (await rq.post(B+'/api/login', data={'idToken':'u%d'%i})).json())['token']
            AU={'authorization':'Bearer '+t,'content-type':'application/json'}
            src=random.choice(['google','google','google','instagram','homepage'])
            ev=[{'kind':'open'}]
            if i%4!=0: ev.append({'kind':'date','date':(sat+datetime.timedelta(days=7*(i%3))).isoformat()})
            if i%3==0: ev.append({'kind':'blocked','date':sat.isoformat(),'extra':'×'})
            if i%2==0: ev.append({'kind':'time','date':sat.isoformat(),'time':'18:00'})
            if i%3==0: ev.append({'kind':'course','courseId':cs['シェフおまかせ']})
            await rq.post(B+'/api/track', headers=AU, data=json.dumps({'sid':'s','src':src,'events':ev}))
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        await a.goto(B+'/admin'); await a.wait_for_timeout(700)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis')
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('#cutDays')
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_selector('.insights'); await a.wait_for_timeout(300)
        for t in await a.eval_on_selector_all('.ins','e=>e.map(x=>x.innerText.replace(/\\n/g," ｜ "))'): print('・', t)
        await a.screenshot(path='shots/I1.png', full_page=True)
        # 更新ボタン
        t=(await (await rq.post(B+'/api/login', data={'idToken':'late'})).json())['token']
        await rq.post(B+'/api/track', headers={'authorization':'Bearer '+t,'content-type':'application/json'}, data=json.dumps({'sid':'s','src':'google','events':[{'kind':'open'}]}))
        before=await a.inner_text('#view .kpi >> nth=0')
        await a.click('[data-act=anReload]'); await a.wait_for_timeout(800)
        print('更新:', before.replace('\n',' '), '→', (await a.inner_text('#view .kpi >> nth=0')).replace('\n',' '))
        print('errors', errs)
        await b.close()
asyncio.run(main())
