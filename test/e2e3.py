import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ctx=await b.new_context(viewport={'width':390,'height':844})
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        boot=await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json()
        din=[c for c in boot['courses'] if c['name']=='季節の薬膳フレンチ'][0]
        today=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
        d=today+datetime.timedelta(days=5)
        while d.weekday()!=5: d+=datetime.timedelta(days=1)
        D=d.isoformat()
        t=(await (await rq.post(B+'/api/login', data={'idToken':'hana'})).json())['token']
        res=await (await rq.post(B+'/api/request', headers={'authorization':'Bearer '+t,'content-type':'application/json'},
            data=json.dumps({'data':{'date':D,'time':'18:00','guests':2,'courseId':din['id'],'name':'山田 花子','phone':'09012345678'}}))).json()
        rid=res['reservation']['id']
        await rq.post(B+'/admin/api/reply', headers=H, data=json.dumps({'id':rid,'mode':'ok','text':'確定'}))
        await rq.post(B+'/admin/api/addPhone', headers=H, data=json.dumps({'date':D,'time':'12:00','guests':2,'name':'電話 次郎','source':'電話'}))
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        dialogs=[]
        a.on('dialog', lambda dg: (dialogs.append(dg.message), asyncio.ensure_future(dg.accept())))
        await a.goto(B+'/admin'); await a.wait_for_timeout(800)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis')
        await a.evaluate(f"goDay('{D}')"); await a.wait_for_selector('[data-act=edit]')
        # LINE予約を変更
        await a.click(f'[data-act=edit][data-id="{rid}"]'); await a.wait_for_selector('#editPanel')
        print('before change textarea:', await a.locator('#eText').count(), '|', (await a.inner_text('#editPanel')).split('\n')[-3])
        await a.fill('#eName','山田 花子さま'); 
        print('name only textarea:', await a.locator('#eText').count())
        await a.select_option('#eTime','19:00')
        await a.fill('#eGuests','3')
        txt=await a.input_value('#eText'); print('template:\n'+txt[:170])
        await a.screenshot(path='shots/e1.png', full_page=True)
        await a.click('[data-act=editSave]'); await a.wait_for_timeout(1500)
        print('dialogs:', dialogs)
        body=await a.inner_text('#view'); print('after: 19:00 山田 花子さま 3名' in body.replace('\n',' ') or body[:300])
        # 電話予約を変更（LINEなし）
        items=await a.eval_on_selector_all('[data-act=edit]','e=>e.map(x=>x.dataset.id)')
        ph=[i for i in items if i!=rid][0]
        await a.click(f'[data-act=edit][data-id="{ph}"]'); await a.wait_for_selector('#editPanel')
        print('phone panel:', 'LINE以外' in await a.inner_text('#editPanel'))
        await a.fill('#eGuests','30'); await a.click('[data-act=editSave]'); await a.wait_for_timeout(1500)
        print('dialogs2:', dialogs[-2:])
        # 日付を変える → 移動
        await a.click(f'[data-act=edit][data-id="{rid}"]'); await a.wait_for_selector('#editPanel')
        nd=(d+datetime.timedelta(days=7)).isoformat()
        await a.fill('#eDate', nd); await a.dispatch_event('#eDate','change')
        print('date template has new date:', nd[5:7].lstrip('0')+'月' in await a.input_value('#eText'))
        await a.click('[data-act=editSave]'); await a.wait_for_timeout(1500)
        print('moved to', await a.evaluate('S.day'))
        await a.screenshot(path='shots/e2.png', full_page=True)
        print('errors', errs)
        await b.close()
asyncio.run(main())
