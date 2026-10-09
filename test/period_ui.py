import asyncio, datetime, os
from playwright.async_api import async_playwright
# 設定＞メニュー：期間限定（何月何日〜何月何日）を決める（node test/serve_svc.mjs の仮のサーバーで動かす）
B='http://127.0.0.1:8787'
SHOTS='shots'
T=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
os.makedirs(SHOTS, exist_ok=True)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); a=await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2); errs=[]
        a.on('pageerror',lambda e:errs.append(str(e)))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'): await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis')
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=menu]'); await a.wait_for_timeout(300)
        await a.click('[data-act=new]'); await a.wait_for_timeout(200)
        await a.fill('#cName', '秋のイベントランチ'); await a.fill('#cPrice', '4500')
        f=(T+datetime.timedelta(days=10)).isoformat(); t=(T+datetime.timedelta(days=20)).isoformat()
        await a.fill('#cFrom', f); await a.fill('#cTo', t)
        await a.locator('#courseForm').screenshot(path=SHOTS+'/course_period_form.png')
        await a.click('[data-act=saveCourse]'); await a.wait_for_timeout(1200)
        row=a.locator('.course', has_text='秋のイベントランチ')
        print('一覧:', (await row.inner_text()).replace('\n',' / '))
        await row.screenshot(path=SHOTS+'/course_period_row.png')
        print('errors', errs)
        await b.close()
asyncio.run(main())
