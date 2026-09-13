/**
 * YouTube の動画IDの抽出と、字幕 (transcript) の取得。
 *
 * 字幕取得は YouTube 側の仕様変更やボット判定で壊れやすいため、
 * 複数の経路を順番に試し、どこで失敗したかを呼び出し側に返せるようにしている。
 */

/** 動画IDとして妥当か (11文字の英数字 + - _) */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * 各種 YouTube URL から動画IDを取り出す。
 * 取り出せない場合は null。
 */
export function extractVideoId(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // 生の動画IDがそのまま渡された場合
  if (VIDEO_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  // /watch?v=ID
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;

  // /shorts/ID, /embed/ID, /live/ID, /v/ID
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
    const id = parts[1];
    if (VIDEO_ID_RE.test(id)) return id;
  }

  return null;
}

/** 字幕取得に失敗した理由を、利用者に説明できる形で持ち回すエラー */
export class TranscriptError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
    this.detail = detail;
  }
}

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/**
 * InnerTube (YouTube 内部API) のクライアント定義。
 * 上から順に試す。データセンターIPからのアクセスは弾かれることがあるため複数用意する。
 */
const CLIENTS = [
  {
    label: 'ANDROID',
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
      platform: 'MOBILE',
    },
    headers: {
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '20.10.38',
    },
  },
  {
    label: 'IOS',
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceModel: 'iPhone16,2',
      osName: 'iOS',
      osVersion: '18.3.2.22D82',
      platform: 'MOBILE',
    },
    headers: {
      'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': '20.10.4',
    },
  },
  {
    label: 'WEB',
    client: {
      clientName: 'WEB',
      clientVersion: '2.20250301.00.00',
      platform: 'DESKTOP',
    },
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20250301.00.00',
    },
  },
];

/** InnerTube の player エンドポイントを叩いて playerResponse を得る */
async function fetchPlayerResponse(videoId, clientDef, lang) {
  const body = {
    videoId,
    context: {
      client: {
        ...clientDef.client,
        hl: lang,
        gl: 'JP',
        timeZone: 'Asia/Tokyo',
        utcOffsetMinutes: 540,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };

  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'Accept-Language': `${lang},en;q=0.8`,
        Origin: 'https://www.youtube.com',
        ...clientDef.headers,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    throw new TranscriptError(
      'INNERTUBE_HTTP',
      `InnerTube (${clientDef.label}) が HTTP ${res.status} を返しました`,
      { status: res.status },
    );
  }
  return res.json();
}

/**
 * watch ページの HTML から ytInitialPlayerResponse を取り出すフォールバック。
 */
async function fetchPlayerResponseFromWatchPage(videoId, lang) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=${lang}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept-Language': `${lang},en;q=0.8`,
    },
  });
  if (!res.ok) {
    throw new TranscriptError(
      'WATCH_HTTP',
      `watch ページが HTTP ${res.status} を返しました`,
      { status: res.status },
    );
  }
  const html = await res.text();
  const json = extractJsonAfter(html, 'ytInitialPlayerResponse');
  if (!json) {
    throw new TranscriptError(
      'WATCH_PARSE',
      'watch ページから再生情報を取り出せませんでした',
      { botCheck: /confirm you(?:&#39;|')?re not a bot|Sign in to confirm/i.test(html) },
    );
  }
  return json;
}

/**
 * `key = {...}` の形で埋め込まれた JSON を、波括弧の対応を数えて切り出す。
 * 文字列リテラル内の括弧・エスケープを正しく読み飛ばす。
 */
function extractJsonAfter(html, key) {
  const marker = html.indexOf(key);
  if (marker === -1) return null;
  const start = html.indexOf('{', marker);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** playerResponse から動画のメタ情報を取り出す */
function readMetadata(player) {
  const d = player?.videoDetails ?? {};
  const seconds = Number(d.lengthSeconds);
  const description = typeof d.shortDescription === 'string' ? d.shortDescription : '';
  return {
    title: d.title ?? '(タイトル不明)',
    author: d.author ?? '',
    lengthSeconds: Number.isFinite(seconds) ? seconds : null,
    isLive: Boolean(d.isLive || d.isLiveContent),
    description: cleanDescription(description),
    chapters: parseChapters(description),
  };
}

/** 説明欄の上限文字数。これを超える分は要約の材料にしない */
const MAX_DESCRIPTION_CHARS = 2500;

/**
 * 説明欄から、要約の材料になりにくい行 (URL だけの行、SNS 誘導、定型の宣伝) を落とす。
 * 投稿者が書いた補足説明は、字幕に出てこない情報を含むことがあるため残す。
 */
export function cleanDescription(description) {
  if (!description) return '';

  const noise =
    /^(?:[\s\-=*_#・]*)$|^(?:https?:\/\/\S+)$|チャンネル登録|高評価|メンバーシップ|公式(?:LINE|ライン)|各種SNS|▼|フォロー(?:は|よろしく)|#[^\s#]+(?:\s+#[^\s#]+)+$/i;

  const kept = [];
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    if (!line || noise.test(line)) continue;
    kept.push(line);
  }

  const text = kept.join('\n').trim();
  return text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : text;
}

/**
 * 説明欄に書かれたチャプター (例: "1:23 導入") を取り出す。
 * 画面にしか出てこない話題の切れ目を補えるため、要約の構成の手がかりにする。
 */
export function parseChapters(description) {
  if (!description) return [];

  const chapters = [];
  for (const raw of description.split('\n')) {
    const m = raw.trim().match(/^\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:｜|]?\s*(.+)$/);
    if (!m) continue;

    const title = m[2].trim().replace(/^[-–—:｜|\s]+/, '');
    if (!title || title.length > 120) continue;

    chapters.push({ time: m[1], title });
  }

  // タイムスタンプが1つしかない説明欄は、チャプターではなく単なる言及のことが多い
  return chapters.length >= 2 ? chapters.slice(0, 40) : [];
}

/** 再生できない動画 (非公開・削除・年齢制限など) を検出する */
function assertPlayable(player) {
  const status = player?.playabilityStatus;
  if (!status) return;
  const s = status.status;
  if (s && s !== 'OK') {
    const reason =
      status.reason ||
      status.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ||
      s;
    throw new TranscriptError('NOT_PLAYABLE', `この動画は再生できません: ${reason}`, { status: s });
  }
}

/**
 * 利用可能な字幕トラックから、希望の言語に最も近いものを選ぶ。
 * 手動字幕を自動生成字幕より優先する。
 */
function pickTrack(tracks, preferredLangs) {
  if (!tracks?.length) return null;

  const score = (track) => {
    const code = (track.languageCode || '').toLowerCase();
    const base = code.split('-')[0];
    const idx = preferredLangs.findIndex((l) => l === code || l === base);
    const langScore = idx === -1 ? preferredLangs.length : idx;
    const isAsr = track.kind === 'asr';
    return langScore * 2 + (isAsr ? 1 : 0);
  };

  return [...tracks].sort((a, b) => score(a) - score(b))[0];
}

/** json3 形式の字幕をダウンロードして、時刻つきのセグメント配列にする */
async function downloadTrack(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      Accept: '*/*',
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
    },
  });

  if (!res.ok) {
    throw new TranscriptError(
      'TIMEDTEXT_HTTP',
      `字幕データの取得が HTTP ${res.status} で失敗しました`,
      { status: res.status },
    );
  }

  const text = await res.text();
  if (!text.trim()) {
    throw new TranscriptError('TIMEDTEXT_EMPTY', '字幕データが空でした', null);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TranscriptError('TIMEDTEXT_PARSE', '字幕データを解釈できませんでした', null);
  }

  const segments = [];
  for (const event of data.events ?? []) {
    if (!event.segs) continue;
    const body = event.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body || body === '[音楽]' || body === '[Music]') continue;
    segments.push({ start: Math.floor((event.tStartMs ?? 0) / 1000), text: body });
  }

  if (!segments.length) {
    throw new TranscriptError('TIMEDTEXT_EMPTY', '字幕に読み取れる本文がありませんでした', null);
  }
  return segments;
}

/**
 * 動画IDから字幕とメタ情報を取得する。
 *
 * @returns {Promise<{metadata: object, track: {languageCode: string, isAsr: boolean}, segments: Array<{start: number, text: string}>, via: string}>}
 */
export async function fetchTranscript(videoId, { preferredLangs = ['ja', 'en'] } = {}) {
  const lang = preferredLangs[0] ?? 'ja';
  const attempts = [];
  let lastPlayable = null;

  const sources = [
    ...CLIENTS.map((c) => ({
      label: `innertube:${c.label}`,
      run: () => fetchPlayerResponse(videoId, c, lang),
    })),
    { label: 'watch-page', run: () => fetchPlayerResponseFromWatchPage(videoId, lang) },
  ];

  for (const source of sources) {
    let player;
    try {
      player = await source.run();
    } catch (err) {
      attempts.push({ source: source.label, error: err.message });
      continue;
    }

    try {
      assertPlayable(player);
    } catch (err) {
      // 「再生できない」は経路を変えても直らないので、そのまま返す
      if (err instanceof TranscriptError && err.code === 'NOT_PLAYABLE') throw err;
      throw err;
    }

    lastPlayable = player;

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) {
      attempts.push({ source: source.label, error: '字幕トラックが見つからない' });
      continue;
    }

    const track = pickTrack(tracks, preferredLangs);
    try {
      const segments = await downloadTrack(track);
      return {
        metadata: readMetadata(player),
        track: {
          languageCode: track.languageCode ?? '?',
          name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? '',
          isAsr: track.kind === 'asr',
        },
        segments,
        via: source.label,
        attempts,
      };
    } catch (err) {
      attempts.push({ source: source.label, error: err.message });
    }
  }

  // どの経路でも取れなかった
  if (lastPlayable) {
    const meta = readMetadata(lastPlayable);
    if (meta.isLive) {
      throw new TranscriptError(
        'LIVE_STREAM',
        'ライブ配信中の動画には対応していません。配信終了後にお試しください。',
        { attempts },
      );
    }
    throw new TranscriptError(
      'NO_CAPTIONS',
      'この動画には利用できる字幕がありませんでした。字幕(自動生成を含む)が付いた動画をお試しください。',
      { attempts, title: meta.title },
    );
  }

  throw new TranscriptError(
    'FETCH_BLOCKED',
    'YouTube から動画情報を取得できませんでした。YouTube 側にアクセスを拒否された可能性があります。',
    { attempts },
  );
}

/** 秒数を [h:mm:ss] / [m:ss] 形式にする */
export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
