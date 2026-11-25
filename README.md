# PipeLingo 🎙️

Real-time simultaneous interpretation desktop app for online meetings.

Speak Chinese into your physical microphone — PipeLingo streams it through Doubao's simultaneous interpretation model and plays the English translation with your own cloned voice into a virtual audio device, so Zoom / Tencent Meeting / Teams participants hear you speak English in real time.

```
Physical mic ──► ASR + Translation (Doubao AST 2.0, streaming)
                        │  English text (sentence by sentence, with source)
                        ▼
              Standalone TTS (seed-icl-2.0, your cloned voice)
                        │  MP3
                        ▼
        Local speakers (self-monitor) + BlackHole virtual device
                        ▼
              Zoom / Tencent Meeting / Teams (mic = BlackHole)
```

## Features

- 🖥️ Cross-platform desktop UI (Electron), dark theme
- 🎤 Live microphone level meter (always-on monitoring)
- 💬 Conversation-style subtitle list: each sentence pairs source (中文) with translation (English)
- 🔊 Output routing: system default (self-test) or BlackHole 2ch (meeting mode)
- 👂 Self-monitor toggle: hear the translation yourself while the meeting hears it
- 🗣️ Voice options: your cloned voice (default) / premium male & female voices
- 🔁 Echo cancellation enabled on capture
- ⚡ Low latency: streaming ASR + translation; per-sentence TTS synthesis starts as soon as the sentence completes

## Requirements

- macOS (tested on Intel Mac; Windows support planned with VB-Cable)
- Node.js ≥ 20
- A [Volcengine](https://www.volcengine.com) account with:
  - **Ark (火山方舟)** API Key — for the simultaneous interpretation model
  - **Doubao Voice** — Voice Clone 2.0 (`seed-icl-2.0`) enabled, with a trained voice
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) virtual audio driver (for meeting mode)

```bash
brew install --cask blackhole-2ch
```

## Setup

1. Install dependencies:

```bash
cd desktop
npm install
```

2. Copy the env template and fill in your credentials:

```bash
cp .env.example .env
```

```dotenv
# Ark API Key (console → API Key management)
ARK_API_KEY=your-api-key
# Inference endpoint id (console → online inference) — reserved for future use
ARK_ENDPOINT_ID=ep-xxxxxxxx
# Voice Clone 2.0 speaker id from console voice library (S_xxxxxxxx)
ARK_CLONED_SPEAKER_ID=S_xxxxxxxx
# Optional: legacy console credentials for the voice-clone HTTP API
VOICE_APP_ID=123456789
VOICE_ACCESS_KEY=your-access-token
```

> `.env` is git-ignored. Never commit real credentials.

3. Run:

```bash
npm start
```

## Usage

1. Launch the app — microphone monitoring starts automatically (level meter should react to your voice).
2. Pick the output device:
   - **System default** → hear the English yourself (self-test)
   - **BlackHole 2ch** → send English into the virtual device (meeting mode)
3. Keep **"同时在本机监听"** checked if you want to hear the translation while the meeting hears it.
4. Choose a voice — default is your cloned voice.
5. Click **开始同传** and speak Chinese. English audio plays within ~2 seconds; participants hear it through the meeting's microphone (set to BlackHole 2ch).
6. Click **停止** to end interpretation.

### Meeting software configuration

| Setting | Value |
|---|---|
| Microphone | BlackHole 2ch |
| Speaker | Your own headphones/speakers (unchanged) |

## Architecture

```
desktop/
├── main.js           # Electron main process: .env, IPC, session lifecycle
├── preload.js        # contextBridge API (ast.*)
├── renderer.js       # UI logic: mic capture, meters, subtitles, playback
├── ast_client.js     # Doubao AST 2.0 WebSocket client (protobuf framing)
├── tts_client.js     # Standalone TTS SSE client (seed-icl-2.0)
├── tts_bidirect.js   # Experimental bidirectional TTS WebSocket client
├── protos/ast.proto  # AST wire protocol definition
└── index.html        # UI
```

### Pipeline

1. Mic capture via `getUserMedia` + AudioWorklet (16 kHz, 16-bit PCM, 200 ms frames).
2. Frames are sent over IPC to the main process and pushed to the AST WebSocket (`wss://openspeech.bytedance.com/api/v4/ast/v2/translate`, protobuf binary protocol).
3. `SourceSubtitle*` / `TranslationSubtitle*` events update the subtitle list in real time.
4. On each completed sentence, the English text is sent to the streaming TTS endpoint (`/api/v3/tts/unidirectional/sse`) with your cloned speaker; MP3 chunks are merged and played via dual-routed `<audio>` elements (virtual device + local monitor).

## Known limitations

- Latency is roughly 1–3 s end-to-end (ASR sentence segmentation + TTS synthesis). The bidirectional TTS streaming protocol is implemented experimentally (`tts_bidirect.js`) but disabled pending upstream protocol stabilization.
- Echo: use headphones when self-monitor is enabled on speakers.
- Windows: not yet packaged; requires VB-Cable instead of BlackHole.

## License

MIT
