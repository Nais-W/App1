/**
 * Gemini API を使って YouTube 動画を直接要約する。
 *
 * 字幕ベースの経路 (youtube.js + summarize.js) には3つの弱点がある。
 *   1. Cloudflare のIPからだと YouTube に bot 判定されることがある
 *   2. 字幕は音声しか拾えず、画面に表示された情報が落ちる
 *   3. 自動生成字幕は固有名詞を聞き間違える
 *
 * Gemini は YouTube の URL を渡すと Google 側が動画を取得し、
 * 音声と映像の両方を解析する。そのため3つとも起きない。
 *
 * 代わりに API キーと、無料枠 (1日あたり動画8時間) の制約が付く。
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Gemini を使える状態かどうか */
export function geminiAvailable(env) {
  return Boolean(env.GEMINI_API_KEY);
}

/** Gemini の呼び出しに失敗した理由を、利用者に説明できる形で持ち回す */
export class GeminiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.detail = detail;
  }
}

export const GEMINI_PRESETS = {
  short: { bullets: '4〜6個', maxTokens: 2000, detail: false },
  standard: { bullets: '6〜9個', maxTokens: 4000, detail: true },
  detailed: { bullets: '8〜12個', maxTokens: 8000, detail: true },
};

/**
 * 動画の題名と投稿者を取得する。
 *
 * oEmbed は player API と違って認証も内部APIも使わないため、
 * bot 判定を受けにくい。取れなくても要約はできるので、失敗は無視する。
 */
export async function fetchVideoInfo(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;

    const data = await res.json();
    return { title: data.title ?? null, author: data.author_name ?? null };
  } catch {
    return null;
  }
}

/** 話題の目次ではなく中身を書かせ、かつ創作を防ぐための共通ルール */
const RULES = [
  '## 書き方のルール',
  '',
  '話題を示すだけの書き方は禁止です。必ず「何と言っていたか」「何が映っていたか」を書いてください。',
  '',
  '禁止する書き方の例:',
  '- レビュー機能の追加について話している',
  '- 価格戦略について比較している',
  '',
  '書くべき形の例:',
  '- レビュー依頼は購入直後ではなく、利用が定着した頃に送ると回答率が上がる',
  '- 買い切りは初期の売上が立ちやすいが継続収益にならないため、サブスクに切り替えた',
  '',
  '手順ややり方が説明されている場合は、その手順を番号付きで具体的に書いてください。',
  '数値・金額・ツール名・サービス名・設定値は、省略せずそのまま残してください。',
  '',
  '## 画面に映っている情報も読み取ってください',
  '',
  'この動画には、音声では説明されていない情報が画面に表示されていることがあります。',
  '- 画面に出ている URL・サービス名・ツール名は、表示されている綴りのまま正確に書き写す',
  '- 画面に出ているコード・設定値・数値・スライドの文言も拾う',
  '- 音声と画面で表記が食い違う場合は、画面の表記を採用する',
  '  (例: 音声では「デザインmd」と聞こえても、画面に getdesign.md と出ていればそちらを書く)',
  '',
  '## 絶対にやってはいけないこと',
  '',
  '- この動画に映っていない・語られていない情報を書き足す',
  '- あなた自身が持っている知識で説明を補う',
  '- 読み取れなかった文字を推測で埋める',
  '- 挨拶・チャンネル登録の依頼・広告・提供表示を要約に含める',
  '',
  '読み取れなかったものや判断に迷ったものは、推測せず「確認が必要な点」に書いてください。',
].join('\n');

/** 出力フォーマットの指定を組み立てる */
function outputFormat(preset) {
  const sections = [
    '## 出力フォーマット',
    '',
    '## ひとことで言うと',
    '（この動画で結局何が言われていたのかを1〜3文で。話題の紹介ではなく結論を書く）',
    '',
    '## 要点',
    `（${preset.bullets}の箇条書き。1項目ごとに内容が分かる完結した文を書き、末尾に該当箇所の [m:ss] を付ける）`,
  ];

  if (preset.detail) {
    sections.push(
      '',
      '## 詳しい内容',
      '（話題ごとに ### 見出しを付けて説明する。見出しにも [m:ss] を付ける。',
      '　手順が説明されている場合は番号付きリストで具体的に書く。',
      '　なぜそうするのかという理由や、失敗例が語られていればそれも書く）',
    );
  }

  sections.push(
    '',
    '## 覚えておきたいこと',
    '（動画中に出てきたツール名・サービス名・URL・数値・金額・専門用語を、意味を添えて箇条書きにする。',
    '　画面に表示されていたものは表示どおりの綴りで書く。該当がなければこの節は省略してよい）',
    '',
    '## 確認が必要な点',
    '（画面の文字が読み取れなかった、音声が不明瞭だったなど、確信が持てない箇所があればここに書く。',
    '　何がどう不確かなのかを1行で書く。該当がなければこの節は省略する）',
  );

  return sections.join('\n');
}

/** 要約を作らせるプロンプト */
function summaryPrompt(preset) {
  return [
    'あなたは動画の内容を、後から見返せる資料にまとめる編集者です。',
    '読む人はこの動画を見ません。資料を読むだけで内容を理解し、説明されていた方法を実行できる必要があります。',
    '',
    'この動画を最初から最後まで見て、日本語で要約を作ってください。',
    '',
    RULES,
    '',
    outputFormat(preset),
    '',
    '出力は要約の本文だけにしてください。「以下が要約です」といった前置きや、最後の感想は書かないでください。',
  ].join('\n');
}

/** 下書きを見直させるプロンプト */
function reviewPrompt(draft, preset) {
  return [
    'あなたは、要約の下書きを動画と突き合わせて確認する校正者です。',
    '',
    'この動画の要約の下書きができました。動画をもう一度確認し、完成版にしてください。',
    '',
    '## あなたができること (この3つだけ)',
    '1. 表記の修正 — 聞き取りや読み取りを誤っている箇所を、動画で確認できる正しい表記に直す',
    '2. 欠落の補充 — 動画で語られている、または画面に映っているのに下書きに入っていない重要な内容を加える',
    '3. 整理 — 重複をまとめる、順序を直す、曖昧な表現を具体化する',
    '',
    '## 絶対にやってはいけないこと',
    '- 動画で確認できない情報を書き足す',
    '- あなた自身が持っている知識で説明を補う',
    '- 固有名詞・URL・数値を推測して書く',
    '- 動画で確認できないことを理由に、下書きの記述を削除する',
    '',
    RULES,
    '',
    outputFormat(preset),
    '',
    '下書きと同じ見出し構成のまま、完成版の要約だけを出力してください。',
    '修正した箇所に印は付けず、完成した文章として読める形にしてください。',
    '',
    '[下書き]',
    draft,
  ].join('\n');
}

/** Gemini のエラー応答を、利用者に見せられる形に変える */
async function toGeminiError(res) {
  let detail = null;
  let message = '';
  try {
    const body = await res.json();
    detail = body?.error ?? null;
    message = detail?.message ?? '';
  } catch {
    /* JSON でない応答 */
  }

  if (res.status === 400 && /api.?key/i.test(message)) {
    return new GeminiError('GEMINI_KEY_INVALID', 'Gemini の API キーが正しくありません。', detail);
  }
  if (res.status === 429) {
    return new GeminiError(
      'GEMINI_QUOTA',
      'Gemini の利用上限に達しました。無料枠は1日あたり動画8時間までです。時間をおいてお試しください。',
      detail,
    );
  }
  if (res.status === 403) {
    return new GeminiError(
      'GEMINI_FORBIDDEN',
      'Gemini API へのアクセスが拒否されました。API キーの権限をご確認ください。',
      detail,
    );
  }
  if (/token|too large|exceeds/i.test(message)) {
    return new GeminiError('GEMINI_TOO_LONG', '動画が長すぎて処理できませんでした。', detail);
  }

  return new GeminiError(
    'GEMINI_ERROR',
    `Gemini の呼び出しに失敗しました (HTTP ${res.status})${message ? `: ${message}` : ''}`,
    detail,
  );
}

/**
 * Gemini をストリーミングで呼び、生成テキストの差分を順に yield する。
 *
 * @param {string} mediaResolution 未指定なら API の既定値を使う
 */
async function* streamGemini(env, { videoId, prompt, maxTokens, mediaResolution }) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  const generationConfig = { temperature: 0.2, maxOutputTokens: maxTokens };
  if (mediaResolution) generationConfig.mediaResolution = mediaResolution;

  const res = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { file_data: { file_uri: `https://www.youtube.com/watch?v=${videoId}` } },
            { text: prompt },
          ],
        },
      ],
      generationConfig,
    }),
  });

  if (!res.ok) throw await toGeminiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.error) throw new GeminiError('GEMINI_ERROR', chunk.error.message, chunk.error);

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          // 思考過程のパートは要約本文ではないので出さない
          if (part.thought) continue;
          if (part.text) yield part.text;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** ストリームを最後まで読んで全文を返す。長すぎる場合は解像度を落として1度だけ再試行する */
async function runGemini(env, params, onDelta) {
  const attempt = async (mediaResolution) => {
    let produced = '';
    for await (const delta of streamGemini(env, { ...params, mediaResolution })) {
      produced += delta;
      onDelta?.(delta);
    }
    return produced;
  };

  try {
    return await attempt(params.mediaResolution);
  } catch (err) {
    // 長い動画はコンテキストに収まらないことがある。解像度を落とすとトークンが減る
    if (err instanceof GeminiError && err.code === 'GEMINI_TOO_LONG' && !params.mediaResolution) {
      onDelta?.(''); // 呼び出し側に再試行を知らせる余地を残す
      return attempt('MEDIA_RESOLUTION_LOW');
    }
    throw err;
  }
}

/**
 * YouTube 動画を Gemini で要約する。
 *
 * @param {object} env Worker の env (GEMINI_API_KEY を含む)
 * @param {object} params
 * @param {string} params.videoId 動画ID
 * @param {string} params.length 'short' | 'standard' | 'detailed'
 * @param {boolean} params.review 検証・補正パスを行うか
 * @param {(status: object) => void} params.onStatus 進捗通知
 * @param {(delta: string) => void} params.onDelta 要約本文の差分通知
 * @param {(text?: string) => void} params.onReset 表示済みの本文を破棄する通知
 */
export async function summarizeVideo(
  env,
  { videoId, length, review = true, onStatus, onDelta, onReset },
) {
  const preset = GEMINI_PRESETS[length] ?? GEMINI_PRESETS.standard;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  onStatus?.({
    phase: 'analyzing',
    message: review ? '動画を解析して下書きを作成中…' : '動画を解析中…',
  });

  const draft = await runGemini(
    env,
    { videoId, prompt: summaryPrompt(preset), maxTokens: preset.maxTokens },
    onDelta,
  );

  if (!draft.trim()) {
    throw new GeminiError('GEMINI_EMPTY', 'Gemini が要約を返しませんでした。', null);
  }

  if (!review) {
    return { text: draft, model, reviewed: false, engine: 'gemini' };
  }

  onStatus?.({ phase: 'reviewing', message: '動画と突き合わせて検証中…' });

  let finalText;
  try {
    onReset?.();
    finalText = await runGemini(
      env,
      { videoId, prompt: reviewPrompt(draft, preset), maxTokens: preset.maxTokens },
      onDelta,
    );
  } catch (err) {
    // 検証に失敗しても下書きは使える
    console.error('gemini review pass failed', err);
    onReset?.(draft);
    return {
      text: draft,
      model,
      reviewed: false,
      engine: 'gemini',
      reviewError: err?.message ?? String(err),
    };
  }

  if (!finalText.trim()) {
    onReset?.(draft);
    return { text: draft, model, reviewed: false, engine: 'gemini' };
  }

  return { text: finalText, model, reviewed: true, engine: 'gemini' };
}
