import asyncio, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'look',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':900}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        pg=await ctx.new_page(); await pg.add_init_script(LIFF)
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
        await pg.goto(B+'/'); await pg.wait_for_selector('.stepper')
        await pg.click('.day:not(.x) >> nth=2'); await pg.wait_for_timeout(200)
        await pg.click('.slot:not([disabled]) >> nth=-1'); await pg.wait_for_timeout(200)
        await pg.click('.course:not([disabled]) >> nth=0'); await pg.wait_for_timeout(300)
        await pg.screenshot(path='shots/look.png', full_page=True)
        print('errors', errs)
        await b.close()
asyncio.run(main())
