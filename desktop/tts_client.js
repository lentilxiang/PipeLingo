const crypto = require('crypto');

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';

/**
 * 独立流式 TTS（seed-icl-2.0 克隆音色）
 */
async function synthStream(opts) {
  const { apiKey, speaker, text, onAudio, onDone, onError, resourceId = 'seed-icl-2.0' } = opts;
  try {
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        user: { uid: 'pipelingo' },
        req_params: {
          text,
          speaker,
          audio_params: { format: 'mp3', sample_rate: 24000 },
        }
      })
    });

    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => '');
      throw new Error(`TTS HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
        const block = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        let j;
        try { j = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        // code=0 或 20000000(OK) 都算成功；只拦截真正的错误码
        const okCode = j.code === undefined || j.code === 0 || j.code === 20000000;
        if (!okCode) {
          onError && onError(new Error(`TTS code=${j.code} ${j.message || ''}`));
          return;
        }
        if (j.data) onAudio(Buffer.from(j.data, 'base64'));
      }
    }
    onDone && onDone();
  } catch (err) {
    onError && onError(err);
  }
}

module.exports = { synthStream };
