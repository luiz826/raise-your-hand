// Duplex spike: full-duplex voice with OpenAI Realtime (server VAD + native
// interruption). Mic → PCM16 24kHz → WebSocket straight to OpenAI (ephemeral
// token from our backend); audio deltas → scheduled playback; server speech
// events drive the UI. No push-to-talk — talk over it and it stops.
"use strict";

const $ = (id) => document.getElementById(id);
const log = (cls, text) => {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
};
const setStatus = (t, on) => { $("status").textContent = t; $("status").classList.toggle("on", !!on); };

let ws = null, audioCtx = null, micStream = null, processor = null;
let playTime = 0;          // next scheduled playback time
let playingSources = [];   // scheduled buffers (cleared on interruption)
let assistantBuf = "";

// --- PCM helpers ------------------------------------------------------------
function floatToPcm16Base64(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(bin);
}
function base64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
  return f;
}

function playChunk(b64) {
  const f32 = base64ToFloat32(b64);
  const buf = audioCtx.createBuffer(1, f32.length, 24000);
  buf.getChannelData(0).set(f32);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  playTime = Math.max(playTime, audioCtx.currentTime);
  src.start(playTime);
  playTime += buf.duration;
  playingSources.push(src);
  src.onended = () => { playingSources = playingSources.filter((s) => s !== src); };
}

function interruptPlayback() {
  for (const s of playingSources) { try { s.stop(); } catch (_) {} }
  playingSources = [];
  playTime = 0;
  log("int", "⚡ interrupted — listening to you");
  if (assistantBuf.trim()) { log("ta", `TA (cut off): ${assistantBuf}`); assistantBuf = ""; }
}

async function start() {
  $("start").disabled = true;
  setStatus("minting session…");
  const backend = $("backend").value.replace(/\/$/, "");
  let token, grounded;
  try {
    const res = await fetch(`${backend}/realtime-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId: $("playlist").value.trim(), language: $("lang").value.trim() }),
    });
    if (!res.ok) throw new Error(`backend HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    ({ token, grounded } = await res.json());
  } catch (e) {
    log("sys", `session failed: ${e.message}`);
    setStatus("failed"); $("start").disabled = false;
    return;
  }
  log("sys", grounded ? "session minted (course context injected)" : "session minted (course NOT found — generic mode)");

  // Mic at 24kHz so no resampling is needed on either direction.
  audioCtx = new AudioContext({ sampleRate: 24000 });
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    log("sys", `mic failed: ${e.message}`);
    setStatus("failed"); $("start").disabled = false;
    return;
  }
  const srcNode = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1); // deprecated but fine for a spike
  processor.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== 1) return;
    const f32 = ev.inputBuffer.getChannelData(0);
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: floatToPcm16Base64(f32) }));
  };
  srcNode.connect(processor);
  processor.connect(audioCtx.destination); // required for onaudioprocess to fire

  setStatus("connecting…");
  // Browser WebSocket can't set headers — the ephemeral key rides as a subprotocol.
  ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", [
    "realtime",
    `openai-insecure-api-key.${token}`,
  ]);
  ws.onopen = () => { setStatus("live — just talk (talk over it to interrupt)", true); $("stop").disabled = false; log("sys", "connected"); };
  ws.onerror = () => { log("sys", "websocket error"); };
  ws.onclose = (e) => { setStatus("closed"); log("sys", `closed (${e.code})`); teardown(); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "input_audio_buffer.speech_started":
        interruptPlayback();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript && msg.transcript.trim()) log("you", `You: ${msg.transcript}`);
        break;
      case "response.output_audio.delta":
      case "response.audio.delta": // pre-GA name
        playChunk(msg.delta);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        assistantBuf += msg.delta || "";
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (assistantBuf.trim()) log("ta", `TA: ${assistantBuf}`);
        assistantBuf = "";
        break;
      case "error":
        log("sys", `error: ${msg.error && msg.error.message}`);
        break;
    }
  };
}

function teardown() {
  $("start").disabled = false; $("stop").disabled = true;
  try { if (processor) { processor.disconnect(); processor = null; } } catch (_) {}
  try { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } } catch (_) {}
  try { if (audioCtx) { audioCtx.close(); audioCtx = null; } } catch (_) {}
  playingSources = [];
}

$("start").onclick = start;
$("stop").onclick = () => { try { ws && ws.close(); } catch (_) {} teardown(); setStatus("ended"); };
