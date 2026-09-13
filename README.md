# YouTube 要約ツール

YouTube の URL を貼り付けると、動画の字幕をもとに内容を日本語で要約する Web ツールです。
Cloudflare Workers 上で動作し、要約には Cloudflare Workers AI（無料枠あり）を使います。

## できること

- YouTube の各種 URL（`watch` / `youtu.be` / `shorts` / `embed` / `live`）に対応
- 要約の長さを「短め / 標準 / 詳しく」から選択
- 要約が生成される様子をリアルタイム表示（ストリーミング）
- 要約中の `[m:ss]` をクリックすると、YouTube の該当箇所へジャンプ
- 長い動画は字幕を分割して読み込み、最後に統合して要約

## 動作の仕組み

```
ブラウザ
  │  POST /api/summarize  { url, length }
  ▼
Cloudflare Worker
  │
  ├─ 1. URL から動画ID を抽出
  │
  ├─ 2. 字幕を取得 (src/youtube.js)
  │      InnerTube ANDROID → IOS → WEB → watch ページ の順に試行
  │      取得できた字幕トラックを json3 形式でダウンロード
  │
  ├─ 3. 要約 (src/summarize.js)
  │      短い動画 : 字幕をそのまま要約
  │      長い動画 : 分割 → パートごとに要約 → 統合して最終要約
  │
  └─ 4. SSE で進捗と本文を逐次返却
```

### ファイル構成

| パス | 役割 |
| --- | --- |
| `src/index.js` | Worker のエントリポイント。ルーティングと SSE 配信 |
| `src/youtube.js` | 動画ID の抽出と字幕取得 |
| `src/summarize.js` | 字幕の分割と Workers AI による要約 |
| `public/index.html` | 画面（HTML / CSS / JS を1ファイルに同梱、外部依存なし） |
| `wrangler.jsonc` | Cloudflare の設定（AI バインディング、モデル名など） |

## デプロイ（GitHub 連携で自動デプロイ）

Cloudflare のダッシュボードからこのリポジトリを接続すると、`main` に push するたび自動でデプロイされます。

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログイン
2. 左メニューの **Compute (Workers)** → **Create** → **Workers** タブ → **Import a repository**
3. GitHub アカウントを接続し、`Nais-W/App1` を選択
4. ビルド設定を以下のようにする

   | 項目 | 値 |
   | --- | --- |
   | Project name | `yt-summarizer`（任意） |
   | Production branch | `main` |
   | Build command | （空欄のままでOK） |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` |

5. **Create and deploy** を押す

デプロイが完了すると `https://yt-summarizer.<サブドメイン>.workers.dev` で公開されます。

以降は `main` への push をトリガーに自動で再デプロイされます。
Workers AI のバインディングは `wrangler.jsonc` に定義済みなので、ダッシュボード側での追加設定は不要です。

### ローカルで動かす

```bash
npm install
npx wrangler login     # 初回のみ（Workers AI はリモート実行が必要）
npm run dev            # http://localhost:8787
```

> Workers AI はローカルでも Cloudflare 側で実行されるため、`wrangler login` によるログインが必要です。

## 設定

`wrangler.jsonc` の `vars` で変更できます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SUMMARY_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 要約に使うモデル。24,000トークンのコンテキストを持つ |
| `PREFERRED_LANGS` | `ja,en` | 字幕を探す言語の優先順。先頭ほど優先。手動字幕を自動生成字幕より優先します |

モデルを変えたい場合は、[Workers AI のモデル一覧](https://developers.cloudflare.com/workers-ai/models/) から
テキスト生成モデルの ID を選んで `SUMMARY_MODEL` に設定してください。

## 制限と注意点

### 字幕が必要です

このツールは**動画の字幕**を読んで要約します。音声そのものは解析しません。
字幕（自動生成を含む）が付いていない動画は要約できません。

### YouTube 側にブロックされる可能性があります

YouTube は、データセンターの IP アドレスからの字幕取得を制限することがあります。
Cloudflare Workers もデータセンターから通信するため、**動画情報の取得が拒否される場合があります**。

そのため字幕取得は 4 つの経路（InnerTube の ANDROID / IOS / WEB クライアント、watch ページ）を
順番に試す作りにしてあり、すべて失敗した場合は `FETCH_BLOCKED` エラーとして、
どの経路がどう失敗したかを画面と `wrangler tail` のログに出します。

もし本番環境で恒常的にブロックされる場合は、以下のような対応が必要になります。

- 外部の文字起こし API（Supadata、Youtube Transcript API など）を経由する
- 字幕取得部分だけを、データセンター以外の環境から実行する

### 無料枠について

Workers AI には 1 日あたりの無料枠（Neurons）があります。
長い動画を何本も要約すると枠を使い切る可能性があるため、
公開して不特定多数に使わせる場合は、**アクセス制限やレート制限の追加を検討してください**。
現在の実装には認証もレート制限も入っていません。

### その他

- ライブ配信中の動画には対応していません（配信終了後は可能）
- 限定公開・メンバー限定・年齢制限のある動画は取得できないことがあります
- 非常に長い動画（おおよそ 4 時間以上）は、字幕の一部を抜粋して要約します（画面に注記が出ます）
- 要約は AI が生成したものです。正確性は保証されません

## トラブルシューティング

デプロイ後にエラーが出る場合は、ログを確認してください。

```bash
npx wrangler tail
```

| 画面に出るエラー | 原因と対処 |
| --- | --- |
| 字幕がありません | その動画に字幕が付いていません。別の動画でお試しください |
| YouTube から動画情報を取得できませんでした | YouTube 側のブロックの可能性。ログの `attempts` で失敗した経路を確認 |
| この動画は再生できません | 限定公開・年齢制限など。取得できません |
| 要約の生成に失敗しました | Workers AI 側のエラー。無料枠を超えていないかダッシュボードで確認 |
