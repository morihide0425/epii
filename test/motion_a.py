import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        a.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis'); await a.wait_for_timeout(300)
        ind=lambda: a.evaluate("(()=>{const r=document.getElementById('tabind').getBoundingClientRect();return [Math.round(r.left),Math.round(r.width)]})()")
        print('タブの印（今日）:', await ind())
        await a.click('.tab[data-tab=set]')
        seq=[]
        for i in range(8): seq.append(await ind()); await a.wait_for_timeout(30)
        print('タブの印の移動（左,幅）:', seq)
        await a.wait_for_selector('#cutDays')
        # 設定の切り替え（選択の印の移動）
        await a.click('[data-act=setPart][data-v=menu]'); await a.wait_for_timeout(40)
        print('設定の切り替えで形が動く:', await a.locator('.m-ghost').count())
        await a.wait_for_timeout(600)
        # スイッチ
        k=lambda: a.evaluate("(()=>{const k=document.querySelector('.sw .knob');const r=k.getBoundingClientRect();return [Math.round(r.left),Math.round(r.width)]})()")
        print('スイッチ（前）:', await k())
        await a.click('.sw >> nth=0')
        seq=[]
        for i in range(8): seq.append(await k()); await a.wait_for_timeout(30)
        print('スイッチのつまみ（左,幅）:', seq)
        await a.wait_for_timeout(500)
        await a.click('.sw >> nth=0'); await a.wait_for_timeout(600)
        # トースト
        tw=await a.evaluate("(()=>{const t=document.getElementById('toast');return getComputedStyle(t).clipPath})()")
        print('お知らせの形:', tw[:40])
        # 席を押さえる → 丸 → チェック
        T=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
        D=(T+datetime.timedelta(days=(5-T.weekday())%7 or 7)).isoformat()
        await a.click('.tab[data-tab=book]'); await a.wait_for_selector('.week')
        await a.evaluate(f"goDay('{D}')"); await a.wait_for_selector('[data-act=addToggle]')
        await a.click('[data-act=addToggle]'); await a.wait_for_selector('#holdForm')
        await a.click('[data-act=holdTime] >> nth=0'); await a.wait_for_timeout(300)
        await a.click('[data-act=holdTime] >> nth=4'); await a.wait_for_timeout(40)
        print('時間の切り替えで形が動く:', await a.locator('.m-ghost').count())
        await a.wait_for_timeout(500)
        await a.fill('#hName','田村')
        await a.click('[data-act=holdSave]'); await a.wait_for_timeout(120)
        print('押さえるボタン:', await a.evaluate("(()=>{const b=document.querySelector('[data-act=holdSave]');return b?[b.classList.contains('m-busy'),Math.round(b.getBoundingClientRect().width)]:'もう描き替え済み'})()"))
        await a.wait_for_timeout(1200)
        print('押さえ後:', '田村' in await a.inner_text('#view'))
        print('バーが伸びる設定:', await a.locator('[data-grow] [data-g]').count(), '本')
        # 分析のグラフの吹き出し
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('[data-act=setPart]')
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_selector('.chart .col'); await a.wait_for_timeout(500)
        await a.hover('.chart .col >> nth=-1'); await a.wait_for_timeout(250)
        print('吹き出し:', await a.evaluate("(()=>{const t=document.querySelector('.m-tip.show');return t?t.textContent:null})()"))
        await a.click('[data-act=anReload]'); await a.wait_for_timeout(150)
        print('最新にするボタン:', await a.evaluate("(()=>{const b=document.querySelector('[data-act=anReload]');return b?b.classList.contains('m-busy'):'描き替え済み'})()"))
        await a.wait_for_timeout(1200)
        print('errors', errs)
        await b.close()
asyncio.run(main())
