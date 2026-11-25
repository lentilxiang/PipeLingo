const { app, BrowserWindow } = require('electron');
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { AstClient } = require('./ast_client');
const { synthStream } = require('./tts_client');
const { BidirectTTS } = require('./tts_bidirect');

// ---------- .env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = loadEnv();
let astClient = null;
let ttsSession = null;
let ttsLastText = '';
let ast2Client = null;
let ttsSynthDoneForTurn = false;
let ttsSynthDoneForTurn2 = false;

function startCloneTts() {
  ttsSession = new BidirectTTS({
    apiKey: ENV.ARK_API_KEY,
    speaker: ENV.ARK_CLONED_SPEAKER_ID,
    onAudio: (buf) => {
      if (process.env.ARK_TTS_DEBUG) console.log('[tts] audio chunk', buf.length);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('tts:audio', buf);
    },
    onEnd: () => { ttsSession = null; ttsLastText = ''; },
    onError: (err) => {
      ttsSession = null; ttsLastText = '';
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('ast:event', { event: 'Error', message: 'TTS: ' + err.message });
    }
  });
  ttsSession.open().catch((err) => {
    ttsSession = null; ttsLastText = '';
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('ast:event', { event: 'Error', message: 'TTS: ' + err.message });
  });
}

function feedCloneTts(fullText) {
  if (fullText.length < ttsLastText.length) {
    if (ttsSession) ttsSession.finish();
    ttsSession = null; ttsLastText = '';
  }
  if (!ttsSession) startCloneTts();
  const delta = fullText.slice(ttsLastText.length);
  if (delta) {
    ttsLastText = fullText;
    const trySend = () => {
      if (!ttsSession) return;
      if (ttsSession.started) ttsSession.sendText(delta);
      else setTimeout(trySend, 50);
    };
    trySend();
  }
}

// 把 .env 的值同步进进程环境，供 ast_client 读取切换参数组合
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

function saveEnv(patch) {
  const envPath = path.join(__dirname, '.env');
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(patch)) {
    const idx = lines.findIndex(l => l.startsWith(k + '='));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    ENV[k] = v;
  }
  fs.writeFileSync(envPath, lines.join('\n'));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    title: 'PipeLingo',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const demo = process.argv.includes('--demo');
  win.loadFile('index.html', demo ? { search: 'demo=1' } : undefined);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
}

app.whenReady().then(() => {
  createWindow();

  // ---------- 同传 IPC ----------
  ipcMain.handle('ast:start', async (_e, voiceOpt) => {
    if (!ENV.ARK_API_KEY) return { ok: false, error: '缺少 ARK_API_KEY，请检查 desktop/.env' };
    try {
      astClient = new AstClient({
        apiKey: ENV.ARK_API_KEY,
        onEvent: (ev) => {
          // 克隆模式：翻译文本边出边喂给双向流式 TTS（首包更快）
          if (astClient && astClient.textOnlyMode) {
            if (ev.event === 'TranslationStart') { ttsSynthDoneForTurn = false; }
            // 等整句翻译完成再合成（残缺文本会返回空MP3，不可提前触发）
            if (ev.event === 'TranslationEnd' && ev.text && !ttsSynthDoneForTurn) {
              ttsSynthDoneForTurn = true;
              const mp3Chunks = [];
              synthStream({
                apiKey: ENV.ARK_API_KEY,
                speaker: ENV.ARK_CLONED_SPEAKER_ID,
                text: ev.text,
                onAudio: (buf) => { mp3Chunks.push(buf); },
                onDone: () => {
                  const full = Buffer.concat(mp3Chunks);
                  console.log('[tts-sse] chunks=%d totalBytes=%d', mp3Chunks.length, full.length);
                  const win = BrowserWindow.getAllWindows()[0];
                  if (win && full.length > 1000) win.webContents.send('tts:audio', full);
                },
                onError: (err) => {
                  const win = BrowserWindow.getAllWindows()[0];
                  if (win) win.webContents.send('ast:event', { event: 'Error', message: 'TTS: ' + err.message });
                }
              });
            }
          }
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('ast:event', ev);
        },
        onError: (err) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('ast:event', { event: 'Error', message: err.message });
        }
      });
      await astClient.connect();
      astClient.startSession({
        ...voiceOpt,
        clonedSpeakerId: (voiceOpt && voiceOpt.useClone && ENV.ARK_CLONED_SPEAKER_ID) || null,
        textOnly: !!(voiceOpt && voiceOpt.useClone && ENV.ARK_CLONED_SPEAKER_ID)
      });
      return { ok: true };
    } catch (err) {
      astClient = null;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('ast:audio', (_ev, pcmBuf) => {
    if (astClient) astClient.sendAudio(Buffer.from(pcmBuf));
  });

  ipcMain.handle('ast2:stop', async () => {
    if (ast2Client) { ast2Client.close(); ast2Client = null; }
    return { ok: true };
  });

  ipcMain.on('ast2:audio', (_ev, pcmBuf) => {
    if (ast2Client) ast2Client.sendAudio(Buffer.from(pcmBuf));
  });

  ipcMain.handle('ast2:start', async (_e, opts) => {
    if (!ENV.ARK_API_KEY) return { ok: false, error: '缺少 ARK_API_KEY' };
    const revVoice = opts && opts.voice === '标准女声' ? 'zh_female_vv_uranus_bigtts'
                  : opts && opts.voice === '标准男声' ? 'zh_male_wennuanahu_uranus_bigtts'
                  : null; // null = 用克隆音色（seed-icl-2.0）
    try {
      ast2Client = new AstClient({
        apiKey: ENV.ARK_API_KEY,
        onEvent: (ev) => {
          // 反向：对方英文 → 中文文本 → 中文TTS → 物理耳机
          if (ev.event === 'TranslationStart') { ttsSynthDoneForTurn2 = false; }
          if (ev.event === 'TranslationEnd' && ev.text && !ttsSynthDoneForTurn2) {
            ttsSynthDoneForTurn2 = true;
            const mp3Chunks = [];
            synthStream({
              apiKey: ENV.ARK_API_KEY,
              resourceId: revVoice ? 'seed-tts-2.0' : 'seed-icl-2.0',
              speaker: revVoice || ENV.ARK_CLONED_SPEAKER_ID,
              text: ev.text,
              onAudio: (buf) => { mp3Chunks.push(buf); },
              onDone: () => {
                const win = BrowserWindow.getAllWindows()[0];
                if (win && mp3Chunks.length) win.webContents.send('tts2:audio', Buffer.concat(mp3Chunks));
              },
              onError: (err) => {
                const win = BrowserWindow.getAllWindows()[0];
                if (win) win.webContents.send('ast2:event', { event: 'Error', message: 'TTS2: ' + err.message });
              }
            });
          }
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('ast2:event', ev);
        },
        onError: (err) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('ast2:event', { event: 'Error', message: err.message });
        }
      });
      await ast2Client.connect();
      ast2Client.startSession({
        langs: { mode: 's2t', sourceLanguage: 'en', targetLanguage: 'zh' },
        textOnly: true
      });
      return { ok: true };
    } catch (err) {
      ast2Client = null;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ast:stop', async () => {
    if (astClient) { astClient.close(); astClient = null; }
  
    return { ok: true };
  });

  // ---------- 声音复刻：上传10秒音频训练专属音色 ----------
  ipcMain.handle('clone:train', async (_e, payload) => {
    const { audioBase64, format, language } = payload;
    if (!ENV.ARK_API_KEY) return { ok: false, error: '缺少 ARK_API_KEY' };
    const speakerId = 'PipelingoUserVoice';
    try {
      const resp = await fetch('https://openspeech.bytedance.com/api/v3/tts/voice_clone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': ENV.ARK_API_KEY,
          'X-Api-Request-Id': require('crypto').randomUUID(),
        },
        body: JSON.stringify({
          speaker_id: 'custom_speaker_id',       // 后付费固定值
          custom_speaker_id: speakerId,          // 自定义音色代号
          audio: { data: audioBase64, format },
          language: language,                    // 0=中文
          extra_params: JSON.stringify({ disable_volume_normalization: true }),
        })
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}` };
      }
      saveEnv({ ARK_CLONED_SPEAKER_ID: speakerId });
      return { ok: true, speakerId, body };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
