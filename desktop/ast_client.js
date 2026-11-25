const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const protobuf = require('protobufjs');

const WS_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';
const RESOURCE_ID = 'volc.service_type.10053';
const CLONE_MODE = process.env.ARK_CLONE_MODE || '1'; // 1/2/3 三种克隆音色参数组合

const EV = {
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFailed: 153,
  SessionFinished: 152,
  UsageResponse: 154,
  TaskRequest: 200,
  UpdateConfig: 201,
  AudioMuted: 250,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  SourceSubtitleStart: 650,
  SourceSubtitleResponse: 651,
  SourceSubtitleEnd: 652,
  TranslationSubtitleStart: 653,
  TranslationSubtitleResponse: 654,
  TranslationSubtitleEnd: 655,
};

class AstClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {(ev: object) => void} opts.onEvent  收到服务端事件时回调
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.onEvent = opts.onEvent || (() => {});
    this.onError = opts.onError || (() => {});
    this.ws = null;
    this.sessionId = crypto.randomUUID();
    this.connectId = crypto.randomUUID();
    this.types = null;
    this.open = false;
    this.sessionActive = false;
    this.textOnlyMode = false;
  }

  async loadProto() {
    if (this.types) return;
    const root = await protobuf.load(path.join(__dirname, 'protos', 'ast.proto'));
    const T = root.lookupType('ast.TranslateRequest');
    const R = root.lookupType('ast.TranslateResponse');
    this.types = { T, R };
  }

  async connect() {
    await this.loadProto();
    this.ws = new WebSocket(WS_URL, {
      headers: {
        'X-Api-Key': this.apiKey,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Connect-Id': this.connectId,
      }
    });

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`)));
    });

    this.ws.on('message', (buf) => this._handleMessage(buf));
    this.ws.on('error', (err) => this.onError(err));
    this.ws.on('close', () => {
      this.open = false;
      this.onEvent({ event: 'WsClosed' });
    });
    this.open = true;
  }

  /**
   * @param {object} [voice]
   * @param {boolean} [voice.clone] 复刻输入说话人音色（默认行为）
   * @param {string} [voice.speakerId] 指定精品音色
   */
  startSession(voice = {}) {
    const reqParams = voice.langs || { mode: 's2s', sourceLanguage: 'zh', targetLanguage: 'en' };
    if (process.env.ARK_TTS_DEBUG) {
      console.log('[ast] startSession voice =', JSON.stringify(voice), '| req =', JSON.stringify(voice.textOnly ? { ...reqParams, mode: 's2t' } : reqParams));
    }
    if (voice.clonedSpeakerId) {
      // 官方 is_custom_speaker: 默认 false，「是否复刻音色（触发鉴权）」
      //   - 克隆音色 S_... 必须 true + tts_resource_id=seed-icl-2.0
      //   - 精品音色（zh_female_vv_uranus_bigtts 等两个公版）/ 不指定音色 → 不传（false/缺省）
      reqParams.speakerId = voice.clonedSpeakerId;
      if (CLONE_MODE === '1') {
        // 组合1（默认）：外接克隆音色 + 显式 seed-icl-2.0 链路，触发鉴权
        reqParams.isCustomSpeaker = true;
        reqParams.ttsResourceId = 'seed-icl-2.0';
      } else if (CLONE_MODE === '2') {
        // 组合2：不触发鉴权（服务端按已注册音色匹配），is_custom_speaker=false
        reqParams.isCustomSpeaker = false;
      } else {
        // 组合3（.env 当前=3）：走通用复刻链路 seed-tts-2.0，不传 is_custom_speaker
        reqParams.ttsResourceId = 'seed-tts-2.0';
      }
    } else if (voice.speakerId) {
      reqParams.speakerId = voice.speakerId;
    }
    // 注意：官方 rpcmeta.proto 里 RequestMeta 字段是 PascalCase（SessionID/ConnectionID），
    // protobufjs 原样保留，写成 sessionID/connectionID 会被静默丢弃，服务端收不到 session_id。
    const req = this.types.T.create({
      requestMeta: { SessionID: this.sessionId, ConnectionID: this.connectId },
      event: EV.StartSession,
      user: { uid: 'pipelingo', did: 'mac', platform: 'macOS', sdkVersion: '1.0.0' },
      sourceAudio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      targetAudio: voice.textOnly ? undefined : { format: 'pcm', rate: 24000 },
      request: voice.textOnly ? { ...reqParams, mode: 's2t' } : reqParams,
    });
    this._send(req);
    this.textOnlyMode = !!voice.textOnly;
  }

  sendAudio(pcmInt16Buf) {
    if (!this.sessionActive || !this.open) return;
    const req = this.types.T.create({
      requestMeta: { SessionID: this.sessionId },
      event: EV.TaskRequest,
      sourceAudio: { binaryData: pcmInt16Buf },
    });
    this._send(req);
  }

  finish() {
    if (!this.open) return;
    const req = this.types.T.create({
      requestMeta: { SessionID: this.sessionId },
      event: EV.FinishSession,
    });
    this._send(req);
    this.sessionActive = false;
  }

  close() {
    try { this.finish(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    this.open = false;
  }

  _send(msg) {
    const buf = this.types.T.encode(msg).finish();
    this.ws.send(Buffer.from(buf));
  }

  _handleMessage(buf) {
    let res;
    try {
      res = this.types.R.decode(buf);
    } catch (e) {
      this.onError(new Error('protobuf decode failed: ' + e.message));
      return;
    }
    const ev = res.event;
    console.log('[ast] event =', ev, 'text =', res.text || '', 'dataBytes =', res.data ? res.data.length : 0);

    if (ev === EV.SessionStarted) {
      this.sessionActive = true;
      this.onEvent({ event: 'SessionStarted' });
    } else if (ev === EV.SessionFailed) {
      // ResponseMeta.Message 同样是 PascalCase，写成 .message 会取到 undefined
      this.onEvent({ event: 'SessionFailed',
        message: res.responseMeta ? (res.responseMeta.Message || '') : '' });
    } else if (ev === EV.SourceSubtitleStart) {
      this.onEvent({ event: 'SourceStart' });
    } else if (ev === EV.SourceSubtitleResponse) {
      this.onEvent({ event: 'SourceText', text: res.text });
    } else if (ev === EV.SourceSubtitleEnd) {
      this.onEvent({ event: 'SourceEnd', text: res.text });
    } else if (ev === EV.TranslationSubtitleStart) {
      this.onEvent({ event: 'TranslationStart' });
    } else if (ev === EV.TranslationSubtitleResponse) {
      this.onEvent({ event: 'TranslationText', text: res.text });
    } else if (ev === EV.TranslationSubtitleEnd) {
      this.onEvent({ event: 'TranslationEnd', text: res.text });
    } else if (ev === EV.TTSResponse) {
      this.onEvent({ event: 'TtsAudio', audio: Buffer.from(res.data) });
    } else if (ev === EV.TTSSentenceStart) {
      this.onEvent({ event: 'TtsStart' });
    } else if (ev === EV.TTSSentenceEnd) {
      this.onEvent({ event: 'TtsEnd' });
    } else if (ev === EV.UsageResponse) {
      this.onEvent({ event: 'Usage' });
    } else if (ev === EV.SessionFinished) {
      this.onEvent({ event: 'SessionFinished' });
    }
  }
}

module.exports = { AstClient };
