import asyncio, json
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'hw1',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
NAMES=['x','養生ランチコース《メイン2種》','y']
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        cs=(await (await rq.post(B+'/admin/api/courses', headers=H, data='{}')).json())['courses']
        for c,n in zip(cs,NAMES):
            c['name']=n; c['visible']=1
            await rq.post(B+'/admin/api/saveCourse', headers=H, data=json.dumps(c))
        errs=[]
        for w in (320,360,390,430):
            c=await ctx.new_page(); c.on('pageerror',lambda e:errs.append(str(e)))
            await c.set_viewport_size({'width':w,'height':844})
            await c.add_init_script(LIFF); await c.goto(B+'/'); await c.wait_for_selector('.stepper')
            await c.click('.day:not(.x) >> nth=0'); await c.wait_for_timeout(400)
            await c.click('.slot:not([disabled]) >> nth=0'); await c.wait_for_timeout(400)
            n=await c.locator('.course:not([disabled])').count()
            for i in range(n):
                await c.click(f'.course:not([disabled]) >> nth={i}'); await c.wait_for_timeout(700)
                m=await c.eval_on_selector('#menuCard .h','''h=>{const r=document.createRange();r.selectNodeContents(h);
                  const t=[...h.childNodes].find(x=>x.nodeType==3); const rr=document.createRange(); rr.selectNodeContents(t);
                  const v=h.querySelector('.val');
                  return {titleLines: rr.getClientRects().length, val: v&&v.textContent, valH: v&&Math.round(v.getBoundingClientRect().height), over: v&&v.scrollHeight>v.clientHeight+1}}''')
                print(w, m)
            if w==360: await c.screenshot(path='/tmp/claude-0/-home-claude/dabc05cc-19f4-579f-b04b-0fcbedf00b64/scratchpad/hw360.png', clip={'x':0,'y':0,'width':360,'height':844}, full_page=False)
            await c.locator('#menuCard').screenshot(path=f'/tmp/claude-0/-home-claude/dabc05cc-19f4-579f-b04b-0fcbedf00b64/scratchpad/menu{w}.png')
            await c.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
