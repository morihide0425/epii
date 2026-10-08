import asyncio, os
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
        await a.fill('#bkOpen', '50000'); await a.fill('#bkCount', '30000'); await card.locator('[data-act=bookCash]').click(); await a.wait_for_timeout(1500)
        print('現金:', [t.replace('\n',' ') for t in await card.locator('.gcalc').first.locator('div').all_inner_texts() if t.startswith('現金')])
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
