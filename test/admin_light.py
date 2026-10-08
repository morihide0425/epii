import asyncio, datetime
from playwright.async_api import async_playwright
# 管理画面を軽くした確認：作り直さない・スクロールが飛ばない・入力中の文字が消えない・押したらすぐ変わる
B='http://127.0.0.1:8787'
T=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()

async def slow(route):
    await asyncio.sleep(1.2); await route.continue_()

async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844})
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        a.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis'); await a.wait_for_timeout(300)
        calls=[]
        a.on('request', lambda r: calls.append(r.url.split('/')[-1]) if '/admin/api/' in r.url else None)

        # 予約タブ：明日を開いて、席を押さえる入力
        await a.click('.tab[data-tab=book]'); await a.wait_for_selector('.week')
        await a.wait_for_timeout(400)
        tm=(T+datetime.timedelta(days=1)).isoformat()
        await a.click(f'.wd[data-date="{tm}"]'); await a.wait_for_timeout(600)
        await a.evaluate("document.querySelector('.week').__mark=1")
        await a.click('[data-act=addToggle]'); await a.wait_for_selector('#holdForm')
        print('週の表示は作り直さない:', await a.evaluate("document.querySelector('.week').__mark===1"))
        await a.fill('#hName','テスト'); await a.focus('#hName'); await a.keyboard.type('さん')
        await a.evaluate("document.getElementById('holdForm').__mark=1")
        # アプリに戻ってきた（裏で取り直す）
        await a.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); await a.wait_for_timeout(700)
        print('取り直しても入力中の文字が残る:', await a.input_value('#hName'), '／入力中のまま:', await a.evaluate("document.activeElement.id"))
        chips=a.locator('[data-act=holdTime]')
        await chips.nth(await chips.count()-1).click(); await a.wait_for_timeout(300)
        print('時間を押しても入力欄を作り直さない:', await a.evaluate("document.getElementById('holdForm').__mark===1"), await a.input_value('#hName'))
        await a.click('[data-act=holdSave]'); await a.wait_for_timeout(1800)
        print('押さえた予約が一覧に出る:', 'テストさん' in await a.inner_text('#view'))

        # スクロール：予約タブの中で日を変えても位置はそのまま
        # （画面の外のボタンを押すと Playwright がスクロールしてしまうので、直接押す）
        # 読み込み済みの日と、まだ読み込んでいない日
        fresh=await a.evaluate("[...document.querySelectorAll('.wd')].map(b=>b.dataset.date).find(d=>!S.dayCache[d])")
        for d in [T.isoformat(), fresh]:
            await a.evaluate("window.scrollTo(0, 400)"); await a.wait_for_timeout(100)
            y0=await a.evaluate("scrollY")
            await a.evaluate("d=>document.querySelector(`.wd[data-date='${d}']`).click()", d); await a.wait_for_timeout(50)
            y1=await a.evaluate("scrollY"); await a.wait_for_timeout(900)
            print('日を変えてもスクロールはそのまま:', d, y0, y1, await a.evaluate("scrollY"))
        # タブを行き来すると、前に見ていた位置に戻る
        await a.evaluate("window.scrollTo(0, 500)"); await a.wait_for_timeout(100)
        yb=await a.evaluate("scrollY")
        await a.click('.tab[data-tab=set]'); await a.wait_for_selector('#cutDays')
        print('設定タブは上から:', await a.evaluate("scrollY"))
        await a.click('.tab[data-tab=book]'); await a.wait_for_timeout(800)
        print('予約タブに戻ると元の位置:', yb, await a.evaluate("scrollY"))

        # 来店のチェックは押した瞬間に変わる（保存が遅くても）
        await a.click('.tab[data-tab=today]'); await a.wait_for_timeout(800)
        await a.click('[data-act=goDay][data-date="%s"]' % T.isoformat())
        await a.wait_for_timeout(600)
        await a.click('[data-act=addToggle]'); await a.wait_for_selector('#holdForm')
        await a.fill('#hName','来店テスト'); await a.click('[data-act=holdSave]'); await a.wait_for_timeout(1800)
        await a.click('.tab[data-tab=today]'); await a.wait_for_selector('.chk'); await a.wait_for_timeout(500)
        await ctx.route('**/admin/api/arrive', slow)
        await a.click('.chk'); await a.wait_for_timeout(80)
        print('来店チェックがすぐ付く:', await a.evaluate("document.querySelector('.chk').classList.contains('on')"))
        await a.wait_for_timeout(1600)
        print('保存後も付いたまま:', await a.evaluate("document.querySelector('.chk').classList.contains('on')"))

        # 受付を止めるボタンも押した瞬間に変わる
        await ctx.route('**/admin/api/addBlock', slow)
        await a.click('.tab[data-tab=book]'); await a.wait_for_timeout(300)
        await a.click(f'.wd[data-date="{tm}"]'); await a.wait_for_timeout(800)
        await a.click('[data-act=planToggle]'); await a.wait_for_selector('[data-act=stopSlot]')
        t=await a.get_attribute('[data-act=stopSlot] >> nth=0','data-v')
        await a.click('[data-act=stopSlot] >> nth=0'); await a.wait_for_timeout(80)
        print('止めた時間がすぐ「停止中」:', t, await a.locator('[data-act=unstopSlot]').count())
        await a.wait_for_timeout(2500)
        print('保存後も停止中:', await a.locator('[data-act=unstopSlot]').count(), '／取り直した停止:', await a.evaluate("S.dayData.blocks.filter(b=>b.type==='stop').map(b=>b.start+(b.id.startsWith('new-')?'(仮)':'')).join(',')"))
        await a.click('[data-act=unstopSlot] >> nth=0'); await a.wait_for_timeout(1500)
        print('戻すと消える:', await a.locator('[data-act=unstopSlot]').count())

        # お客様：検索中も入力欄はそのまま
        await a.click('.tab[data-tab=cust]'); await a.wait_for_selector('#custQ')
        await a.focus('#custQ'); await a.keyboard.type('テスト'); await a.wait_for_timeout(1200)
        print('検索しても入力中のまま:', await a.input_value('#custQ'), await a.evaluate("document.activeElement.id"), '／見つかった:', await a.locator('.cust').count())
        n0=len(calls)
        await a.click('.cust >> nth=0'); await a.wait_for_selector('[data-act=closeCust]'); await a.wait_for_timeout(600)
        print('お客様を開いたときの通信:', calls[n0:])
        await a.click('[data-act=closeCust]'); await a.wait_for_timeout(600)
        print('一覧に戻ると検索はそのまま:', await a.input_value('#custQ'))
        print('errors', errs)
        await b.close()
asyncio.run(main())
