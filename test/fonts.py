import asyncio, json, datetime
from playwright.async_api import async_playwright
B='http://127.0.0.1:8787'
LIFF="""window.liff={init:async()=>{},isLoggedIn:()=>true,login(){},logout(){},getIDToken:()=>'font',
 getProfile:async()=>({displayName:'x'}),getFriendship:async()=>({friendFlag:true}),isInClient:()=>true,closeWindow(){}};"""
SAMPLES=[
 ("A 今のまま（端末の標準）", '"Zen Maru Gothic",sans-serif', '"Zen Maru Gothic",serif', '"Cormorant Garamond",serif'),
 ("B ゴシック＋明朝の見出し", '"Zen Kaku Gothic New",sans-serif', '"Shippori Mincho",serif', '"Cormorant Garamond",serif'),
 ("C 全体を明朝に", '"Shippori Mincho",serif', '"Shippori Mincho",serif', '"Cormorant Garamond",serif'),
 ("D 古典的な明朝の見出し", '"Zen Kaku Gothic New",sans-serif', '"Zen Old Mincho",serif', '"Cormorant Garamond",serif'),
 ("E 手書き風の見出し", '"Zen Kaku Gothic New",sans-serif', '"Klee One",serif', '"Cormorant Garamond",serif'),
 ("F すっきりゴシックのみ", '"Noto Sans JP",sans-serif', '"Noto Sans JP",sans-serif', '"Cormorant Garamond",serif'),
]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':1000}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        pg=await ctx.new_page(); await pg.add_init_script(LIFF)
        for i,(label,g,m,l) in enumerate(SAMPLES):
            await pg.goto(B+'/'); await pg.wait_for_selector('.stepper')
            await pg.add_style_tag(content=f":root{{--gothic:{g};--mincho:{m};--latin:{l};}}")
            await pg.click('.day:not(.x) >> nth=2')
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'shots/f{i}.png', full_page=True)
        await b.close()
asyncio.run(main())
