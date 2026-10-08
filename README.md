# 開発用ソース

ふだんの設定には使いません。`worker.js` を作り直すときだけ使います。

- `src/server.js`：サーバーの処理
- `src/shared.js`：予約ページとサーバーで共通の計算（席・締切）
- `src/motion.js`：画面の動き（予約ページと管理画面で共通）
- `src/customer.html`：お客様の予約ページ
- `src/admin.html`：管理画面
- `build.py`：上の5つとロゴ・アイコンをまとめて `dist/worker.js` を作ります（Python と Pillow が必要です）

## テストの準備

```
npm install          # miniflare（APIテスト用）
python3 build.py     # dist/worker.js を作る
node test/api.mjs    # APIテスト
```

画面のテストには Python の Playwright が必要です。フォルダ名に日本語が入っているとテストが動かないので、英字のフォルダで作業してください。
