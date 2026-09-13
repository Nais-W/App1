/**
 * YouTube 要約ツール - Cloudflare Workers エントリポイント
 *
 * 静的アセット (public/) は Cloudflare 側が先に処理するため、
 * この Worker には API へのリクエストだけが届く。
 */

import { extractVideoId, fetchTranscript, TranscriptError } from './youtube.js';
import { summarize, LENGTH_PRESETS } from './summarize.js';

/** 1リクエストで受け付ける本文の最大サイズ */
const MAX_BODY_BYTES = 4096;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        model: env.SUMMARY_MODEL ?? null,
        preferredLangs: env.PREFERRED_LANGS ?? null,
      });
    }

    if (url.pathname === '/api/summarize') {
      if (request.method !== 'POST') {
        return json({ error: 'POST を使用してください' }, 405);
      }
      return handleSummarize(request, env, ctx);
    }

    return json({ error: 'Not Found' }, 404);
  },
};

async function handleSummarize(request, env, ctx) {
  // --- 入力の検証 ---
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'リクエストが大きすぎます' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const videoId = extractVideoId(body?.url ?? '');
  if (!videoId) {
    return json(
      { error: 'YouTube の URL として認識できませんでした。動画ページの URL を貼り付けてください。' },
      400,
    );
  }

  const length = Object.hasOwn(LENGTH_PRESETS, body?.length) ? body.length : 'standard';
  const preferredLangs = (env.PREFERRED_LANGS ?? 'ja,en')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // --- SSE でストリーミング返却 ---
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        send('status', { phase: 'fetching', message: '字幕を取得中…' });

        const transcript = await fetchTranscript(videoId, { preferredLangs });

        send('meta', {
          videoId,
          title: transcript.metadata.title,
          author: transcript.metadata.author,
          lengthSeconds: transcript.metadata.lengthSeconds,
          captionLanguage: transcript.track.languageCode,
          captionIsAsr: transcript.track.isAsr,
        });

        const result = await summarize(env, {
          segments: transcript.segments,
          metadata: transcript.metadata,
          length,
          onStatus: (s) => send('status', s),
          onDelta: (d) => send('delta', { text: d }),
        });

        send('done', {
          chunks: result.chunks,
          sampled: result.sampled,
          model: result.model,
        });
      } catch (err) {
        console.error('summarize failed', err);
        if (err instanceof TranscriptError) {
          send('error', { code: err.code, message: err.message, detail: err.detail ?? null });
        } else {
          send('error', {
            code: 'INTERNAL',
            message: `要約の生成に失敗しました: ${err?.message ?? '原因不明のエラー'}`,
          });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* すでに閉じている */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
