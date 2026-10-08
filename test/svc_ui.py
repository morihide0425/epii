import asyncio, datetime, json, io, os, urllib.request
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw
# Claude・Square・マネーフォワードの画面の確認（node test/serve_svc.mjs で起動した仮のサーバーで動かす）
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
                 {'date':T.isoformat(),'time':'11:30','guests':2,'name':'佐藤 恵','phone':'090-1111-2222','courseName':'養生ランチ','force':True},
                 {'date':T.isoformat(),'time':'18:30','guests':2,'name':'高橋 誠','phone':'','courseName':'シェフおまかせ','force':True}]:
        r,_=post('/admin/api/addPhone', body, A); assert r.get('ok', True) is not False, r
    return A

def receipt_jpeg(path):
    im=Image.new('RGB',(600,900),'white'); d=ImageDraw.Draw(im)
    for i,t in enumerate(['RECEIPT','carrot 300','lotus 480','TOTAL 6480']): d.text((60,80+i*60),t,fill='black')
    im.save(path,'JPEG')

async def phrase_ok(a, sel):
    # 文節のまとまりが、行の途中で折れていないか（まとまりの高さが1行分か）
    return await a.evaluate("""sel => { const bad=[]; document.querySelectorAll(sel+' .ph').forEach(p=>{ const lh=parseFloat(getComputedStyle(p).lineHeight)||20; const box=p.closest('div'); if(p.getBoundingClientRect().height>lh*1.5 && p.getBoundingClientRect().width < box.clientWidth-4) bad.push(p.textContent); }); return bad; }""", sel)

async def main():
    A=seed()
    receipt_jpeg(SHOTS+'/receipt_in.jpg')
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
        await ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        await ctx.grant_permissions(['clipboard-read','clipboard-write'])
        a=await ctx.new_page(); errs=[]; a.on('pageerror',lambda e:errs.append(str(e)))
        dialogs=[]
        def on_dialog(dg): dialogs.append(dg.message); asyncio.ensure_future(dg.accept())
        a.on('dialog', on_dialog)
        await a.goto(B+'/admin'); await a.wait_for_timeout(600)
        if await a.is_visible('#pw'):
            await a.fill('#pw','pw-test-123'); await a.click('#loginBtn')
        await a.wait_for_selector('.kpis'); await a.wait_for_timeout(1500)

        # (1) 返事の下書き：Claudeの一言が色付きで入る
        card=a.locator('[data-rid]').first
        await a.wait_for_selector('[data-rid] mark.add', timeout=8000)
        print('一言が入る:', await card.locator('mark.add').inner_text())
        print('タグ:', await card.locator('.aitag').inner_text())
        print('折れているまとまり:', await phrase_ok(a, '[data-rid] .draft'))
        await card.screenshot(path=SHOTS+'/ai_draft.png')
        # 押すと直せる
        await card.locator('.draft').click(); await a.wait_for_timeout(200)
        ta=card.locator('textarea.draft')
        print('押すと文面の欄になる:', await ta.count(), '／フォーカス:', await a.evaluate("document.activeElement.tagName"))
        txt=await ta.input_value()
        print('送る文に区切りの印がない:', '｜' not in txt, '／一言が入っている:', 'おめでとうございます' in txt)
        await a.keyboard.type('（追記）'); await a.wait_for_timeout(200)
        print('直すと「元に戻す」が出る:', await card.locator('[data-act=resetText]').count())
        await card.locator('[data-act=resetText]').click(); await a.wait_for_timeout(300)
        print('元に戻すと下書きに戻る:', await card.locator('div.draft mark.add').count())
        # いつもの文面 → 一言なし、戻す
        await card.locator('[data-act=aiOff]').click(); await a.wait_for_timeout(300)
        print('いつもの文面:', await card.locator('mark.add').count(), await card.locator('[data-act=aiOn]').count())
        await card.locator('[data-act=aiOn]').click(); await a.wait_for_timeout(300)
        print('一言を足す:', await card.locator('mark.add').count())
        # お断りに切り替える → 別の一言
        await card.locator('[data-act=mode][data-mode=ng]').click(); await a.wait_for_timeout(80)
        print('切り替え中は読み込みの帯:', await card.locator('.waitbar').count())
        await a.wait_for_timeout(1200)
        print('お断りの一言:', await card.locator('mark.add').inner_text())
        # 書き直す
        await card.locator('[data-act=aiAgain]').click(); await a.wait_for_timeout(1200)
        print('書き直し後:', await card.locator('mark.add').count())
        await card.locator('[data-act=mode][data-mode=ok]').click(); await a.wait_for_timeout(500)

        # (4) 来店前メモ
        await a.wait_for_selector('.aimemo .ph', timeout=8000)
        memo=a.locator('.aimemo').first
        print('来店前メモ:', (await memo.inner_text()).replace('\n',' '))
        lst=a.locator('.card', has_text='今日の予約')
        await lst.screenshot(path=SHOTS+'/ai_memo.png')

        # 売上（Square）
        await a.wait_for_selector('[data-key=sales] .sum3', timeout=8000)
        sales=a.locator('[data-key=sales]')
        print('売上:', (await sales.locator('.sum3').inner_text()).replace('\n',' '))
        n0=await sales.locator('.pay').count()
        print('予約のない会計:', n0)
        await sales.scroll_into_view_if_needed()
        await sales.screenshot(path=SHOTS+'/sales.png')
        await sales.locator('[data-act=payPick]').first.click(); await a.wait_for_timeout(200)
        await a.fill('#payQ','佐藤'); await a.wait_for_timeout(900)
        print('お客様の候補:', await sales.locator('[data-act=payCust]').count())
        await sales.screenshot(path=SHOTS+'/sales_pick.png')
        await sales.locator('[data-act=payCust]').first.click(); await a.wait_for_timeout(120)
        print('押すと縮んで消える:', await a.evaluate("(()=>{const e=document.querySelector('.pay');return e?Math.round(e.getBoundingClientRect().height):-1})()"))
        await a.wait_for_timeout(1200)
        print('片付いた:', await sales.locator('.pay').count(), '←', n0)
        cust,_=post('/admin/api/customers', {'q':'佐藤'}, A)
        print('来店回数に足された:', [(c['name'], c['total'], c['extra']) for c in cust['customers']])
        await sales.locator('[data-act=paySkip]').first.click(); await a.wait_for_timeout(1200)
        print('このまま:', await sales.locator('.pay').count())

        # レシートの登録
        await a.evaluate("window.scrollTo(0,0)")
        await a.click('[data-act=rcptOpen]'); await a.wait_for_timeout(300)
        print('レシートの画面:', await a.inner_text('#ttl'), '／一覧:', await a.locator('.rlist').count())
        await a.screenshot(path=SHOTS+'/rcpt_pick.png')
        # 3枚まとめて選ぶ → 裏で読み取り（同時に2枚まで）
        await a.set_input_files('#rcptLib', [SHOTS+'/receipt_in.jpg']*3); await a.wait_for_timeout(150)
        print('順番待ち:', await a.locator('.rq').count(), '／読み取り中の表示:', await a.locator('.rq .waitbar').count() > 0)
        await a.wait_for_function("document.querySelectorAll('.rq [data-act=rqSave]').length===3", timeout=10000); await a.wait_for_timeout(500)
        print('読み取った:', ' / '.join([t.replace('\n',' ') for t in await a.locator('.rq .rphoto').all_inner_texts()]))
        await a.screenshot(path=SHOTS+'/rcpt_queue.png', full_page=True)
        # 続けて撮る（カメラの欄はいつでも押せる）
        await a.set_input_files('#rcptCam', SHOTS+'/receipt_in.jpg'); await a.wait_for_timeout(1500)
        print('続けて撮ると増える:', await a.locator('.rq').count())
        # 自信のない1枚目を確かめる（現金で払った）
        await a.locator('.rq').first.locator('[data-act=rqOpen]').click(); await a.wait_for_timeout(200)
        q1=await a.evaluate("document.querySelector('.rq.on').dataset.key.slice(3)")
        print('確かめる欄:', await a.evaluate("[...document.querySelectorAll('.rq.on .check')].map(e=>e.dataset.rf)"), '／払い方:', await a.locator(f'#rf-pay-{q1} option:checked').inner_text())
        print('科目の説明:', await a.locator(f'#rf-acc-{q1} option:checked').inner_text(), '／Claudeの理由:', (await a.locator('.rq.on .aitag + span, .rq.on .sub:has(.aitag)').first.inner_text()).replace('\n',' '))
        print('登録番号:', await a.input_value(f'#rf-inv-{q1}'))
        # Claudeに聞く → おすすめの科目にする
        await a.locator('.rq.on [data-act=askOpen]').click(); await a.wait_for_timeout(200)
        await a.locator('.rq.on [data-act=askPreset]').first.click(); await a.wait_for_timeout(1200)
        print('Claudeの答え:', (await a.locator('.rq.on .ask-a').last.inner_text()).replace('\n',' '))
        await a.screenshot(path=SHOTS+'/rcpt_ask.png', full_page=True)
        await a.locator('.rq.on [data-act=askUse]').click(); await a.wait_for_timeout(300)
        print('科目が変わる:', await a.locator(f'#rf-acc-{q1} option:checked').inner_text())
        await a.fill(f'#askIn-{q1}', '税率はどれ？'); await a.press(f'#askIn-{q1}', 'Enter'); await a.wait_for_timeout(1200)
        print('続けて聞ける:', await a.locator('.rq.on .ask-q').count())
        await a.select_option(f'#rf-acc-{q1}', label='仕入高（料理に使う食材・飲み物・お酒）'); await a.wait_for_timeout(100)
        await a.fill(f'#rf-memo-{q1}','にんじん・れんこん'); await a.wait_for_timeout(100)
        await a.select_option(f'#rf-rate-{q1}','mixed'); await a.wait_for_timeout(200)
        await a.fill(f'#rf-a8-{q1}','5,400'); await a.wait_for_timeout(100)
        print('混在の説明:', (await a.locator(f'#rf-a8-{q1} + .sub').inner_text()))
        await a.select_option(f'#rf-rate-{q1}','8'); await a.wait_for_timeout(200)
        await a.locator('.rq.on [data-act=rqSave]').click(); await a.wait_for_timeout(1800)
        print('1枚登録後:', await a.locator('.rq').count(), '／一覧:', await a.locator('.rlist .it').count())
        # 残りはカード（デビット）で払った：¥6,580 は口座の明細と結びつき、ほかは明細待ち
        print('まとめて登録のボタン:', await a.locator('[data-act=rqSaveAll]').inner_text())
        await a.click('[data-act=rqSaveAll]'); await a.wait_for_timeout(2500)
        print('まとめて登録後:', await a.locator('.rq').count(), '／一覧:', ' / '.join([t.replace('\n',' ') for t in await a.locator('.rlist .it .nm').all_inner_texts()]))
        # 口座から出たお金：Claudeのおすすめの科目で登録
        await a.wait_for_selector('.txr [data-appear^=txai]', timeout=8000)
        print('口座の明細:', ' / '.join([t.replace('\n',' ')[:40] for t in await a.locator('.txr').all_inner_texts()]))
        await a.locator('[data-key=txcard]').screenshot(path=SHOTS+'/tx.png')
        n0=await a.locator('.txr').count()
        await a.locator('.txr [data-act=txSave]').first.click(); await a.wait_for_timeout(1500)
        print('登録すると消える:', await a.locator('.txr').count(), '←', n0)
        await a.screenshot(path=SHOTS+'/rcpt_done.png', full_page=True)
        await a.click('[data-act=rcptClose]'); await a.wait_for_timeout(300)
        print('今日に戻る:', await a.inner_text('#ttl'), '／ボタン:', (await a.locator('.rcbtn').inner_text()).replace('\n',' '))

        await a.evaluate("window.scrollTo(0,0)")
        await a.screenshot(path=SHOTS+'/today_top.png')

        # 分析：まとめ（いちばん大事なこと）→ 分野ごと
        await a.click('.tab[data-tab=set]'); await a.wait_for_timeout(300)
        await a.click('[data-act=setPart][data-v=stats]'); await a.wait_for_timeout(400)
        await a.wait_for_selector('.dtiles', timeout=15000)
        await a.wait_for_selector('[data-key="ai:summary"] .ins', timeout=15000); await a.wait_for_timeout(600)
        print('まとめの数字:', ' / '.join([x.replace('\n',' ') for x in await a.locator('.dtile').all_inner_texts()]))
        print('まとめの気づき:', await a.locator('[data-key="ai:summary"] .ins').count(), '／分野:', await a.locator('.secrow').count())
        await a.fill('#aiNote', '食材は主に阿倍野青果で買う'); await a.click('[data-act=noteSave]'); await a.wait_for_timeout(800)
        await a.screenshot(path=SHOTS+'/dash.png', full_page=True)
        await a.locator('.secrow', has_text='売上・経費').click(); await a.wait_for_timeout(200)
        await a.wait_for_selector('.kpis.money', timeout=15000)
        await a.wait_for_selector('[data-key="ai:money"] .ins', timeout=15000); await a.wait_for_timeout(600)
        print('KPI:', ' / '.join([x.replace('\n',' ') for x in await a.locator('.kpis.money .kpi').all_inner_texts()]))
        print('売上・経費の気づき:', [t.split('\n')[0] for t in await a.locator('[data-key="ai:money"] .ins b').all_inner_texts()], '／折れているまとまり:', await phrase_ok(a, '.insights'))
        await a.screenshot(path=SHOTS+'/money.png', full_page=True)
        await a.click('[data-act=moneyPer][data-v=last]'); await a.wait_for_timeout(1200)
        print('先月:', (await a.locator('.kpis.money .kpi').first.inner_text()).replace('\n',' '))
        await a.click('[data-act=secAi][data-v=money]'); await a.wait_for_timeout(100)
        print('読み直す：読み込み中:', await a.locator('[data-key="ai:money"] .waitbar').count() > 0)
        await a.wait_for_timeout(1500)
        print('読み直したあと:', await a.locator('[data-key="ai:money"] .ins').count())
        await a.click('[data-act=anView][data-v=site]'); await a.wait_for_timeout(1500)
        print('予約の気づき:', [t.split('\n')[0] for t in await a.locator('[data-key="ai:booking"] .ins b').all_inner_texts()])

        # Instagramの文案
        await a.click('[data-act=anView][data-v=ig]'); await a.wait_for_timeout(1500)
        igd=a.locator('[data-key=igd]')
        await igd.scroll_into_view_if_needed()
        print('告知の候補:', await igd.locator('[data-act=igSel]').count())
        await igd.locator('[data-act=igSel]').last.click(); await a.wait_for_timeout(200)
        await igd.locator('[data-act=igMake]').click(); await a.wait_for_timeout(1500)
        print('文案:', (await igd.locator('.igtext').inner_text())[:40].replace('\n',' '), '／書き方:', await igd.locator('.stylebox .hl').count())
        await igd.locator('[data-act=igKind][data-v=post]').click(); await a.wait_for_timeout(300)
        print('投稿はまだ作っていない:', await igd.locator('[data-act=igMake]').inner_text())
        await igd.locator('[data-act=igMake]').click(); await a.wait_for_timeout(1500)
        print('投稿の文:', await igd.locator('.hash').count())
        # 直接直す
        await igd.locator('div.igtext').click(); await a.wait_for_timeout(200)
        print('押すと欄になる:', await igd.locator('textarea#igTa').count(), await a.evaluate("document.activeElement.id"))
        await a.keyboard.type('（直した）'); await a.wait_for_timeout(1200)
        await igd.locator('[data-act=igCopy]').click(); await a.wait_for_timeout(200)
        clip=await a.evaluate("navigator.clipboard.readText()")
        print('コピーに区切りの印がない・直した文:', '｜' not in clip, '（直した）' in clip)
        await igd.locator('[data-act=igKind][data-v=story]').click(); await a.wait_for_timeout(300)
        st0=await igd.locator('.igtext').inner_text()
        await igd.locator('[data-act=igAgain]').click(); await a.wait_for_timeout(1500)
        st1=await igd.locator('.igtext').inner_text()
        print('ストーリーだけ書き直す:', st0[:8], '→', st1[:8])
        await igd.locator('[data-act=igKind][data-v=post]').click(); await a.wait_for_timeout(300)
        print('投稿は直したまま:', '（直した）' in await igd.locator('.igtext').inner_text())
        await igd.locator('[data-act=igKind][data-v=story]').click(); await a.wait_for_timeout(300)
        await igd.locator('[data-act=igDel]').click(); await a.wait_for_timeout(900)
        print('消すと作るボタンに戻る:', await igd.locator('[data-act=igMake]').count())
        await igd.screenshot(path=SHOTS+'/ig_draft.png')
        print('dialogs', dialogs)
        print('errors', errs)
        await b.close()

asyncio.run(main())
