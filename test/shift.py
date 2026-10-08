import asyncio, json
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'sh1',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};
window.__ls=[];new PerformanceObserver(l=>{for(const e of l.getEntries()){window.__ls.push({v:e.value,src:(e.sources||[]).map(s=>{const n=s.node;return (n&&n.nodeType==1?(n.tagName+'.'+n.className):(n?n.nodeName+':'+(n.textContent||'').slice(0,20):'?'))+' '+JSON.stringify([s.previousRect.x,s.previousRect.y,s.currentRect.x,s.currentRect.y])})})}}).observe({type:'layout-shift',buffered:true});"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        await ctx.route('**/static.line-scdn.net/**', lambda r: r.abort())
        rq=ctx.request
        r=await rq.post(B+'/admin/api/login', data={'password':'pw-test-123'})
        H={'x-epii':'1','content-type':'application/json','cookie':r.headers['set-cookie'].split(';')[0]}
        st=(await (await rq.post(B+'/admin/api/boot', headers=H, data='{}')).json())['settings']
        for d in st['weekly']: st['weekly'][d]=['morning','lunch','dinner']
        await rq.post(B+'/admin/api/saveSettings', headers=H, data=json.dumps(st))
        c=await ctx.new_page(); await c.add_init_script(LIFF); await c.goto(B+'/'); await c.wait_for_selector('.stepper'); await c.wait_for_timeout(800)
        async def step(name, sel):
            await c.evaluate('window.__ls=[]')
            await c.tap(sel); await c.wait_for_timeout(900)
            print(name, json.dumps(await c.evaluate('window.__ls'), ensure_ascii=False)[:600])
        await step('guests+', '[data-act=guests][data-d="1"]')
        await step('filter', '.fchip >> nth=2')
        await step('filter all', '.fchip >> nth=0')
        await step('date', '.day:not(.x) >> nth=0')
        await step('time', '.slot:not([disabled]) >> nth=0')
        await step('course', '.course:not([disabled]) >> nth=0')
        await step('month', '[data-act=month][data-d="1"]')
        await b.close()
asyncio.run(main())
