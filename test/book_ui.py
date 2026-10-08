import asyncio, datetime, os, re
from playwright.async_api import async_playwright
# 帳簿のチェック（今日＞経費を登録）。node test/serve_svc.mjs で起動した仮のサーバーで動かす
B='http://127.0.0.1:8787'
SHOTS='shots'
os.makedirs(SHOTS, exist_ok=True)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); a=await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2); errs=[]
        a.on('pageerror',lambda e:errs.append(str(e)))
        dialogs=[]
        def on_dialog(dg): dialogs.append(dg.message); asyncio.ensure_future(dg.accept())
        a.on('dialog', on_dialog)
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'): await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('[data-act=rcptOpen]'); await a.click('[data-act=rcptOpen]')
        # Squareの未入力：まず1件だけ → 次からまとめて
        await a.wait_for_selector('[data-key=squn]', timeout=20000); await a.wait_for_timeout(400)
        sq=a.locator('[data-key=squn]')
        print('Squareの未入力:', (await sq.inner_text()).replace('\n',' / ')[:300])
        await sq.screenshot(path=SHOTS+'/squn.png')
        await sq.locator('[data-act=sqEnter]').click(); await a.wait_for_timeout(1800)
        print('1件登録したあと:', await sq.locator('[data-act=sqEnter]').inner_text())
        await sq.locator('[data-act=sqEnter]').click(); await a.wait_for_timeout(2000)
        print('まとめて登録したあと:', (await a.locator('[data-key=squn]').inner_text()).replace('\n',' / ')[:200] if await a.locator('[data-key=squn]').count() else 'カードなし')
        await a.wait_for_selector('[data-key=book] .bk', timeout=20000); await a.wait_for_timeout(500)
        card=a.locator('[data-key=book]')
        print('直すところ:', await card.locator('.bk').count(), '／見出し:', [t.replace('\n',' ') for t in await card.locator('.bk .why').all_inner_texts()])
        print('合っているか:', (await card.locator('.gcalc').first.inner_text()).replace('\n',' / ')[:300])
        print('根拠:', [t for t in await card.locator('.bk .basis').all_inner_texts()][:4])
        await card.locator('[data-act=bookDays]').first.click(); await a.wait_for_timeout(300)
        print('売上の理由:', [t.replace('\n',' ') for t in await card.locator('.causes li').all_inner_texts()][:3])
        print('1月1日（自動）:', await a.input_value('#bkOpen'), '／赤字の行:', await card.locator('.gcalc .neg').all_inner_texts())
        print('現金がマイナスの知らせ:', await card.locator('.bk', has_text='現金がマイナス').count())
        await a.fill('#bkCount', '30000'); await card.locator('[data-act=bookCash]').click(); await a.wait_for_timeout(1500)
        print('現金:', [t.replace('\n',' ') for t in await card.locator('.gcalc').first.locator('div').all_inner_texts() if t.startswith('現金') or t.startswith('数えた')])
        print('12/31でないとき:', await card.locator('.cashadj').inner_text(), '／ボタン:', await card.locator('[data-act=cashAdjOpen]').count())
        await card.locator('.cashin').screenshot(path=SHOTS+'/book_cashin.png')
        await card.locator('.gcalc').first.screenshot(path=SHOTS+'/book_cash.png')
        # 12月31日に数えたことにする（サーバーの返事の日付だけ書き換える）
        ye=str(datetime.date.today().year)+'-12-31'
        async def as_ye(route):
            r=await route.fetch(); j=await r.json(); j['cash']['countedAt']=ye
            await route.fulfill(response=r, json=j)
        await a.route('**/admin/api/bookCash', as_ye)
        await card.locator('[data-act=bookCash]').click(); await a.wait_for_timeout(1500)
        print('12/31：はじめは小さなボタンだけ:', await card.locator('[data-act=cashAdjOpen]').inner_text(), '／登録ボタン:', await card.locator('[data-act=bookCashAdj]').count())
        await card.locator('[data-act=cashAdjOpen]').click(); await a.wait_for_timeout(300)
        go=card.locator('[data-act=bookCashAdj]')
        print('開いた:', (await card.locator('.cashadj').inner_text()).replace('\n',' / '))
        print('選ぶ前は押せない:', await go.is_disabled())
        await card.locator('[data-act=cashAdjHow][data-v=misc]').click()
        print('選んだだけでは押せない:', await go.is_disabled())
        await a.fill('#cashAdjAmt', '1,234')
        print('ちがう金額では押せない:', await go.is_disabled())
        sent=[]
        async def adj(route):
            sent.append(route.request.post_data_json); r=await route.fetch(); await route.fulfill(response=r)
        await a.route('**/admin/api/bookCashAdjust', adj)
        diff=(await card.locator('.cashadj small').first.inner_text())
        amt=re.search(r'¥([\d,]+)', diff).group(1)
        await a.fill('#cashAdjAmt', amt)
        print('差の金額を入れると押せる:', not await go.is_disabled())
        await card.locator('.cashadj').screenshot(path=SHOTS+'/book_cashadj.png')
        await go.click(); await a.wait_for_timeout(1500)
        print('送った:', sent, '／確認:', dialogs[-1].replace('\n',' ') if dialogs else '')
        await a.unroute('**/admin/api/bookCash'); await a.unroute('**/admin/api/bookCashAdjust')
        await card.screenshot(path=SHOTS+'/book.png')
        first=card.locator('.bk', has_text='八百鮮')
        print('科目の提案:', await first.locator('select').input_value())
        await first.locator('[data-act=bookFix]').click(); await a.wait_for_timeout(1500)
        print('直したあと:', await card.locator('.bk', has_text='八百鮮').count())
        await card.locator('.bk', has_text='近鉄').locator('[data-act=bookFix][data-to=現金]').click(); await a.wait_for_timeout(1500)
        print('現金で払った:', await card.locator('.bk', has_text='近鉄').count())
        await card.locator('[data-act=bookAi]').click(); await a.wait_for_timeout(200)
        print('Claudeが見ている:', await card.locator('svg.clawd').count())
        await a.wait_for_selector('[data-key=book] .bk .why svg.spark', timeout=10000)
        print('Claudeの指摘:', (await card.locator('.bk:has(.why svg.spark)').first.inner_text()).replace('\n',' / '))
        await card.screenshot(path=SHOTS+'/book_ai.png')
        print('dialogs', dialogs, 'errors', errs)
        await b.close()
asyncio.run(main())
