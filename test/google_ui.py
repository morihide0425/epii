import asyncio, os, urllib.parse
from playwright.async_api import async_playwright
# 分析＞Google：つなぐ → Google（仮）から戻る → 表示回数・検索語句・口コミ（node test/serve_svc.mjs の仮のサーバーで動かす）
B='http://127.0.0.1:8787'
SHOTS='shots'
os.makedirs(SHOTS, exist_ok=True)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); a=await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2); errs=[]
        a.on('pageerror',lambda e:errs.append(str(e)))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'): await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis')
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_timeout(500)
        print('分析のタブ:', await a.locator('.anseg button').all_inner_texts())
        await a.click('[data-act=anView][data-v=google]')
        await a.wait_for_selector('[data-act=googleConnect]', timeout=10000)
        print('つなぐ前:', (await a.locator('[data-key=gconnect]').inner_text()).replace('\n',' / '))
        await a.locator('[data-key=gconnect]').screenshot(path=SHOTS+'/google_connect.png')
        # Googleのログイン画面の代わり：URLの state を使って、戻り先を開く
        async def fake(route):
            u=urllib.parse.urlparse(route.request.url); q=urllib.parse.parse_qs(u.query)
            await route.fulfill(status=302, headers={'location': q['redirect_uri'][0]+'?code=good&state='+urllib.parse.quote(q['state'][0])})
        await a.route('**/g/auth/**', fake)
        await a.click('[data-act=googleConnect]')
        await a.wait_for_selector('[data-key=greviews]', timeout=20000); await a.wait_for_timeout(600)
        print('戻ったURL:', a.url, '／開いている:', await a.locator('.anseg button.on').inner_text())
        print('タイル:', ' / '.join([t.replace('\n',' ') for t in await a.locator('.dtile').all_inner_texts()]))
        print('検索語句:', (await a.locator('[data-key=gwords]').inner_text()).replace('\n',' / '))
        print('口コミ:', (await a.locator('[data-key=greviews]').inner_text()).replace('\n',' / ')[:300])
        await a.screenshot(path=SHOTS+'/google_view.png', full_page=True)
        await a.click('[data-act=anView][data-v=dash]'); await a.wait_for_timeout(1200)
        print('まとめのタイル:', [t.replace('\n',' ') for t in await a.locator('.dtile').all_inner_texts() if 'Google' in t])
        print('errors', errs)
        await b.close()
asyncio.run(main())
