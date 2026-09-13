/**
 * 字幕テキストを Workers AI で要約する。
 *
 * 字幕は動画が長いほどモデルのコンテキストを超えるため、
 * 「分割して部分要約 → まとめて最終要約」という 2 段構えにしている。
 *
 * 要約の狙いは「後から見返せる資料」を作ることなので、
 * 話題の一覧ではなく、話されている中身そのものを書かせる。
 * 指示だけでは「〜について話している」という目次のような出力に
 * 崩れやすいため、プロンプトに禁止例と良い例を明示している。
 */

import { formatTimestamp } from './youtube.js';

/** 1チャンクあたりの文字数の目安 */
const CHUNK_CHARS = 8000;
/** チャンク数の上限 (サブリクエスト数と実行時間を抑えるため) */
const MAX_CHUNKS = 14;
/** チャンクを広げる場合の上限 */
const MAX_CHUNK_CHARS = 12000;
/** タイムスタンプを挿入する間隔 (秒) */
const TIMESTAMP_INTERVAL = 60;
/** 部分要約を全部足したときの、最終要約への入力トークンの上限の目安 */
const MAP_TOKEN_BUDGET = 13000;

/** 話題だけを示す出力を防ぐための、共通の禁止ルール */
const EXTRACTION_RULES = [
  '最重要のルール: 話題を示すだけの書き方は禁止です。必ず「何と言っていたか」を書いてください。',
  '',
  '禁止する書き方の例:',
  '- レビュー機能の追加について話している',
  '- 価格戦略について比較している',
  '- UXの重要性を説明している',
  '',
  '書くべき形の例:',
  '- レビュー依頼は購入直後ではなく、利用が定着した頃に送ると回答率が上がる',
  '- 買い切りは初期の売上が立ちやすいが継続収益にならないため、サブスクに切り替えた',
  '- 入力欄を1画面1項目にしたら、途中離脱が減った',
  '',
  '「〜について」「〜に関して」「〜を紹介している」「〜を説明している」「〜talks about」は使わないでください。',
  '手順ややり方が説明されている場合は、その手順を具体的に番号付きで書いてください。',
  '（例: 1. 設定画面を開く → 2. APIキーを貼り付ける → 3. 保存する）',
  '具体的な数値・金額・ツール名・サービス名・設定値・専門用語は、省略せずそのまま残してください。',
].join('\n');

export const LENGTH_PRESETS = {
  short: {
    label: '短め',
    bullets: '4〜6個',
    maxTokens: 1400,
    detail: false,
    instruction: '全体像がすぐ掴めるよう簡潔に。ただし各項目は必ず中身のある一文にしてください。',
  },
  standard: {
    label: '標準',
    bullets: '6〜9個',
    maxTokens: 2800,
    detail: true,
    instruction:
      '要点を押さえたうえで、主要な話題は「詳しい内容」で、動画を見なくても実行できる程度に具体的に書いてください。',
  },
  detailed: {
    label: '詳しく',
    bullets: '8〜12個',
    maxTokens: 4000,
    detail: true,
    instruction:
      'この要約だけで動画の内容を再現できることを目指してください。' +
      '「詳しい内容」は話題ごとに見出しを分け、手順・判断の理由・具体例まで書いてください。',
  },
};

/**
 * 字幕セグメントを、一定間隔でタイムスタンプを挟んだプレーンテキストにする。
 */
function segmentsToText(segments) {
  const lines = [];
  let nextMark = 0;

  for (const seg of segments) {
    if (seg.start >= nextMark) {
      lines.push(`\n[${formatTimestamp(seg.start)}]`);
      nextMark = seg.start + TIMESTAMP_INTERVAL;
    }
    lines.push(seg.text);
  }
  return lines.join(' ').replace(/\n /g, '\n').trim();
}

/**
 * テキストを、タイムスタンプ行の切れ目を優先しながら chunkSize 程度に分割する。
 */
function splitText(text, chunkSize) {
  const chunks = [];
  let rest = text;

  while (rest.length > chunkSize) {
    // 区切りの候補をチャンク後半から探す (タイムスタンプ → 句点 → 空白)
    const window = rest.slice(0, chunkSize);
    const from = Math.floor(chunkSize * 0.6);
    let cut = -1;
    for (const re of [/\n\[[0-9:]+\]/g, /[。．!?！？]/g, /\s/g]) {
      let m;
      let last = -1;
      re.lastIndex = 0;
      while ((m = re.exec(window)) !== null) {
        if (m.index >= from) last = m.index;
      }
      if (last !== -1) {
        cut = last;
        break;
      }
    }
    if (cut === -1) cut = chunkSize;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * 字幕全体をチャンクに分ける。長すぎる場合はチャンクを広げ、
 * それでも収まらなければ間引いて sampled = true を返す。
 */
export function buildChunks(segments) {
  const text = segmentsToText(segments);

  let size = CHUNK_CHARS;
  if (text.length / size > MAX_CHUNKS) {
    size = Math.min(MAX_CHUNK_CHARS, Math.ceil(text.length / MAX_CHUNKS));
  }

  let chunks = splitText(text, size);
  let sampled = false;

  if (chunks.length > MAX_CHUNKS) {
    // 先頭と末尾を残しつつ、全体から均等に間引く
    const step = (chunks.length - 1) / (MAX_CHUNKS - 1);
    const picked = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      picked.push(chunks[Math.round(i * step)]);
    }
    chunks = picked;
    sampled = true;
  }

  return { chunks, totalChars: text.length, sampled };
}

/**
 * 部分要約 1 件あたりの出力トークン数を決める。
 * 部分要約はすべて最終要約の入力になるため、チャンクが多いほど 1 件を短くする。
 */
export function mapTokenBudget(chunkCount) {
  return Math.max(700, Math.min(2000, Math.floor(MAP_TOKEN_BUDGET / chunkCount)));
}

/** Workers AI を 1 回呼んで、生成されたテキスト全体を返す */
async function runModel(env, model, messages, maxTokens) {
  const result = await env.AI.run(model, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
  });

  const text = typeof result === 'string' ? result : (result?.response ?? '');
  if (!text.trim()) {
    throw new Error('モデルが空の応答を返しました');
  }
  return text.trim();
}

/**
 * Workers AI をストリーミングで呼び、生成テキストの差分を順に yield する。
 */
async function* runModelStream(env, model, messages, maxTokens) {
  const stream = await env.AI.run(model, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: true,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 形式 (data: {...}\n\n) を行単位で取り出す
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.response ?? parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) yield delta;
        } catch {
          // 途中で切れた JSON は次のチャンクと合わせて解釈されるので無視
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 部分要約 (map フェーズ) のプロンプト */
function mapMessages(chunk, index, total) {
  return [
    {
      role: 'system',
      content:
        'あなたは動画の書き起こしから、話されている中身を抜き出して記録する編集者です。' +
        '話題の一覧ではなく、話された内容そのものを書きます。' +
        '書き起こしにない情報を推測で補ってはいけません。必ず日本語で書きます。',
    },
    {
      role: 'user',
      content:
        `これは YouTube 動画の書き起こしの第 ${index + 1} / ${total} パートです。\n` +
        'あとで動画全体の要約を作るための素材として、このパートで話されている中身を書き出してください。\n\n' +
        `${EXTRACTION_RULES}\n\n` +
        'その他の条件:\n' +
        '- 箇条書きにする\n' +
        '- 各項目の先頭に、その内容が出てくる [時刻] を書き起こし中の表記のまま付ける\n' +
        '- 雑談・挨拶・チャンネル登録の依頼・広告は省く\n' +
        '- 前置きや「このパートでは」といった説明は書かない\n\n' +
        `[書き起こし]\n${chunk}`,
    },
  ];
}

/**
 * 字幕以外の材料 (説明欄・チャプター) を組み立てる。
 *
 * 字幕は音声しか拾えないため、画面にだけ出ている情報や、
 * 聞き取りに失敗した固有名詞が落ちる。投稿者が書いた説明欄とチャプターは
 * その一部を補えるので、字幕とは区別できる形で材料に加える。
 */
function buildSupplement(metadata) {
  const parts = [];

  if (metadata.chapters?.length) {
    const list = metadata.chapters.map((c) => `[${c.time}] ${c.title}`).join('\n');
    parts.push(`[投稿者が付けたチャプター]\n${list}`);
  }

  if (metadata.description) {
    parts.push(`[動画の説明欄]\n${metadata.description}`);
  }

  return parts.join('\n\n');
}

/** 最終要約 (reduce フェーズ) のプロンプト */
function reduceMessages(source, metadata, preset, isRaw) {
  const heading = isRaw ? '書き起こし' : '各パートの内容メモ';
  const supplement = buildSupplement(metadata);

  const sections = [
    '## ひとことで言うと',
    '（この動画で結局何が言われていたのかを1〜3文で。話題の紹介ではなく結論を書く）',
    '',
    '## 要点',
    `（${preset.bullets}の箇条書き。1項目ごとに、内容が分かる完結した文を書き、末尾に該当箇所の [時刻] を付ける）`,
  ];

  if (preset.detail) {
    sections.push(
      '',
      '## 詳しい内容',
      '（話題ごとに ### 見出しを付けて説明する。見出しにも [時刻] を付ける。',
      '　手順・やり方が説明されている場合は、番号付きリストで具体的に書く。',
      '　なぜそうするのかという理由や、失敗例が語られていればそれも書く）',
    );
  }

  sections.push(
    '',
    '## 覚えておきたいこと',
    '（動画中に出てきたツール名・サービス名・数値・金額・専門用語を、意味を添えて箇条書きにする。',
    '　該当するものがなければこの節は省略してよい）',
  );

  return [
    {
      role: 'system',
      content:
        'あなたは動画の内容を、後から見返せる資料にまとめる編集者です。' +
        '読む人は動画を見ません。資料を読むだけで内容を理解し、説明されていた方法を実行できる必要があります。' +
        '与えられた材料に書かれている内容だけを使い、推測や一般論で埋めてはいけません。' +
        '出力は Markdown で、指定された見出し構成をそのまま使います。必ず日本語で書きます。',
    },
    {
      role: 'user',
      content:
        `YouTube 動画「${metadata.title}」${metadata.author ? `（チャンネル: ${metadata.author}）` : ''}の${heading}をもとに、` +
        '後から見返せる要約を作ってください。\n\n' +
        `${EXTRACTION_RULES}\n\n` +
        `${preset.instruction}\n\n` +
        '出力フォーマット:\n' +
        sections.join('\n') +
        '\n\n' +
        'その他の注意:\n' +
        '- 材料にない情報を足さない\n' +
        '- 時刻は材料に出てくる [m:ss] 形式の表記をそのまま使う。分からない場合は付けない\n' +
        '- 挨拶・チャンネル登録の依頼・広告部分は要約に含めない\n' +
        '- 「以下が要約です」などの前置きや、最後の感想は書かない\n' +
        (supplement
          ? '\n書き起こしは音声しか拾えていないため、画面にだけ表示された情報や、' +
            '聞き取りを誤った固有名詞が抜けていることがあります。\n' +
            '下の補足資料は投稿者が書いたものなので、字幕と食い違う場合は補足資料の表記を優先してください。\n' +
            'チャプターがある場合は、それを「詳しい内容」の見出しの手がかりにしてください。\n' +
            '補足資料にしか出てこないツール名・サービス名・URL・手順も、本編の内容に関係するものは拾ってください。\n' +
            'ただし宣伝・自己紹介・他の動画への誘導は無視してください。\n'
          : '') +
        '\n' +
        `[${heading}]\n${source}` +
        (supplement ? `\n\n[補足資料]\n${supplement}` : ''),
    },
  ];
}

/**
 * 字幕から要約を生成する。
 *
 * 進捗と本文は、コールバック経由で逐次通知する。
 *
 * @param {object} env Worker の env (AI バインディングを含む)
 * @param {object} params
 * @param {Array} params.segments 字幕セグメント
 * @param {object} params.metadata 動画メタ情報
 * @param {string} params.length 'short' | 'standard' | 'detailed'
 * @param {(status: object) => void} params.onStatus 進捗通知
 * @param {(delta: string) => void} params.onDelta 要約本文の差分通知
 */
export async function summarize(env, { segments, metadata, length, onStatus, onDelta }) {
  const preset = LENGTH_PRESETS[length] ?? LENGTH_PRESETS.standard;
  const model = env.SUMMARY_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

  const { chunks, totalChars, sampled } = buildChunks(segments);

  onStatus({
    phase: 'prepared',
    message: `字幕 ${totalChars.toLocaleString()} 文字を ${chunks.length} 分割して読み込みます`,
    chunks: chunks.length,
    sampled,
  });

  let source;
  let isRaw = false;

  if (chunks.length === 1) {
    // 1チャンクに収まるなら、部分要約を挟まず直接まとめる (情報が最も落ちない)
    source = chunks[0];
    isRaw = true;
  } else {
    const perChunkTokens = mapTokenBudget(chunks.length);
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      onStatus({
        phase: 'mapping',
        message: `内容を読み込み中… (${i + 1}/${chunks.length})`,
        current: i + 1,
        total: chunks.length,
      });
      const note = await runModel(
        env,
        model,
        mapMessages(chunks[i], i, chunks.length),
        perChunkTokens,
      );
      notes.push(`--- パート ${i + 1}/${chunks.length} ---\n${note}`);
    }
    source = notes.join('\n\n');
  }

  onStatus({ phase: 'reducing', message: '要約を作成中…' });

  let produced = '';
  for await (const delta of runModelStream(
    env,
    model,
    reduceMessages(source, metadata, preset, isRaw),
    preset.maxTokens,
  )) {
    produced += delta;
    onDelta(delta);
  }

  if (!produced.trim()) {
    throw new Error('要約を生成できませんでした（モデルの応答が空でした）');
  }

  return { text: produced, chunks: chunks.length, sampled, model };
}
