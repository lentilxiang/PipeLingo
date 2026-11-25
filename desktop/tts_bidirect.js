const WebSocket = require('ws');
const crypto = require('crypto');

const URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

// ---- 二进制协议（与官方 protocols.py 对齐）----
const TYPE = { FullClientRequest: 1, AudioOnlyServer: 0b1011, FullServerResponse: 0b1001, Error: 0b1111 };
const FLAG = { NoSeq: 0, WithEvent: 0b100 };
const EV = {
  StartConnection: 1, FinishConnection: 2, ConnectionStarted: 50, ConnectionFailed: 51,
  ConnectionFinished: 52, StartSession: 100, FinishSession: 102, SessionStarted: 150,
  SessionFinished: 152, SessionFailed: 153, TaskRequest: 200,
  TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352,
};
const CONN_EVENTS = new Set([EV.StartConnection, EV.FinishConnection, EV.ConnectionStarted, EV.ConnectionFailed, EV.ConnectionFinished]);

function frame(type, flag, event, sessionId, payload) {
  const head = Buffer.from([0x11, (type << 4) | flag, (1 << 4) | 0, 0]);
  const parts = [head];
  if (flag === FLAG.WithEvent) {
    const e = Buffer.alloc(4); e.writeInt32BE(event); parts.push(e);
    if (!CONN_EVENTS.has(event)) {
      const s = Buffer.from(sessionId || '', 'utf8');
      const l = Buffer.alloc(4); l.writeUInt32BE(s.length); parts.push(l, s);
    }
  }
  const p = Buffer.from(payload || '');
  const l = Buffer.alloc(4); l.writeUInt32BE(p.length); parts.push(l, p);
  return Buffer.concat(parts);
}

function parse(buf) {
  const msgType = buf[1] >> 4, flag = buf[1] & 0xF;
  let off = 4; // header size 固定 4（0x11）
  let sequence = 0;
  if ([TYPE.FullClientRequest, TYPE.FullServerResponse, TYPE.AudioOnlyServer, 0b1100, TYPE.AudioOnlyServer].includes(msgType) && (flag === 1 || flag === 3)) {
    sequence = buf.readInt32BE(off); off += 4;
  }
  let errorCode = 0;
  if (msgType === TYPE.Error) { errorCode = buf.readUInt32BE(off); off += 4; }
  let event = 0, sessionId = '', connectId = '';
  if (flag === FLAG.WithEvent) {
    event = buf.readInt32BE(off); off += 4;
    if (!CONN_EVENTS.has(event)) {
      const sl = buf.readUInt32BE(off); off += 4;
      sessionId = buf.slice(off, off + sl).toString('utf8'); off += sl;
    }
    if (msgType === TYPE.FullServerResponse && [EV.ConnectionStarted, EV.ConnectionFailed, EV.ConnectionFinished].includes(event)) {
      const cl = buf.readUInt32BE(off); off += 4;
      connectId = buf.slice(off, off + cl).toString('utf8'); off += cl;
    }
  }
  const pl = buf.readUInt32BE(off); off += 4;
  const payload = buf.slice(off, off + pl);
  return { msgType, flag, event, sessionId, connectId, sequence, errorCode, payload };
}

class BidirectTTS {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.speaker = opts.speaker;
    this.onAudio = opts.onAudio || (() => {});
    this.onEnd = opts.onEnd || (() => {});
    this.onError = opts.onError || (() => {});
    this.ws = null;
    this.sessionId = crypto.randomUUID();
    this.started = false;
    this.finished = false;
    this.queue = [];
    this.finishPending = false;
    this.pumping = false;
  }

  async open() {
    this.ws = new WebSocket(URL, {
      headers: {
        'X-Api-Key': this.apiKey,
        'X-Api-Resource-Id': 'seed-icl-2.0',
        'X-Api-Connect-Id': crypto.randomUUID(),
      }
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
      this.ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    this.ws.on('message', (buf) => this._onMsg(buf));
    this.ws.on('close', () => { if (!this.finished) this.onEnd(); });
    // StartConnection
    this.ws.send(frame(TYPE.FullClientRequest, FLAG.WithEvent, EV.StartConnection, '', '{}'));
    await this._waitFor(EV.ConnectionStarted);
    // StartSession
    const payload = JSON.stringify({
      event: EV.StartSession,
      session_id: this.sessionId,
      req_params: {
        speaker: this.speaker,
        model: 'seed-tts-2.0-standard',
        audio_params: { format: 'pcm', sample_rate: 24000 },
      }
    });
    this.ws.send(frame(TYPE.FullClientRequest, FLAG.WithEvent, EV.StartSession, this.sessionId, payload));
    await this._waitFor(EV.SessionStarted);
    this.started = true;
  }

  sendText(delta) {
    if (!delta) return;
    this.queue.push(delta);
    this._pump();
  }

  finish() {
    this.finishPending = true;
    this._pump();
  }

  _pump() {
    if (this.pumping || !this.started) return;
    this.pumping = true;
    const step = () => {
      if (this.ws === null) { this.pumping = false; return; }
      if (this.queue.length) {
        const text = this.queue.shift();
        const payload = JSON.stringify({
          event: EV.TaskRequest,
          session_id: this.sessionId,
          req_params: {
            speaker: this.speaker,
            model: 'seed-tts-2.0-standard',
            audio_params: { format: 'pcm', sample_rate: 24000 },
            text,
          },
        });
        this.ws.send(frame(TYPE.FullClientRequest, FLAG.WithEvent, EV.TaskRequest, this.sessionId, payload));
        setTimeout(step, 10);
      } else if (this.finishPending) {
        this.finished = true;
        this.ws.send(frame(TYPE.FullClientRequest, FLAG.WithEvent, EV.FinishSession, this.sessionId, JSON.stringify({ event: EV.FinishSession })));
        this.pumping = false;
      } else {
        this.pumping = false;
      }
    };
    step();
  }

  destroy() {
    try { this.finish(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
  }

  _waitFor(ev) {
    return new Promise((res, rej) => {
      const h = (buf) => {
        const m = parse(buf);
        if (m.msgType === TYPE.Error) { rej(new Error(`TTS err ${m.errorCode}: ${m.payload}`)); return; }
        if (m.event === ev) { this.ws.removeListener('message', h); res(m); }
        else this._handle(m);
      };
      this.ws.on('message', h);
    });
  }

  _onMsg(buf) {
    const m = parse(buf);
    this._handle(m);
  }

  _handle(m) {
    if (process.env.ARK_TTS_DEBUG) {
      console.log('[tts] ev=%s type=%s payload=%d', m.event, m.msgType, m.payload.length);
    }
    if (m.msgType === TYPE.Error) { this.onError(new Error(`TTS err ${m.errorCode}: ${m.payload}`)); return; }
    if (m.event === EV.SessionFailed) {
      this.onError(new Error('TTS SessionFailed: ' + m.payload.toString('utf8').slice(0, 200)));
      return;
    }
    if (m.msgType === TYPE.AudioOnlyServer && m.payload.length) this.onAudio(m.payload);
    if (m.event === EV.SessionFinished) this.onEnd();
  }
}

module.exports = { BidirectTTS };
