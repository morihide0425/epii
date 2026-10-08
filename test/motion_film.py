import asyncio, json
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'mo2',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
async def film(page, sel, name, n=6, gap=40):
    shots=[]
    for i in range(n):
        try:
            el=page.locator(sel).first
            await el.screenshot(path=f'shots/{name}_{i}.png', animations='allow')
            shots.append(f'shots/{name}_{i}.png')
        except Exception as e: pass
        await page.wait_for_timeout(gap)
    return shots
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        c=await ctx.new_page()
        await c.add_init_script(LIFF)
        await c.goto(B+'/'); await c.wait_for_selector('.stepper')
        days=await c.eval_on_selector_all('.day:not(.x)','e=>e.map(x=>x.dataset.date)')
        await c.click(f'.day[data-date="{days[1]}"]'); await c.wait_for_timeout(700)
        await c.click('.slot:not([disabled]) >> nth=1'); await c.wait_for_timeout(700)
        await c.locator('#timeCard').scroll_into_view_if_needed(); await c.wait_for_timeout(300)
        await c.evaluate("window.scrollToCard=()=>{}")
        await c.click('.slot:not([disabled]) >> nth=6')
        await film(c,'#timeCard','slot',6,10)
        await c.wait_for_timeout(600)
        await c.click('.course:not([disabled]) >> nth=0'); await c.wait_for_timeout(500)
        await c.fill('#fSei','山田'); await c.fill('#fMei','花子'); await c.fill('#fPhone','09012345678')
        await c.locator('[data-act=submit]').scroll_into_view_if_needed()
        await c.route('**/api/request', lambda route: asyncio.ensure_future(asyncio.sleep(0.8)).add_done_callback(lambda _: asyncio.ensure_future(route.continue_())))
        await c.click('[data-act=submit]')
        await film(c,'[data-act=submit]','btn',7,60)
        await b.close()
asyncio.run(main())
