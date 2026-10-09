import asyncio, os
from playwright.async_api import async_playwright
# 今日＞経費・明細を登録：銀行の入金・出金とSquareの明細を、登録するか対象外にする（node test/serve_svc.mjs の仮のサーバーで動かす）
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
        await a.wait_for_selector('[data-act=rcptOpen]')
        print('今日のボタン:', (await a.locator('[data-act=rcptOpen]').inner_text()).replace('\n',' / '))
        await a.click('[data-act=rcptOpen]')
        await a.wait_for_selector('[data-key=inccard] .txr', timeout=20000); await a.wait_for_timeout(500)
        inc=a.locator('[data-key=inccard]')
        print('銀行に入ったお金:', (await inc.locator('h2').inner_text()).replace('\n',' '))
        for r in await inc.locator('.txr').all(): print('  ', (await r.inner_text()).replace('\n',' / ')[:200])
        await inc.screenshot(path=SHOTS+'/inc_card.png')
        # Squareの入金と同じお金 → 対象外にする
        sq=inc.locator('.txr', has_text='ﾌﾘｺﾐ')
        await sq.locator('[data-act=txExclude]').click(); await a.wait_for_timeout(1500)
        print('対象外にした:', await inc.locator('.txr', has_text='ﾌﾘｺﾐ').count(), '／確認:', dialogs[-1].replace('\n',' '))
        # 利息 → 事業主借のまま登録
        r2=inc.locator('.txr', has_text='ﾘｿｸ')
        print('利息の科目:', await r2.locator('select option:checked').inner_text())
        await r2.locator('[data-act=incSave]').click(); await a.wait_for_timeout(1500)
        print('登録した:', await inc.locator('.txr', has_text='ﾘｿｸ').count())
        # 銀行から出たお金にも対象外
        out=a.locator('[data-key=txcard]')
        print('出金の対象外ボタン:', await out.locator('[data-act=txExclude]').count(), '／見出し:', (await out.locator('h2').inner_text()).replace('\n',' '))
        # Square：1件ずつ見て対象外
        sqc=a.locator('[data-key=squn]')
        await sqc.locator('[data-act=sqAll]').click(); await a.wait_for_timeout(300)
        print('Squareの1件ずつ:', await sqc.locator('[data-act=txExclude]').count())
        await sqc.screenshot(path=SHOTS+'/squn_each.png')
        n0=await sqc.locator('[data-act=txExclude]').count()
        await sqc.locator('[data-act=txExclude]').last.click(); await a.wait_for_timeout(1500)
        print('Squareを対象外:', n0, '→', await sqc.locator('[data-act=txExclude]').count())
        print('errors', errs)
        await b.close()
asyncio.run(main())
