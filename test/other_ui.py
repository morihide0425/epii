import asyncio, datetime, json, os, urllib.request
from playwright.async_api import async_playwright
# 設定＞その他（仕込みメモ・月の目標）、利益の見通し、口座の明細のまとめて登録（node test/serve_svc.mjs で起動した仮のサーバーで動かす）
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
    _,h=post('/admin/api/login', {'password':'pw-test-123'})
    A={'cookie':h['set-cookie'].split(';')[0],'x-epii':'1'}
    nd=T+datetime.timedelta(days=1)
    while nd.weekday() in (0, 1): nd+=datetime.timedelta(days=1)   # 月・火は定休日
    past=(T-datetime.timedelta(days=30)).isoformat()
    for body in [{'date':past,'time':'12:00','guests':2,'name':'佐藤 恵','phone':'090-1111-2222','courseName':'養生ランチ','note':'辛いもの苦手','force':True},
                 {'date':nd.isoformat(),'time':'11:30','guests':2,'name':'佐藤 恵','phone':'090-1111-2222','courseName':'養生ランチ','force':True},
                 {'date':nd.isoformat(),'time':'18:00','guests':2,'name':'山田 花子','phone':'090-1234-5678','courseName':'季節の薬膳フレンチ','note':'結婚記念日です。くるみアレルギーがあります','force':True}]:
        r,_=post('/admin/api/addPhone', body, A); assert r.get('ok', True) is not False, r
    return A, nd

async def main():
    A, nd = seed()
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        dialogs=[]
        def on_dialog(dg): dialogs.append(dg.message); asyncio.ensure_future(dg.accept())
        a.on('dialog', on_dialog)
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis'); await a.wait_for_timeout(1200)
        print('目標がオフのときは今日に出ない:', await a.locator('.goalbar').count())

        # 設定＞その他
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=other]')
        await a.wait_for_selector('[data-key=prepcard]', timeout=10000); await a.wait_for_timeout(300)
        print('入れることの選択肢:', await a.locator('[data-act=prepPart]').count(), '／最初は全部オン:', await a.locator('[data-act=prepPart].on').count())
        await a.click('[data-act=prepOn]'); await a.wait_for_timeout(800)
        print('オンにすると保存:', (post('/admin/api/prep', {}, A))[0]['cfg']['on'])
        await a.click('[data-act=prepPreview]'); await a.wait_for_timeout(200)
        print('見本：Claudeが考え中:', await a.locator('[data-key=prepcard] .aithink').count())
        await a.wait_for_selector('.prepview', timeout=10000); await a.wait_for_timeout(300)
        pv=await a.locator('.prepview').inner_text()
        print('見本:', pv.replace('\n',' / ')[:400])
        await a.locator('[data-key=prepcard]').screenshot(path=SHOTS+'/prep_card.png')
        # 入れることを足す（Claudeにまとめてもらう項目・毎回同じ文の項目）
        await a.click('[data-act=prepCustNew]'); await a.wait_for_timeout(200)
        await a.fill('#pcTitle', 'ドリンクの準備'); await a.fill('#pcBody', 'ノンアルコールを頼みそうな方を書き出して')
        await a.click('[data-act=prepCustOk]'); await a.wait_for_timeout(200)
        await a.click('[data-act=prepCustNew]'); await a.wait_for_timeout(200)
        await a.click('[data-act=prepCustKind][data-v=text]'); await a.wait_for_timeout(100)
        await a.fill('#pcTitle', '閉店後'); await a.fill('#pcBody', '冷蔵庫の温度を確認')
        await a.click('[data-act=prepCustOk]'); await a.wait_for_timeout(200)
        print('足した項目:', await a.locator('.custrow').count(), '／ボタン:', [t for t in await a.locator('[data-act=prepCustOn]').all_inner_texts()])
        await a.click('[data-act=prepPreview]'); await a.wait_for_timeout(1500)
        pv2=await a.locator('.prepview').inner_text()
        print('足した項目が見本に:', '■ ドリンクの準備（Claude）' in pv2, '■ 閉店後' in pv2)
        await a.locator('[data-key=prepcard]').screenshot(path=SHOTS+'/prep_custom.png')
        await a.click('[data-act=prepPart][data-v=cheer]'); await a.fill('#prepNote', 'パンの発注を確認')
        await a.click('[data-act=prepSave]'); await a.wait_for_timeout(1000)
        cfg=(post('/admin/api/prep', {}, A))[0]['cfg']
        print('保存:', cfg['parts']['cheer'], cfg['note'], cfg['time'], [x['title'] for x in cfg['custom']])
        # 月の目標
        await a.locator('[data-key=goalcard]').scroll_into_view_if_needed()
        await a.click('[data-act=goalKind][data-v=profit]'); await a.wait_for_timeout(200)
        await a.click('#goalAmt'); await a.keyboard.type('300000'); await a.wait_for_timeout(200)
        print('打つとすぐ計算:', (await a.locator('[data-key=goalcalc]').inner_text()).replace('\n',' / '))
        print('打っている欄はそのまま:', await a.input_value('#goalAmt'), await a.evaluate("document.activeElement.id"))
        await a.click('[data-act=goalAdvice]'); await a.wait_for_timeout(200)
        print('Claudeに聞く：歩く:', await a.locator('[data-key=goalcard] svg.clawd').count())
        await a.wait_for_selector('[data-act=goalUse]', timeout=10000)
        print('Claudeの目安:', (await a.locator('[data-key=goalcard] .aimemo').inner_text()).replace('\n',' / '))
        await a.click('[data-act=goalOn]'); await a.wait_for_timeout(200)
        await a.click('[data-act=goalSave]'); await a.wait_for_timeout(1200)
        g=(post('/admin/api/goal', {}, A))[0]
        print('保存した目標:', g['cfg'], '必要な売上', g['status']['need'], '残り営業日', g['status']['leftDays'])
        await a.locator('[data-key=goalcard]').screenshot(path=SHOTS+'/goal_card.png')

        # 今日の画面に進み具合
        await a.click('.tab[data-tab=today]'); await a.wait_for_timeout(300)
        await a.wait_for_selector('.goalbar', timeout=10000); await a.wait_for_timeout(500)
        print('今日の目標:', (await a.locator('.goalbar').inner_text()).replace('\n',' / '))
        await a.locator('[data-key=sales]').screenshot(path=SHOTS+'/goal_today.png')

        # 分析：利益
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_timeout(300)
        await a.wait_for_selector('.dtiles', timeout=15000); await a.wait_for_timeout(500)
        print('まとめのタイル:', ' / '.join([x.replace('\n',' ') for x in await a.locator('.dtile').all_inner_texts()]))
        await a.click('[data-act=anView][data-v=money]')
        await a.wait_for_selector('[data-key=outlook]', timeout=15000); await a.wait_for_timeout(800)
        print('KPI:', ' / '.join([x.replace('\n',' ') for x in await a.locator('.kpis.money .kpi').all_inner_texts()][:3]))
        print('見通し:', (await a.locator('[data-key=outlook]').inner_text()).replace('\n',' / '))
        print('月ごとの利益:', await a.locator('.pchart .pl').all_inner_texts(), '／利益の棒:', await a.locator('.pchart .b3').count())
        await a.locator('[data-key=outlook]').screenshot(path=SHOTS+'/outlook.png')
        await a.locator('.card', has_text='月ごとの売上・経費・利益').screenshot(path=SHOTS+'/profit_chart.png')

        # 口座の明細：おすすめのまま、まとめて登録
        await a.click('.tab[data-tab=today]'); await a.wait_for_timeout(300)
        await a.click('[data-act=rcptOpen]')
        await a.wait_for_selector('[data-act=txSaveAll]', timeout=15000); await a.wait_for_timeout(300)
        n0=await a.locator('.txr').count()
        print('まとめて登録:', await a.locator('[data-act=txSaveAll]').inner_text(), '／明細', n0)
        await a.click('[data-act=txSaveAll]'); await a.wait_for_timeout(2500)
        print('登録したあと:', await a.locator('.txr').count(), '／確認:', dialogs[-1][:40] if dialogs else '')
        print('errors', errs)
        await b.close()

asyncio.run(main())
