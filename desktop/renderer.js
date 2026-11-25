// ---------- UI 状态 ----------
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const micSelect = document.getElementById('micSelect');
const outSelect = document.getElementById('outSelect');
const inMeter = document.getElementById('inMeter');
const outMeter = document.getElementById('homeOutMeter');
const homeOutMeter = document.getElementById('homeOutMeter');
const subs = document.getElementById('subs');
const micDiagBtn = document.getElementById('micDiagBtn'); // 已移除，保留兼容
const revInMeter = document.getElementById('revInMeter');
const revOutMeter = document.getElementById('homeRevOutMeter');

let running = false;
let audioCtx = null;
let analyser = null;
let meterRaf = null;
let mediaStream = null;

// ---------- 枚举麦克风 ----------
async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = '';
  devices
    .filter(d => d.kind === 'audioinput')
    .forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `麦克风 ${i + 1}`;
      micSelect.appendChild(opt);
    });

  // 默认选第一个真实物理麦克风（排除 BlackHole 等虚拟设备）
  const current = micSelect.value;
  const hasCurrent = [...micSelect.options].some(o => o.value === current);
  if (!hasCurrent) {
    const physical = [...micSelect.options].find(o => !/blackhole|cable|virtual/i.test(o.textContent));
    if (physical) micSelect.value = physical.value;
  }

  // 输出设备列表（含 BlackHole 等虚拟声卡）
  const prev = outSelect.value;
  outSelect.innerHTML = '<option value="">系统默认输出（耳机/扬声器）</option>';
  devices
    .filter(d => d.kind === 'audiooutput')
    .forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || '输出设备';
      outSelect.appendChild(opt);
    });
  // 默认优先选 BlackHole 2ch（上行专用）；其次恢复上次选择；否则系统默认
  const bh2 = [...outSelect.options].find(o => /blackhole\s*2/i.test(o.textContent)) 
           || [...outSelect.options].find(o => /blackhole/i.test(o.textContent) && !/16/i.test(o.textContent));
  if (prev) outSelect.value = prev;
  else if (bh2) outSelect.value = bh2.value;
}

// 首次没有权限时 label 为空，先申请一次
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(s => { s.getTracks().forEach(t => t.stop()); return listMics(); })
  .catch(err => console.warn('麦克风权限未授予:', err));

micSelect.addEventListener('focus', listMics);

// ---------- 常驻电平监控：应用启动即开始，与"开始同传"无关 ----------
async function startMetering() {
  try {
    // 依次尝试：选中的设备 → 列表里的物理设备 → 系统默认
    const candidates = [];
    if (micSelect.value) candidates.push(micSelect.value);
    const devs = await navigator.mediaDevices.enumerateDevices();
    devs.filter(d => d.kind === 'audioinput' && !/blackhole|cable|virtual|default/i.test(d.label))
      .forEach(d => { if (!candidates.includes(d.deviceId)) candidates.push(d.deviceId); });
    candidates.push(undefined); // 系统默认

    let lastErr = null;
    for (const deviceId of candidates) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[diag] 采集失败，尝试下一个设备:', deviceId || 'default', e.name, e.message);
      }
    }
    if (!mediaStream) throw lastErr || new Error('所有输入设备均失败');

    audioCtx = new AudioContext({ sampleRate: 16000 });
    const src = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    drawInMeter();
    statusEl.textContent = '监控中 · 点击"开始同传"开始翻译';
  } catch (err) {
    statusEl.textContent = '麦克风不可用';
    appendToast('麦克风启动失败: ' + ((err && err.name + ': ' + err.message) || err) + '\n（已尝试所有物理输入设备）');
    console.warn('常驻监控失败:', err);
  }
}

// ---------- 输入电平表 ----------
function drawInMeter() {
  if (!analyser) return;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  inMeter.style.width = `${Math.min(100, peak * 140)}%`;
  const hm = document.getElementById('homeInMeter'); if (hm) hm.style.width = inMeter.style.width;
  if (!running) {
    if (peak > 0.02) {
      meterSilenceStart = 0;
    } else {
      if (!meterSilenceStart) meterSilenceStart = Date.now();
      if (!meterRetried && Date.now() - meterSilenceStart > 3000) {
        meterRetried = true;
        // 不自动切换（系统默认输入可能被设成 BlackHole，切过去反而采不到人声）
        appendToast('提示：3秒未检测到声音。请检查：①对麦克风说话 ②系统设置→声音→输入选真实麦克风（不要选BlackHole）③应用麦克风下拉框选真实麦克风');
      }
    }
  }
  meterRaf = requestAnimationFrame(drawInMeter);
}

// 弹性电平轮询：每 60ms 读当前 analyser，不依赖单一 RAF 循环，
// 音频流重建/回退切换后自动恢复显示
setInterval(() => {
  if (!analyser) return;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  inMeter.style.width = `${Math.min(100, peak * 140)}%`;
  const hm = document.getElementById('homeInMeter'); if (hm) hm.style.width = inMeter.style.width;
}, 60);

let meterSilenceStart = 0;
let meterRetried = false;

function restartMeteringWithDefault() { /* 已移除自动回退，见静音提示 */ }

// 输出电平（占位：目前没有音频播放，画一条动画）
let outLevel = 0;
setInterval(() => {
  // 只在真的有英文音频播放时跳动（而不是整个运行期间乱闪）
  outLevel = (running && forwardPlayingCount > 0) ? 0.25 + Math.random() * 0.3 : 0;
  if (outMeter) outMeter.style.width = `${outLevel * 100}%`;
  if (homeOutMeter) homeOutMeter.style.width = `${outLevel * 100}%`;
}, 120);

// ---------- 开始 / 停止 ----------
async function startInterpretation() {
  // 1. 请求主进程连接豆包并 StartSession
  statusEl.textContent = '连接豆包中…';
  const voiceSel = document.getElementById('voice').value;
  const voiceOpt =
    voiceSel.includes('克隆') ? { useClone: true } :
    voiceSel.includes('女') ? { speakerId: 'zh_female_vv_uranus_bigtts' } :
    voiceSel.includes('男') ? { speakerId: 'zh_male_jingqiangkanye_emo_mars_bigtts' } :
    { speakerId: 'zh_female_vv_uranus_bigtts' }; // 默认标准女声
  const res = await window.ast.start(voiceOpt);
  if (!res.ok) {
    statusEl.textContent = '连接失败';
    appendToast(res.error);
    return;
  }

  running = true;
  statusEl.textContent = '同传中 · 请说话';
  startBtn.textContent = '停止';
  startBtn.classList.add('stop');
  startMicCapture();
  if (!document.getElementById('uplinkEnabled').checked) {
    appendToast('上行线路已关闭：你的声音不会发送给对方');
  }
  // 下行：本地采集常驻（应用启动即有）；点开始同传时若勾选启用，则建立云端翻译会话
  if (document.getElementById('bidirect').checked) {
    startReverseSession();
    const res = await window.ast2.start({ voice: document.getElementById('voice2').value });
    if (!res.ok) appendToast('双向翻译云端会话启动失败: ' + res.error);
  }
}

function stopInterpretation() {
  running = false;
  window.ast.stop();
  window.ast2.stop();
  stopReverseCapture();
  stopMicCapture();
  // 停止 TTS 播放并清空队列，防止残留音频继续播放
  try { playCtx && playCtx.close(); } catch {}
  playCtx = null;
  nextPlayTime = 0;
  currentTurnId = null;
  statusEl.textContent = '监控中 · 点击"开始同传"开始翻译';
  startBtn.textContent = '开始同传';
  startBtn.classList.remove('stop');
  outMeter.style.width = '0%';
}

// ---------- 麦克风 PCM 采集，发给豆包 ----------
let captureCtx = null;
let workletNode = null;

async function startMicCapture() {
  if (!mediaStream) return;
  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([`
    class PcmTap extends AudioWorkletProcessor {
      constructor() { super(); this._buf = []; this._count = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) {
          this._buf.push(new Float32Array(ch));
          this._count += ch.length;
          if (this._count >= 3200) { // 200ms @16k
            const merged = new Float32Array(this._count);
            let off = 0;
            for (const b of this._buf) { merged.set(b, off); off += b.length; }
            this.port.postMessage(merged);
            this._buf = []; this._count = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('pcm-tap', PcmTap);
  `], { type: 'application/javascript' })));

  const src = captureCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(captureCtx, 'pcm-tap');
  workletNode.port.onmessage = (e) => {
    if (!running) return;
    // float32 [-1,1] → int16 PCM
    const f = e.data;
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const uplinkOn = document.getElementById('uplinkEnabled').checked;
    if (forwardPlayingCount > 0 || !uplinkOn) {
      // 防回环或上行关闭：发送静音帧（保持会话活跃，不发送真实声音）
      i16.fill(0);
    }
    window.ast.sendAudio(i16.buffer);
  };
  src.connect(workletNode); // 不连 destination，避免回声
}

function stopMicCapture() {
  try { workletNode && workletNode.disconnect(); } catch {}
  try { captureCtx && captureCtx.close(); } catch {}
  workletNode = null; captureCtx = null;
}

// ---------- 豆包事件 → 字幕 + TTS 播放 ----------
let currentTurnId = null;
let playCtx = null;
let nextPlayTime = 0;

window.ast.onEvent((ev) => {
  switch (ev.event) {
    case 'SessionStarted':
      statusEl.textContent = document.getElementById('bidirect').checked
        ? '双向同传中'
        : (document.getElementById('uplinkEnabled').checked ? '同传中 · 请说话' : '仅下行 · 等待对方声音');
      break;
    case 'WsClosed':
      if (running) appendToast('连接已断开');
      break;
    case 'SessionFailed':
      statusEl.textContent = '会话失败';
      appendToast('SessionFailed: ' + (ev.message || '未知错误'));
      break;
    case 'SourceStart':
      currentTurnId = newTurn('（识别中…）');
      break;
    case 'SourceText':
      if (currentTurnId) updateTurn(currentTurnId, { zh: ev.text });
      break;
    case 'SourceEnd':
      if (currentTurnId) updateTurn(currentTurnId, { zh: ev.text });
      break;
    case 'TranslationStart':
      if (currentTurnId) updateTurn(currentTurnId, { en: '翻译中…' });
      break;
    case 'TranslationText':
      if (currentTurnId) updateTurn(currentTurnId, { en: ev.text });
      break;
    case 'TranslationEnd':
      if (currentTurnId) updateTurn(currentTurnId, { en: ev.text }, true);
      currentTurnId = null;
      if (ev.text) lastForwardEn = ev.text.trim().toLowerCase();
      break;
    case 'TtsAudio':
      playTtsPcm(ev.audio);
      break;
    case 'Error':
      appendToast('错误: ' + ev.message);
      break;
    default:
      console.log('[ast event]', ev.event);
  }
});

// ---------- 播放 TTS PCM（24kHz float32）→ 系统默认输出（耳机） ----------
function playTtsPcm(buf) {
  if (!playCtx) playCtx = new AudioContext({ sampleRate: 24000 });
  // 路由到选定的输出设备（BlackHole = 虚拟声卡；空 = 系统默认）
  if (outSelect.value && playCtx.setSinkId) {
    playCtx.setSinkId(outSelect.value).catch(err => appendToast('输出设备切换失败: ' + err.message));
  }
  const bytes = new Uint8Array(buf);
  const floats = new Float32Array(bytes.length / 4);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < floats.length; i++) floats[i] = dv.getFloat32(i * 4, true);
  const audioBuf = playCtx.createBuffer(1, floats.length, 24000);
  audioBuf.getChannelData(0).set(floats);
  const src = playCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  src.start(nextPlayTime);
  nextPlayTime += audioBuf.duration;
}

// ---------- 独立 TTS（克隆音色）：播放 mp3 → 默认输出/BlackHole ----------
window.ttsAudio.onAudio((mp3buf) => {
  // MP3 整句播放（已验证可用路径）
  const b = new Uint8Array(mp3buf);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  const url = 'data:audio/mpeg;base64,' + btoa(bin);

  const playTo = (sinkId) => {
    const a = new Audio(url);
    if (sinkId && a.setSinkId) a.setSinkId(sinkId).catch(() => {});
    a.onerror = () => appendToast('TTS 播放失败: bytes=' + b.length);
    forwardPlayingCount++;
    a.onended = () => { forwardPlayingCount = Math.max(0, forwardPlayingCount - 1); };
    a.play().catch(e => { appendToast('TTS 播放失败: ' + e.message); forwardPlayingCount = Math.max(0, forwardPlayingCount - 1); });
  };

  const selfMonitor = document.getElementById('selfMonitor').checked;
  if (outSelect.value) {
    playTo(outSelect.value);            // 主输出：虚拟声卡（给会议）
    if (selfMonitor) {
      // 监听必须走真实物理输出（排除 BlackHole 等），否则会二次进虚拟声卡造成重复
      navigator.mediaDevices.enumerateDevices().then(devs => {
        const phys = devs.find(d => d.kind === 'audiooutput' && !/blackhole|cable|virtual|default/i.test(d.label));
        playTo(phys ? phys.deviceId : '');
      });
    }
  } else {
    playTo('');
  }
});

// ---------- 双向翻译：BlackHole 采集对方声音 → EN→ZH → 中文TTS → 本机耳机 ----------
let revStream = null;
let revCtx = null;
let revWorklet = null;
let revTurnId = null;
let revAnalyser = null;
let revMeterRaf = null;

function drawRevMeterOnly() { /* 电平由 drawRevMeter 持续刷新，无需额外处理 */ }

function drawRevMeter() {
  if (!revAnalyser) return;
  const buf = new Float32Array(revAnalyser.fftSize);
  revAnalyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  revInMeter.style.width = `${Math.min(100, peak * 140)}%`;
  const hr = document.getElementById('homeRevInMeter'); if (hr) hr.style.width = revInMeter.style.width;
  revMeterRaf = requestAnimationFrame(drawRevMeter);
}
let forwardPlayingCount = 0;   // 正向TTS正在播放的音频数量（>0 时反向采集静音防回环）
let lastForwardEn = '';        // 最近一次发给对方的英文（用于字幕级去重）

async function startReverseSession() {
  if (revStream) return; // 已在运行
  // 找 BlackHole 输入设备
  const devs = await navigator.mediaDevices.enumerateDevices();
  // 优先用独立的 BlackHole 16ch（专门接收会议对方声音，避免与正向TTS同设备导致回环）
  const bh = devs.find(d => d.kind === 'audioinput' && /blackhole.*16/i.test(d.label))
          || devs.find(d => d.kind === 'audioinput' && /blackhole/i.test(d.label));
  if (!bh) { appendToast('双向翻译：未找到 BlackHole 输入设备'); return; }
  if (!/16/i.test(bh.label)) {
    appendToast('⚠️ 建议安装 BlackHole 16ch 作为反向采集专用设备（brew install --cask blackhole-16ch），否则可能与正向英文互相串音');
  }
  try {
    revStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: bh.deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const rt = revStream.getAudioTracks()[0];
    console.log('[rev] track =', rt.label, '| settings =', JSON.stringify(rt.getSettings()));
    revCtx = new AudioContext({ sampleRate: 16000 });
    if (revCtx.state === 'suspended') await revCtx.resume();
    await revCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([`
      class PcmTap2 extends AudioWorkletProcessor {
        constructor() { super(); this._buf = []; this._count = 0; }
        process(inputs) {
          const ch = inputs[0][0];
          if (ch) {
            this._buf.push(new Float32Array(ch));
            this._count += ch.length;
            if (this._count >= 3200) {
              const merged = new Float32Array(this._count);
              let off = 0;
              for (const b of this._buf) { merged.set(b, off); off += b.length; }
              this.port.postMessage(merged);
              this._buf = []; this._count = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('pcm-tap2', PcmTap2);
    `], { type: 'application/javascript' })));
    const src = revCtx.createMediaStreamSource(revStream);
    revAnalyser = revCtx.createAnalyser();
    revAnalyser.fftSize = 2048;
    src.connect(revAnalyser);
    drawRevMeter();
    revWorklet = new AudioWorkletNode(revCtx, 'pcm-tap2');
    revWorklet.port.onmessage = (e) => {
      if (forwardPlayingCount > 0) return;   // 正在播自己的英文，忽略反向输入防回环
      if (!running) { drawRevMeterOnly(); return; }   // 未开始同传：只监控电平，不送云端
      const f = e.data;
      const i16 = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const sv = Math.max(-1, Math.min(1, f[i]));
        i16[i] = sv < 0 ? sv * 0x8000 : sv * 0x7FFF;
      }
      window.ast2.sendAudio(i16.buffer);
    };
    src.connect(revWorklet);
    statusEl.textContent = '双向同传中';
  } catch (err) {
    appendToast('双向翻译采集失败: ' + err.message);
  }
}

function stopReverseCapture() {
  try { revWorklet && revWorklet.disconnect(); } catch {}
  try { revStream && revStream.getTracks().forEach(t => t.stop()); } catch {}
  try { revCtx && revCtx.close(); } catch {}
  cancelAnimationFrame(revMeterRaf);
  revWorklet = null; revStream = null; revCtx = null; revAnalyser = null;
  revInMeter.style.width = '0%';
  revOutMeter.style.width = '0%';
  revTurnId = null;
}

// 反向事件 → 字幕（英文原文 + 中文译文）+ 中文语音回放耳机
window.ast2.onEvent((ev) => {
  switch (ev.event) {
    case 'SourceStart': revTurnId = newTurn('（对方说话中…）', 'rev'); break;
    case 'SourceText':
      if (revTurnId) updateTurn(revTurnId, { zh: ev.text }); // rev 模式 zh 字段=英文原文
      break;
    case 'SourceEnd':
      if (revTurnId) updateTurn(revTurnId, { zh: ev.text });
      break;
    case 'TranslationEnd': {
      const isSelfEcho = ev.text && ev.text.trim().toLowerCase() === lastForwardEn;
      if (revTurnId && !isSelfEcho) updateTurn(revTurnId, { en: ev.text }, true);
      revTurnId = null;
      // 自我回声：撤掉该轮字幕（正向TTS已让 forwardPlayingCount>0 时音频已被丢弃，这里兜底文本级去重）
      if (isSelfEcho) break;
      break; }
    case 'TranslationText': {
      const isSelfEchoTxt = ev.text && ev.text.trim().toLowerCase() === lastForwardEn;
      if (revTurnId && !isSelfEchoTxt) updateTurn(revTurnId, { en: ev.text });
      break; }
    case 'Error':
      appendToast('双向翻译: ' + ev.message);
      break;
  }
});

// 中文 TTS 回放 → 系统默认输出（物理耳机），不进 BlackHole
window.tts2Audio.onAudio((mp3buf) => {
  const b = new Uint8Array(mp3buf);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  const a = new Audio('data:audio/mpeg;base64,' + btoa(bin));
  if (a.setSinkId) a.setSinkId('').catch(() => {});
  revOutMeter.style.width = '80%';
  const hro = document.getElementById('homeRevOutMeter'); if (hro) hro.style.width = '80%';
  a.onended = () => { revOutMeter.style.width = '0%'; if (hro) hro.style.width = '0%'; };
  a.play().catch(e => appendToast('中文回放失败: ' + e.message));
});

function appendToast(msg) {
  const div = document.createElement('div');
  div.className = 'turn pending';
  div.innerHTML = `<div class="idx">⚠️</div><div class="line zh"><div class="text"></div></div>`;
  div.querySelector('.text').textContent = msg;
  div.style.userSelect = 'text';
  div.style.webkitUserSelect = 'text';
  div.title = '双击复制错误信息';
  div.addEventListener('dblclick', () => navigator.clipboard.writeText(msg).catch(() => {}));
  console.error('[PipeLingo][error]', msg);
  subs.appendChild(div);
  subs.scrollTop = subs.scrollHeight;
}

startBtn.addEventListener('click', () => (running ? stopInterpretation() : startInterpretation()));

// ---------- 录制10秒 → 训练专属克隆音色 ----------
const cloneBtn = document.getElementById('cloneBtn');
let recording = false;

if (cloneBtn) cloneBtn.addEventListener('click', async () => {
  if (recording) return;
  if (!mediaStream || !audioCtx) { alert('请先等麦克风就绪'); return; }
  recording = true;
  const origText = cloneBtn.textContent;
  const chunks = [];
  const tmpAnalyser = audioCtx.createAnalyser();
  audioCtx.createMediaStreamSource(mediaStream).connect(tmpAnalyser);
  const buf = new Float32Array(tmpAnalyser.fftSize);
  const collectedMax = audioCtx.sampleRate * 10;
  let collected = 0;

  for (let sec = 10; sec > 0; sec--) {
    cloneBtn.textContent = `🎙️ 请持续说话… ${sec}s`;
    const secSamples = audioCtx.sampleRate;
    let got = 0;
    while (got < secSamples && collected < collectedMax) {
      tmpAnalyser.getFloatTimeDomainData(buf);
      chunks.push(new Float32Array(buf));
      got += buf.length;
      collected += buf.length;
      await new Promise(r => setTimeout(r, Math.max(10, 1000 * buf.length / audioCtx.sampleRate - 10)));
    }
  }
  cloneBtn.textContent = '⏳ 上传训练中…';

  // 拼 PCM → WAV(16k, mono, 16bit)
  const all = new Float32Array(collected);
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, collected - off);
    all.set(c.subarray(0, n), off);
    off += n;
  }
  const i16 = new Int16Array(all.length);
  for (let i = 0; i < all.length; i++) {
    const s = Math.max(-1, Math.min(1, all[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const wav = encodeWav(i16, audioCtx.sampleRate);
  const b64 = arrayBufferToBase64(wav);

  const res = await window.ast.cloneTrain({ audioBase64: b64, format: 'wav', language: 0 });
  recording = false;
  cloneBtn.textContent = origText;
  if (res.ok) {
    alert('✅ 克隆音色训练成功！以后"我的声音（复刻）"将使用这个高像度专属音色。\n\n音色ID: ' + res.speakerId);
  } else {
    alert('❌ 训练失败: ' + res.error);
  }
});

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return buf;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 应用启动即常驻监控电平（上行麦克风 + 下行 BlackHole）
startMetering();
startReverseSession();   // 只要设备在，下行采集与电平就常驻（是否送云端由"开始同传"决定）

// ---------- 对话列表：一句原文 + 一句译文 成对显示 ----------
let turnSeq = 0;

/**
 * 新建一轮对话（识别到一句新的原文时调用）
 * @param {string} zhText 中文原文（可先给占位文本，后续 updateTurn 更新）
 * @returns {number} turnId，用于后续更新译文
 */
function newTurn(zhText = '（识别中…）', dir = 'fwd') {
  turnSeq += 1;
  const div = document.createElement('div');
  div.className = 'turn pending';
  div.dataset.turnId = String(turnSeq);
  div.dataset.dir = dir;
  const srcLang = dir === 'rev' ? '原文 · English' : '原文 · 中文';
  const dstLang = dir === 'rev' ? '译文 · 中文' : '译文 · English';
  const srcCls = dir === 'rev' ? 'en' : 'zh';
  const dstCls = dir === 'rev' ? 'zh' : 'en';
  div.innerHTML = `
    <div class="idx">#${turnSeq}${dir === 'rev' ? ' 🔁' : ''}</div>
    <div class="line ${srcCls}"><div class="lang">${srcLang}</div><div class="text"></div></div>
    <div class="line ${dstCls}"><div class="lang">${dstLang}</div><div class="text">翻译中…</div></div>
  `;
  div.querySelector('.line.' + srcCls + ' .text').textContent = zhText;
  // 新发言追加到底部（对话习惯：越晚越往下），并自动滚到底
  subs.appendChild(div);
  while (subs.children.length > 200) subs.removeChild(subs.firstChild);
  subs.scrollTop = subs.scrollHeight;
  return turnSeq;
}

/**
 * 更新某一轮的内容（流式 ASR/翻译时反复调用）
 * @param {number} turnId newTurn 返回的 id
 * @param {{zh?: string, en?: string}} patch 要更新的字段
 * @param {boolean} done 是否已完成（去掉"翻译中"样式）
 */
function updateTurn(turnId, patch = {}, done = false) {
  const div = subs.querySelector(`.turn[data-turn-id="${turnId}"]`);
  if (!div) return;
  const rev = div.dataset.dir === 'rev';
  const srcSel = rev ? '.line.en .text' : '.line.zh .text';
  const dstSel = rev ? '.line.zh .text' : '.line.en .text';
  if (patch.zh !== undefined) div.querySelector(srcSel).textContent = patch.zh;
  if (patch.en !== undefined) div.querySelector(dstSel).textContent = patch.en;
  if (done) div.classList.remove('pending');
  subs.scrollTop = subs.scrollHeight;
}

// 暴露给 Step 3 使用
window.__pipelingo = { newTurn, updateTurn, getMicStream: () => mediaStream, audioCtx: () => audioCtx };

// —— 本地演示：模拟一句一句翻译的效果（接豆包后删除）——
if (new URLSearchParams(location.search).get('demo') === '1') {
  let demoSeq = 0;
  const demoLines = [
    ['大家好，今天我们过一下项目进度。', "Hi everyone, let's go over the project status."],
    ['首先看一下上周完成的三个任务。', 'First, let’s look at the three tasks completed last week.'],
    ['然后讨论一下这周要做的两件事。', 'Then let’s discuss the two things planned for this week.'],
  ];
  setInterval(() => {
    if (!running) return;
    const [zh, en] = demoLines[demoSeq % demoLines.length];
    const id = newTurn(zh);
    setTimeout(() => updateTurn(id, { en }, true), 900); // 模拟翻译延迟
    demoSeq += 1;
  }, 4000);
}

// ---------- PCM 流式播放（24k，自动 int16/float32）→ 路由输出 ----------
let streamCtx = null;
let streamNextTime = 0;
function playPcmStream(floats, sampleRate = 24000) {
  if (!streamCtx || streamCtx.sampleRate !== sampleRate) {
    try { streamCtx && streamCtx.close(); } catch {}
    streamCtx = new AudioContext({ sampleRate });
    streamNextTime = 0;
  }
  const audioBuf = streamCtx.createBuffer(1, floats.length, sampleRate);
  audioBuf.getChannelData(0).set(floats);

  const schedule = (ctx, sinkId) => {
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    if (sinkId && ctx.setSinkId) ctx.setSinkId(sinkId).catch(() => {});
    const now = ctx.currentTime;
    if (ctx.__nextTime === undefined || ctx.__nextTime < now + 0.05) ctx.__nextTime = now + 0.05;
    src.start(ctx.__nextTime);
    ctx.__nextTime += audioBuf.duration;
  };

  const selfMonitor = document.getElementById('selfMonitor').checked;
  if (outSelect.value) {
    schedule(streamCtx, outSelect.value);   // 主输出：虚拟声卡（给会议）
    if (selfMonitor) {
      if (!window.__monCtx) window.__monCtx = new AudioContext({ sampleRate: 24000 });
      schedule(window.__monCtx, '');        // 副输出：本机监听
    }
  } else {
    schedule(streamCtx, '');                // 自测模式
  }
}

// ---------- 设置 Dialog ----------
const settingsMask = document.getElementById('settingsMask');
document.getElementById('openSettings').addEventListener('click', () => settingsMask.classList.add('open'));
document.getElementById('closeSettings').addEventListener('click', () => settingsMask.classList.remove('open'));
document.getElementById('saveSettings').addEventListener('click', () => settingsMask.classList.remove('open'));
settingsMask.addEventListener('click', (e) => { if (e.target === settingsMask) settingsMask.classList.remove('open'); });

// ---------- 主页状态条同步 ----------
function refreshStrip() {
  const stripUp = document.getElementById('stripUp');
  const stripDown = document.getElementById('stripDown');
  const up = document.getElementById('uplinkEnabled').checked;
  const down = document.getElementById('bidirect').checked;
  stripUp.classList.toggle('on', running && up);
  stripUp.textContent = (running && up) ? '⬆️ 上行 · 工作中' : '⬆️ 上行 · ' + (up ? '待启动' : '已关闭');
  stripDown.classList.toggle('on', running && down);
  stripDown.textContent = (running && down) ? '⬇️ 下行 · 工作中' : '⬇️ 下行 · ' + (down ? '待启动' : '已关闭');
}
['uplinkEnabled','bidirect','voice'].forEach(id => {
  const el = document.getElementById(id);
  el && el.addEventListener('change', refreshStrip);
});

// 下行线路开关：勾选即常驻采集（电平实时闪，同麦克风监控），与"开始同传"无关
document.getElementById('bidirect').addEventListener('change', (e) => {
  if (e.target.checked) startReverseSession();
  else {
    window.ast2.stop();
    stopReverseCapture();
  }
});
refreshStrip();
// 开始/停止时同步
startBtn.addEventListener('click', () => setTimeout(refreshStrip, 100));
setInterval(refreshStrip, 1000);   // 状态条每秒刷新
