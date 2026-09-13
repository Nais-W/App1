/**
 * 字幕テキストを Workers AI で要約する。
 *
 * 字幕は動画が長いほどモデルのコンテキストを超えるため、
 * 「分割して部分要約 → まとめて最終要約」という 2 段構えにしている。
 */

import { formatTimestamp } from './youtube.js';

/** 1チャンクあたりの文字数の目安 */
const CHUNK_CHARS = 7000;
/** チャンク数の上限 (サブリクエスト数と実行時間を抑えるため) */
const MAX_CHUNKS = 14;
/** チャンクを広げる場合の上限 */
const MAX_CHUNK_CHARS = 12000;
/** タイムスタンプを挿入する間隔 (秒) */
const TIMESTAMP_INTERVAL = 60;

export const LENGTH_PRESETS = {
  short: {
    label: '短め',
    bullets: '3〜5個',
    maxTokens: 1000,
    instruction: '全体像がすぐ掴めるよう、短くまとめてください。「詳しい内容」の節は作らないでください。',
  },
  standard: {
    label: '標準',
    bullets: '5〜8個',
    maxTokens: 2200,
    instruction: '要点を押さえつつ、主要な話題は「詳しい内容」で補足してください。',
  },
  detailed: {
    label: '詳しく',
    bullets: '8〜12個',
    maxTokens: 4000,
    instruction:
      '動画を見なくても内容が分かる程度に、「詳しい内容」を話題ごとの見出しに分けて丁寧に書いてください。',
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

/** Workers AI を 1 回呼んで、生成されたテキスト全体を返す */
async function runModel(env, model, messages, maxTokens) {
  const result = await env.AI.run(model, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
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
    temperature: 0.3,
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
        'あなたは動画の書き起こしを整理する編集者です。必ず日本語で、事実に忠実に書きます。' +
        '書き起こしに書かれていないことを推測で補ってはいけません。',
    },
    {
      role: 'user',
      content:
        `これは YouTube 動画の書き起こしの第 ${index + 1} / ${total} パートです。\n` +
        'あとで動画全体の要約を作るための素材として、このパートの内容を箇条書きにしてください。\n\n' +
        '条件:\n' +
        '- 日本語で書く\n' +
        '- 主張・結論・具体例・数値・固有名詞は落とさない\n' +
        '- 各項目の先頭に、その話題が始まる [時刻] を書き起こし中の表記のまま付ける\n' +
        '- 5〜10 項目\n' +
        '- 前置きや「このパートでは」といった説明は書かない\n\n' +
        `[書き起こし]\n${chunk}`,
    },
  ];
}

/** 最終要約 (reduce フェーズ) のプロンプト */
function reduceMessages(source, metadata, preset, isRaw) {
  const heading = isRaw ? '書き起こし' : '各パートの内容メモ';

  const sections = [
    '## ひとことで言うと',
    '（1〜2文で動画全体の結論）',
    '',
    '## 要点',
    `（${preset.bullets}の箇条書き。各行の末尾に該当箇所の [時刻] を付ける）`,
  ];

  if (preset.maxTokens > 1000) {
    sections.push('', '## 詳しい内容', '（話題ごとに ### 見出しを付けて説明。見出しには [時刻] を付ける）');
  }
  sections.push('', '## こんな人におすすめ', '（3項目程度の箇条書き）');

  return [
    {
      role: 'system',
      content:
        'あなたは動画の内容を日本語で分かりやすくまとめる編集者です。' +
        '与えられた材料に書かれている内容だけを使い、推測や一般論で埋めてはいけません。' +
        '出力は Markdown で、指定された見出し構成をそのまま使ってください。',
    },
    {
      role: 'user',
      content:
        `YouTube 動画「${metadata.title}」${metadata.author ? `（チャンネル: ${metadata.author}）` : ''}の${heading}をもとに、日本語で要約を作ってください。\n\n` +
        `${preset.instruction}\n\n` +
        '出力フォーマット:\n' +
        sections.join('\n') +
        '\n\n' +
        '注意:\n' +
        '- 材料にない情報を足さない\n' +
        '- 時刻は材料に出てくる [m:ss] 形式の表記をそのまま使う。分からない場合は付けない\n' +
        '- 挨拶や「以下が要約です」といった前置きは書かない\n\n' +
        `[${heading}]\n${source}`,
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
    // 1チャンクに収まるなら、部分要約を挟まず直接まとめる
    source = chunks[0];
    isRaw = true;
  } else {
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      onStatus({
        phase: 'mapping',
        message: `内容を読み込み中… (${i + 1}/${chunks.length})`,
        current: i + 1,
        total: chunks.length,
      });
      const note = await runModel(env, model, mapMessages(chunks[i], i, chunks.length), 900);
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
