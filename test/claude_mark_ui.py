import asyncio, datetime, json, os, urllib.request
from playwright.async_api import async_playwright
# Claudeのマーク（回る・歩く）とCSVの書き出しの確認（node test/serve_svc.mjs で起動した仮のサーバーで動かす）
B='http://127.0.0.1:8787'
T=(datetime.datetime.now(datetime.UTC)+datetime.timedelta(hours=9)).date()
SHOTS='shots'
os.makedirs(SHOTS, exist_ok=True)

def post(path, body, headers=None):
    req=urllib.request.Request(B+path, data=json.dumps(body).encode(), headers={'content-type':'application/json', **(headers or {})}, method='POST')
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read()), r.headers
    except urllib.error.HTTPError as e: return json.loads(e.read()), e.headers

def seed():
    d,_=post('/api/login', {'idToken':'hana'})
    auth={'authorization':'Bearer '+d['token']}
    cs={c['name']:c for c in d['data']['courses']}
    sat=T+datetime.timedelta(days=5)
    while sat.weekday()!=5: sat+=datetime.timedelta(days=1)
    r,_=post('/api/request', {'data':{'date':sat.isoformat(),'time':'18:00','guests':2,'courseId':cs['季節の薬膳フレンチ']['id'],'sei':'山田','mei':'花子','phone':'090-1234-5678','note':'結婚記念日です。くるみアレルギーがあります'}}, auth)
    assert r['ok'], r
    _,h=post('/admin/api/login', {'password':'pw-test-123'})
    A={'cookie':h['set-cookie'].split(';')[0],'x-epii':'1'}
    past=(T-datetime.timedelta(days=20)).isoformat()
    for body in [{'date':past,'time':'12:00','guests':2,'name':'佐藤 恵','phone':'090-1111-2222','courseName':'養生ランチ','note':'辛いもの苦手','force':True},
                 {'date':T.isoformat(),'time':'11:30','guests':2,'name':'佐藤 恵','phone':'090-1111-2222','courseName':'養生ランチ','force':True}]:
        r,_=post('/admin/api/addPhone', body, A); assert r.get('ok', True) is not False, r
    return A

def anim(a, sel):
    return a.evaluate("sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).animationName : 'なし'; }", sel)

async def slow(route):
    await asyncio.sleep(2.5)
    await route.continue_()

async def main():
    seed()
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, accept_downloads=True)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis'); await a.wait_for_timeout(1500)

        # 返事の下書き：タグと、足した一言の頭にマーク
        await a.wait_for_selector('[data-rid] mark.add svg.spark', timeout=8000)
        card=a.locator('[data-rid]').first
        print('下書きのタグ:', await card.locator('.dlabel .aitag').inner_text(), '／マーク:', await card.locator('.dlabel .aitag svg.spark').count())
        print('一言の頭のマーク:', await card.locator('mark.add svg.spark').count())
        print('ふだんの動き:', await anim(a, '[data-rid] .dlabel svg.spark'))
        sz=await a.evaluate("(()=>{const r=document.querySelector('[data-rid] mark.add svg.spark').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()")
        print('マークの大きさ:', sz)
        await card.screenshot(path=SHOTS+'/mark_draft.png')
        # 考えているあいだは回る
        await a.route('**/admin/api/aiReply', slow)
        await card.locator('[data-act=aiAgain]').click(); await a.wait_for_timeout(300)
        print('書き直し中：回る:', await anim(a, '[data-rid] .dlabel svg.spark'), '／文:', (await card.locator('.aithink').inner_text()).replace('\n',''))
        await card.screenshot(path=SHOTS+'/mark_draft_wait.png')
        await a.wait_for_timeout(3000)
        print('書き終わると止まる:', await anim(a, '[data-rid] .dlabel svg.spark'))
        await a.unroute('**/admin/api/aiReply')

        # 来店前メモ
        await a.wait_for_selector('.aimemo svg.spark', timeout=8000)
        print('来店前メモ:', (await a.locator('.aimemo .mlbl').first.inner_text()))
        await a.locator('.aimemo').first.screenshot(path=SHOTS+'/mark_memo.png')

        # 分析：読み直すあいだはキャラクターが歩く
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_timeout(400)
        await a.wait_for_selector('[data-key="ai:summary"] .ins', timeout=15000); await a.wait_for_timeout(600)
        print('分析のタグ:', await a.locator('[data-key="ai:summary"] h2 .aitag').inner_text())
        await a.route('**/admin/api/analysisAi', slow)
        await a.click('[data-act=secAi][data-v=summary]'); await a.wait_for_timeout(500)
        box=a.locator('[data-key="aw:summary"]')
        print('歩くキャラクター:', await box.locator('svg.clawd').count(), '／足の動き:', await anim(a, '[data-key="aw:summary"] .clawd .l1'), '／移動:', await anim(a, '[data-key="aw:summary"] .mv'))
        x0=await a.evaluate("document.querySelector('[data-key=\"aw:summary\"] .clawd').getBoundingClientRect().left")
        await a.wait_for_timeout(700)
        x1=await a.evaluate("document.querySelector('[data-key=\"aw:summary\"] .clawd').getBoundingClientRect().left")
        print('歩いて進む:', round(x0), '→', round(x1))
        w=await a.evaluate("(()=>{const b=document.querySelector('[data-key=\"aw:summary\"]');const c=b.querySelector('.clawd').getBoundingClientRect();const r=b.getBoundingClientRect();return [Math.round(c.width),Math.round(c.height),c.right<=r.right+1]})()")
        print('大きさ・はみ出さない:', w)
        await a.locator('[data-key="ai:summary"]').screenshot(path=SHOTS+'/mark_walk.png')
        await a.wait_for_timeout(2800)
        print('読み終わると消える:', await a.locator('svg.clawd').count())
        await a.unroute('**/admin/api/analysisAi')
        # Claudeと話す：返事の頭に「Claude」
        await a.route('**/admin/api/aiChat', slow)
        await a.locator('[data-act=chatPreset]').first.click(); await a.wait_for_timeout(400)
        print('話す：考え中:', await a.locator('[data-key=chat] svg.clawd').count(), await anim(a, '[data-key=chat] h2 svg.spark'))
        await a.locator('[data-key=chat]').screenshot(path=SHOTS+'/mark_chat_wait.png')
        await a.wait_for_timeout(2800)
        print('話す：答え:', (await a.locator('[data-key=chat] .ask-a .who').last.inner_text()))
        await a.locator('[data-key=chat]').screenshot(path=SHOTS+'/mark_chat.png')
        await a.unroute('**/admin/api/aiChat')

        # お客様：CSVで書き出す
        await a.click('.tab[data-tab=cust]'); await a.wait_for_timeout(800)
        await a.click('[data-act=csvOpen]'); await a.wait_for_timeout(300)
        sheet=a.locator('[data-key=cexp]')
        print('書き出しの画面:', (await sheet.locator('[data-act=csvCust]').inner_text()))
        await sheet.screenshot(path=SHOTS+'/csv_sheet.png')
        async with a.expect_download() as dl:
            await sheet.locator('[data-act=csvCust]').click()
        d=await dl.value
        raw=open(await d.path(),'rb').read()
        text=raw.decode('utf-8')
        print('お客様のCSV:', d.suggested_filename, '／BOM:', raw[:3]==b'\xef\xbb\xbf', '／1行目:', text.lstrip('﻿').split('\r\n')[0][:40])
        print('佐藤さんの行:', [l for l in text.split('\r\n') if l.startswith('佐藤')][0][:60])
        async with a.expect_download() as dl:
            await sheet.locator('[data-act=csvRes][data-v=all]').click()
        d=await dl.value
        text=open(await d.path(),'rb').read().decode('utf-8')
        print('予約のCSV:', d.suggested_filename, '／行数:', len([l for l in text.split('\r\n') if l]) - 1)
        # 絞り込みのまま書き出す
        await a.click('[data-act=csvClose]'); await a.wait_for_timeout(200)
        await a.click('[data-act=custFilter][data-v=next]'); await a.wait_for_timeout(300)
        await a.click('[data-act=csvOpen]'); await a.wait_for_timeout(300)
        print('絞り込み中:', await a.locator('[data-act=csvCust]').inner_text())
        async with a.expect_download() as dl:
            await a.locator('[data-act=csvCust]').click()
        d=await dl.value
        text=open(await d.path(),'rb').read().decode('utf-8')
        print('絞り込みのCSV:', len([l for l in text.split('\r\n') if l]) - 1, '名')

        # 動きを減らす設定では止まる
        ctx2=await b.new_context(viewport={'width':390,'height':844}, reduced_motion='reduce')
        a2=await ctx2.new_page()
        await a2.goto(B+'/admin'); await a2.wait_for_timeout(600)
        if await a2.is_visible('#pw'):
            await a2.fill('#pw','pw-test-123'); await a2.click('#loginBtn')
        await a2.wait_for_selector('[data-rid] mark.add svg.spark', timeout=8000)
        print('動きを減らす設定:', await anim(a2, '[data-rid] mark.add svg.spark'))
        print('errors', errs)
        await b.close()

asyncio.run(main())
