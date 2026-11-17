const $ = id => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// 页面上显示这个号，用来确认手机加载的是不是最新部署（而不是缓存的旧 app.js）。
// 改完功能记得顺手改这里，同时把 index.html 里 app.js/styles.css 的 ?v= 也改成一样的号。
const APP_VERSION = '0.1.0';
const verEl = $('ver'); if (verEl) verEl.textContent = 'v' + APP_VERSION;

// ================= tuning =================
const SPEED_SCALE = 0.5;          // real 80 km/h -> tank 40 km/h
const MAX_ACCEL   = 3;            // tank km/h per second; Infinity = no limit
// tank speed (km/h) each gear reaches at MAX_RPM; 4 wide forward gears (Leopard 2 style)
const GEAR_TOP = [0, 12, 22, 36, 56];
const RPM_RISE = 650;             // max engine rpm gain per second (heavy flywheel)
const RPM_FALL = 2000;            // max rpm drop per second (clutch pulls it down)
const TOP_SPEED = 45;             // for track-sound scaling
const SHIFT_GAP = 1.0;            // min seconds between shifts (no gear hunting)
const LAUNCH_DELAY = 0.6;         // s: engine revs before clutch bites and tracks move

// ================= custom sound files (missing = skipped) =================
const SFX = {
  engIdle:  'sounds/engine_idle.wav',   // recorded engine loops (Prunus Productions pack)
  engHigh:  'sounds/engine_high.wav',
  engStart: 'sounds/engine_start.wav',
  engStop:  'sounds/engine_stop.wav',
  ground:   'sounds/ground.wav',        // rolling rumble loop
  track:   'sounds/track.wav',
};
// Voice lines: sounds/<folder>/1..5.<ext>; one is picked at random each time
const VOICE_FOLDERS = { halt: 'sounds/halt/', losfahren: 'sounds/losfahren/' };
const VOICE_COUNT = 5;
const VOICE_EXT = ['mp3', 'm4a', 'wav', 'ogg'];
const EMBED = {};                 // filled in by the single-file build: path -> data URI
// Voice rules (REAL car speed, km/h)
const HALT_ARM = 15;              // A = true once speed went above this
const HALT_SAY = 5;               // ...then "Halt" when it drops below this
const GO_HOLD = 3;                // B = true after standing at 0 for this many seconds
const GO_SAY = 5;                 // ...then "Losfahren" when speed reaches this
const RADIO_FX = true;
const RADIO_CLICK_GAIN = 0.35;     // push-to-talk click + squelch loudness
const RADIO_KEYDOWN_DUR = 0.10;    // s of static after key-down click
const RADIO_GAP = 0.02;           // s of silence between key-down static and the voice
const TRACK_PHASES = 8;           // copies of the track loop, offset by 1/N of the link-hit period
const TRACK_PERIOD = 0.2494;      // s, measured repeat period of link impacts in track.wav
// slight per-copy speed differences so copies drift against each other:
// avoids the summed loop becoming a perfectly regular tick train
const TRACK_DETUNE = [1.000, 1.037, 0.962, 1.019, 0.981, 1.052, 0.947, 1.008];
const TRACK_GAIN = 0.12 * Math.sqrt(3 / TRACK_PHASES);   // per copy; total loudness independent of N
const GROUND_GAIN = 2.5;          // recorded ground rumble level
// Track sound fades out as the REAL car speeds up (spare our ears from the squeal)
const TRACK_FADE_START = 15;      // real km/h: full track sound below this
const TRACK_FADE_END   = 25;      // real km/h: at/above this only the floor remains
const TRACK_FADE_FLOOR = 0.12;    // remaining level (~ -18 dB, barely audible)
function trackFade(real) {
  const x = clamp((real - TRACK_FADE_START) / (TRACK_FADE_END - TRACK_FADE_START), 0, 1);
  const s = x * x * (3 - 2 * x);                       // smoothstep
  return 1 - s * (1 - TRACK_FADE_FLOOR);
}

// ENGINE-START
const IDLE_RPM = 650, MAX_RPM = 2600, CYL = 12;   // big V12 4-stroke diesel

function shaperCurve(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh(k * x); }
  return c;
}

// AudioWorklet: one combustion pulse per cylinder firing, with per-cylinder
// strength differences + timing jitter (the diesel "lope"), and a separate
// output carrying the sharp injector/combustion knock clicks.
const DIESEL_WORKLET = `
class Diesel extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'freq', defaultValue: 65, minValue: 1, maxValue: 800, automationRate: 'k-rate' },
    { name: 'load', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  ]; }
  constructor() {
    super();
    this.phase = 0; this.next = 1; this.ci = 0;
    this.t = 1e9; this.w = 1; this.amp = 0;
    this.kt = 1e9; this.kamp = 0;
    this.tab = []; for (let i = 0; i < 12; i++) this.tab.push(0.62 + Math.random() * 0.38);
  }
  process(inputs, outputs, p) {
    const o0 = outputs[0][0], o1 = outputs[1][0];
    const f = p.freq[0], L = p.load[0], sr = sampleRate;
    const kLen = sr * 0.006, kTau = sr * 0.0006;
    for (let i = 0; i < o0.length; i++) {
      this.phase += f / sr;
      if (this.phase >= this.next) {
        this.phase -= this.next;
        this.next = 1 + (Math.random() - 0.5) * (0.08 - 0.05 * L);
        this.ci = (this.ci + 1) % 12;
        const lope = 1 - (1 - this.tab[this.ci]) * (1 - 0.5 * L);
        this.amp = lope * (0.5 + 0.5 * L) * (0.88 + Math.random() * 0.24);
        this.t = 0;
        this.w = Math.max(6, Math.round(sr * (0.0011 + 0.0016 * L)));
        this.kt = 0;
        this.kamp = this.tab[(this.ci + 5) % 12] * (0.6 + 0.4 * L);
      }
      let y = 0;
      if (this.t < this.w) {
        const x = this.t / this.w;
        y = this.amp * Math.sin(Math.PI * x) * (1 + 0.4 * (Math.random() * 2 - 1));
        this.t++;
      }
      let k = 0;
      if (this.kt < kLen) { k = this.kamp * Math.exp(-this.kt / kTau) * (Math.random() * 2 - 1); this.kt++; }
      o0[i] = y; o1[i] = k;
    }
    return true;
  }
}
registerProcessor('diesel', Diesel);
`;

async function createEngine(ctx, dest, noiseBuf) {
  const out = ctx.createGain(); out.gain.value = 0.9; out.connect(dest);
  const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; };
  let node = null;
  try {
    const url = URL.createObjectURL(new Blob([DIESEL_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'diesel', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1] });
  } catch (e) { console.warn('worklet failed, using fallback engine', e); }
  if (!node) return createClassicEngine(ctx, out);

  // combustion pulses -> hull/body resonance + exhaust resonance -> grit -> tone
  const hp = mk('highpass', 28, 0.7);
  const body = mk('lowpass', 120, 4);
  const exh = mk('bandpass', 380, 1.2);
  const exhG = ctx.createGain(); exhG.gain.value = 0.55;
  const sum = ctx.createGain(); sum.gain.value = 2.4;
  const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(2.2); sh.oversample = '2x';
  const tone = mk('lowpass', 900, 0.7);
  node.connect(hp, 0);
  hp.connect(body); body.connect(sum);
  hp.connect(exh); exh.connect(exhG); exhG.connect(sum);
  sum.connect(sh); sh.connect(tone); tone.connect(out);

  // diesel knock / clatter
  const kbp = mk('bandpass', 1400, 1.0);
  const kG = ctx.createGain(); kG.gain.value = 0.2;
  node.connect(kbp, 1); kbp.connect(kG); kG.connect(out);

  // turbo whine
  const tw = ctx.createOscillator(); tw.type = 'sine';
  const twG = ctx.createGain(); twG.gain.value = 0;
  tw.connect(twG); twG.connect(out); tw.start();

  // intake roar
  const ns = ctx.createBufferSource(); ns.buffer = noiseBuf; ns.loop = true;
  const nbp = mk('bandpass', 450, 0.8);
  const nG = ctx.createGain(); nG.gain.value = 0;
  ns.connect(nbp); nbp.connect(nG); nG.connect(out); ns.start();

  const P = n => node.parameters.get(n);
  const fireHz = rpm => rpm / 60 * 2;          // deep: ~22 Hz idle, ~87 Hz max
  return {
    kind: 'cyl',
    set(r, load, t, tc) {
      const rpm = IDLE_RPM + r * (MAX_RPM - IDLE_RPM);
      P('freq').setTargetAtTime(fireHz(rpm), t, tc);
      P('load').setTargetAtTime(load, t, tc);
      body.frequency.setTargetAtTime(70 + r * 110, t, tc);
      exh.frequency.setTargetAtTime(170 + r * 230, t, tc);
      tone.frequency.setTargetAtTime(380 + r * 800 + load * 500, t, tc);
      kG.gain.setTargetAtTime(0.04 + 0.04 * (1 - r), t, tc);
      tw.frequency.setTargetAtTime(500 + r * 1100, t, tc);
      twG.gain.setTargetAtTime((r * 0.6 + load * 0.4) * 0.006, t, tc);
      nG.gain.setTargetAtTime(0.02 + load * 0.14 * (0.3 + r), t, tc);
      out.gain.setTargetAtTime(0.6 + load * 0.3, t, tc);
      return rpm;
    },
    crank(t) {   // starter: slow uneven firing that catches and settles to idle
      P('freq').cancelScheduledValues(t);
      P('freq').setValueAtTime(fireHz(120), t);
      P('freq').linearRampToValueAtTime(fireHz(200), t + 0.8);
      P('freq').linearRampToValueAtTime(fireHz(1100), t + 1.15);
      P('freq').setTargetAtTime(fireHz(IDLE_RPM), t + 1.15, 0.35);
      P('load').setValueAtTime(0.3, t);
      P('load').setValueAtTime(0.9, t + 0.85);
      P('load').setTargetAtTime(0.08, t + 1.2, 0.4);
    },
  };
}

// Recorded engine: crossfade an idle loop and a high-rpm loop by rpm,
// pitch-shifting both so they meet in the middle (racing-game style).
const SAMPLE_RATIO = 1.94;   // high loop pitch / idle loop pitch (measured)
const SAMPLE_RANGE = 2.6;    // total pitch rise idle -> max rpm
const SAMPLE_LEVEL = 0.55;
function createSampleEngine(ctx, dest, b) {
  const out = ctx.createGain(); out.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.5;
  lp.connect(out); out.connect(dest);
  const mkLoop = buf => {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    const g = ctx.createGain(); g.gain.value = 0;
    s.connect(g); g.connect(lp); s.start(); return { s, g };
  };
  const idle = mkLoop(b.engIdle), high = mkLoop(b.engHigh);
  const oneShot = (buf, t) => { if (!buf) return 0; const s = ctx.createBufferSource(); s.buffer = buf; s.connect(dest); s.start(t); return buf.duration; };
  function apply(r, load, t, tc) {
    const P = Math.pow(SAMPLE_RANGE, r);
    const w = clamp(Math.log(P) / Math.log(SAMPLE_RATIO), 0, 1);
    idle.s.playbackRate.setTargetAtTime(P, t, tc);
    high.s.playbackRate.setTargetAtTime(P / SAMPLE_RATIO, t, tc);
    idle.g.gain.setTargetAtTime(Math.cos(w * Math.PI / 2), t, tc);
    high.g.gain.setTargetAtTime(Math.sin(w * Math.PI / 2), t, tc);
    lp.frequency.setTargetAtTime(500 + r * 1500 + load * 2500, t, tc);
    out.gain.setTargetAtTime(SAMPLE_LEVEL * (0.7 + load * 0.45), t, tc);
  }
  return {
    kind: 'sample',
    set(r, load, t, tc) { apply(r, load, t, tc); return IDLE_RPM + r * (MAX_RPM - IDLE_RPM); },
    crank(t) {
      apply(0, 0.08, t, 0.001);
      const d = oneShot(b.engStart, t) || 0.3;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(0, t);
      out.gain.setValueAtTime(0, t + Math.max(0, d - 0.3));
      out.gain.linearRampToValueAtTime(SAMPLE_LEVEL * 0.74, t + d);
    },
    stop(t) {
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0, t, 0.05);
      return oneShot(b.engStop, t);
    },
  };
}

// Classic engine: the original oscillator sound
function createClassicEngine(ctx, dest) {
  const mix = ctx.createGain(); mix.gain.value = 0.35;
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
  const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
  const sub = ctx.createOscillator(); sub.type = 'square';
  const subG = ctx.createGain(); subG.gain.value = 0.6;
  o1.connect(mix); o2.connect(mix); sub.connect(subG); subG.connect(mix);
  const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(3);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
  const am = ctx.createGain(); am.gain.value = 0.7;
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.3;
  lfo.connect(lfoDepth); lfoDepth.connect(am.gain);
  const out = ctx.createGain(); out.gain.value = 0.55;
  mix.connect(sh); sh.connect(lp); lp.connect(am); am.connect(out); out.connect(dest);
  [o1, o2, sub, lfo].forEach(o => o.start());
  const fOf = (r, thr) => 30 + r * 75 + thr * 8;
  const setF = (f, t, tc) => {
    o1.frequency.setTargetAtTime(f, t, tc);
    o2.frequency.setTargetAtTime(f * 1.013, t, tc);
    sub.frequency.setTargetAtTime(f / 2, t, tc);
    lfo.frequency.setTargetAtTime(f / 4, t, tc);
  };
  return {
    kind: 'classic',
    set(r, load, t, tc) {
      const thr = clamp((load - 0.25) / 0.75, 0, 1);   // extra effort above cruise
      setF(fOf(r, thr), t, tc);
      lp.frequency.setTargetAtTime(220 + r * 1300 + thr * 600, t, tc);
      out.gain.setTargetAtTime(0.45 + r * 0.25 + thr * 0.2, t, tc);
      return IDLE_RPM + r * (MAX_RPM - IDLE_RPM);
    },
    crank(t) {
      for (const n of [o1, o2, sub, lfo]) n.frequency.cancelScheduledValues(t);
      const f0 = fOf(0, 0);
      [[o1, 1], [o2, 1.013], [sub, 0.5], [lfo, 0.25]].forEach(([o, k]) => {
        o.frequency.setValueAtTime(f0 * 0.35 * k, t);
        o.frequency.linearRampToValueAtTime(f0 * 1.6 * k, t + 1.1);
        o.frequency.setTargetAtTime(f0 * k, t + 1.1, 0.3);
      });
    },
  };
}
// ENGINE-END

// ================= state =================
let engineMode = 'sample';    // 由当前选中的坦克(TANKS)决定，玩家不再单独切换声音源
let ctx, master, comp, noiseBuf, engines = {}, engBus = {}, roll = {}, trackBus, voiceBus, trackLoop = null;
let running = false, mode = 'gps', engineReadyAt = 0;
let realKmh = 0, speedKmh = 0, prevSpeed = 0, throttle = 0, load = 0.08, shiftUntil = 0;
let lastFix = null, watchId = null, wakeLock = null;
let trackMode = 'rec';        // 同上，由坦克决定
let groundLoop = null;
let trk = null, nextSqueal = 0;
let curGear = 0, nextClank = 0, schedTimer = null, loopTimer = null;
const buf = {};
const voices = { halt: [], losfahren: [] }, lastVoice = {};
let stateA = false, stateB = false, zeroSince = null;

// ---- transmission: load-dependent shift points like an automatic gearbox ----
let lastShiftAt = -9, engRpm = 650, launchUntil = 0, wasStopped = true;
function rpmIn(g, v, demand) {
  if (g === 0) return IDLE_RPM;
  const rpm = v / GEAR_TOP[g] * MAX_RPM;
  if (g === 1) return Math.max(rpm, IDLE_RPM + demand * 700);   // clutch slip on launch
  return Math.max(rpm, IDLE_RPM * 0.9);
}
function pickGear(v, target, demand, now) {
  if (v < 0.5 && target === 0) return 0;
  let g = curGear || 1;
  const N = GEAR_TOP.length - 1;
  if (now - lastShiftAt > SHIFT_GAP) {
    const up = Math.min(1500 + demand * 1100, 2450);  // light load: shift early; full load: rev it out
    const down = 900 + demand * 300;                  // only drop a gear when really lugging
    const cur = rpmIn(g, v, demand);
    if (g < N && cur > up && rpmIn(g + 1, v, demand) > down) g++;
    else if (g > 1 && cur < down) g--;
    else if (g > 1 && demand > 0.85 && cur < 1500 && rpmIn(g - 1, v, demand) < 2300) g--; // kickdown
  }
  while (g < N && rpmIn(g, v, demand) > MAX_RPM * 1.02) g++;     // never over-rev
  return g;
}

// One 50 ms physics step. `real` = real car km/h, `now` = seconds.
// Returns { r: 0..1 engine rpm, rpm, shift: +1 up / -1 down / 0 }
function physicsStep(real, now, dt = 0.05) {
  const target = real * SPEED_SCALE;
  if (speedKmh < 0.05 && target === 0) wasStopped = true;
  if (wasStopped && target > 0) { launchUntil = now + LAUNCH_DELAY; wasStopped = false; }
  const launching = now < launchUntil;
  const diff = target - speedKmh;
  let step = diff * 0.07;
  if (diff > 0) step = Math.min(step, MAX_ACCEL * dt);   // tank can't keep up with a Tesla
  if (launching) step = Math.min(step, 0);               // clutch not engaged yet
  speedKmh += step;
  if (Math.abs(target - speedKmh) < 0.05) speedKmh = target;

  const accel = (speedKmh - prevSpeed) / dt; prevSpeed = speedKmh;
  const ref = isFinite(MAX_ACCEL) ? MAX_ACCEL * 0.8 : 4;
  throttle += (clamp(accel / ref, 0, 1) - throttle) * 0.12;
  let demand;
  if (speedKmh < 0.5 && target === 0) demand = 0.08;          // idle
  else if (diff < -1) demand = 0.03;                          // coasting / engine braking
  else demand = clamp(0.25 + throttle * 0.75, 0, 1);
  if (launching) demand = 0.9;                                // rev up for launch

  let shift = 0;
  const g = pickGear(speedKmh, target, demand, now);
  if (g !== curGear) {
    if (curGear !== 0 && g !== 0) { shift = g > curGear ? 1 : -1; lastShiftAt = now; shiftUntil = now + 0.28; }
    curGear = g;
  }
  load += ((now < shiftUntil ? demand * 0.25 : demand) - load) * 0.15;   // clutch in during shift

  const rpmT = clamp(rpmIn(curGear, speedKmh, demand), IDLE_RPM, MAX_RPM);
  engRpm += clamp(rpmT - engRpm, -RPM_FALL * dt, RPM_RISE * dt);   // engine inertia
  const rpm = engRpm;
  return { r: (rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), rpm, shift };
}

// ================= audio setup =================
function makeNoise() {
  const len = ctx.sampleRate * 2;
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

async function buildAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  noiseBuf = makeNoise();
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  master = ctx.createGain(); master.gain.value = 0;
  master.connect(comp); comp.connect(ctx.destination);

  await loadSfx();
  for (const k of ['sample', 'classic', 'cyl']) { engBus[k] = ctx.createGain(); engBus[k].gain.value = 0; engBus[k].connect(master); }
  engines.classic = createClassicEngine(ctx, engBus.classic);
  engines.cyl = await createEngine(ctx, engBus.cyl, noiseBuf);
  engines.sample = (buf.engIdle && buf.engHigh) ? createSampleEngine(ctx, engBus.sample, buf) : null;
  setEngineMode(engineMode);
  const got = Object.keys(SFX).filter(k => buf[k]);
  $('status').textContent = `录音引擎${engines.sample ? '可用' : '缺文件'} · 音效 ${got.length}/${Object.keys(SFX).length} · Halt ${voices.halt.length} 条 · Losfahren ${voices.losfahren.length} 条`;

  roll.src = ctx.createBufferSource(); roll.src.buffer = noiseBuf; roll.src.loop = true;
  roll.lp = ctx.createBiquadFilter(); roll.lp.type = 'lowpass'; roll.lp.frequency.value = 140;
  roll.g = ctx.createGain(); roll.g.gain.value = 0;
  roll.src.connect(roll.lp); roll.lp.connect(roll.g); roll.g.connect(master); roll.src.start();

  trackBus = ctx.createBiquadFilter(); trackBus.type = 'bandpass';
  trackBus.frequency.value = 1600; trackBus.Q.value = 2.5;
  trackBus.connect(master);
  buildTrackSynth();

  voiceBus = ctx.createGain(); voiceBus.gain.value = 1.4;
  if (RADIO_FX) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(1.8);
    voiceBus.connect(hp); hp.connect(lp); lp.connect(sh); sh.connect(master);
  } else voiceBus.connect(master);
}

// Load one audio file (embedded data URI or URL). Returns AudioBuffer or null.
async function loadAudio(url) {
  try {
    const src = EMBED[url] || url;
    let ab;
    if (src.startsWith('data:')) {                 // embedded audio: decode without fetch
      const bin = atob(src.slice(src.indexOf(',') + 1));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      ab = u8.buffer;
    } else {
      const r = await fetch(src);
      if (!r.ok) return null;
      ab = await r.arrayBuffer();
    }
    return await new Promise((ok, bad) => ctx.decodeAudioData(ab, ok, bad));
  } catch (e) { return null; }
}

async function loadSfx() {
  const names = Object.keys(SFX);
  await Promise.all(names.map(async k => { const b = await loadAudio(SFX[k]); if (b) buf[k] = b; }));
  await Promise.all(Object.keys(VOICE_FOLDERS).map(async cat => {
    for (let n = 1; n <= VOICE_COUNT; n++) {
      for (const ext of VOICE_EXT) {
        const b = await loadAudio(`${VOICE_FOLDERS[cat]}${n}.${ext}`);
        if (b) { voices[cat].push(b); break; }
      }
    }
  }));
  if (buf.ground) {
    groundLoop = { src: ctx.createBufferSource(), g: ctx.createGain() };
    groundLoop.src.buffer = buf.ground; groundLoop.src.loop = true;
    groundLoop.g.gain.value = 0;
    groundLoop.src.connect(groundLoop.g); groundLoop.g.connect(master);
    groundLoop.src.start();
  }
  if (buf.track) {
    // three-phase: N copies offset by TRACK_PERIOD/N so link hits interleave evenly
    trackLoop = { srcs: [], g: ctx.createGain() };
    trackLoop.g.gain.value = 0; trackLoop.g.connect(master);
    const L = buf.track.duration;
    for (let i = 0; i < TRACK_PHASES; i++) {
      const src = ctx.createBufferSource(); src.buffer = buf.track; src.loop = true;
      src.connect(trackLoop.g); src.start(0, (i * TRACK_PERIOD / TRACK_PHASES + i * 0.731) % L);
      src.rateK = TRACK_DETUNE[i % TRACK_DETUNE.length];
      trackLoop.srcs.push(src);
    }
  }
}

function updateAudio(r, ld = load) {
  const now = ctx.currentTime;
  if (now >= engineReadyAt) {
    let rpm = 0;
    for (const k in engines) if (engines[k]) rpm = engines[k].set(r, ld, now, 0.08);
    $('rpm').textContent = Math.round(rpm / 10) * 10;
  }
  updateLoops(now, speedKmh);
}
function updateLoops(now, speedKmh, real = realKmh) {
  const rec = trackMode === 'rec';
  const fade = trackFade(real);
  roll.g.gain.setTargetAtTime(groundLoop && rec ? 0 : clamp(speedKmh / 30, 0, 1) * 0.5, now, 0.2);
  if (groundLoop) {
    groundLoop.src.playbackRate.setTargetAtTime(0.7 + clamp(speedKmh, 0, TOP_SPEED) / 50, now, 0.15);
    groundLoop.g.gain.setTargetAtTime(rec ? clamp(speedKmh / 20, 0, 1) * GROUND_GAIN : 0, now, 0.2);
  }
  if (trackLoop) {
    const tr = 0.55 + clamp(speedKmh, 0, TOP_SPEED) / 40;
    for (const src of trackLoop.srcs) src.playbackRate.setTargetAtTime(tr * src.rateK, now, 0.15);
    trackLoop.g.gain.setTargetAtTime(!rec || speedKmh < 0.5 ? 0 : clamp(0.3 + speedKmh / 40, 0, 1) * TRACK_GAIN * fade, now, 0.25);
  }
}

// ================= one-shot sounds =================
function noiseHit(time, dur, gain, filterType, freq, q = 1) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(time, Math.random() * 1.5); s.stop(time + dur + 0.05);
}
function thump(time, f0, f1, dur, gain) {
  const o = ctx.createOscillator(); o.type = 'sine';
  const g = ctx.createGain();
  o.frequency.setValueAtTime(f0, time);
  o.frequency.exponentialRampToValueAtTime(f1, time + dur);
  g.gain.setValueAtTime(gain, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  o.connect(g); g.connect(master); o.start(time); o.stop(time + dur + 0.05);
}
function clank(time, amp) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(amp, time + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.035 + Math.random() * 0.02);
  s.connect(g); g.connect(trackBus);
  s.start(time, Math.random() * 1.8); s.stop(time + 0.08);
}
function squeak(t) {
  const o = ctx.createOscillator(); o.type = 'triangle';
  const g = ctx.createGain();
  const f = 2200 + Math.random() * 1200;
  o.frequency.setValueAtTime(f, t);
  o.frequency.linearRampToValueAtTime(f * (1.1 + Math.random() * 0.3), t + 0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.45);
}
function starterMotor(t) {
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const g = ctx.createGain();
  o.frequency.setValueAtTime(120, t);
  o.frequency.linearRampToValueAtTime(260, t + 0.5);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
  g.gain.setValueAtTime(0.12, t + 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  o.connect(lp); lp.connect(g); g.connect(master); o.start(t); o.stop(t + 1.2);
}
function gearShift(up) {
  const t = ctx.currentTime;
  thump(t, 90, 40, 0.18, 0.5);
  noiseHit(t + 0.02, 0.12, 0.25, 'bandpass', 900, 3);
  if (up) noiseHit(t + 0.05, 0.4, 0.12, 'highpass', 4000);
}
// ================= weapon architecture: Gun + WeaponSystem =================
// “炮”(Gun) 是最小的状态/声音单位：每门炮有自己的装填时间、装填音效类型
// （单发炮闩 / 弹匣哗啦 / 弹链不装填）、回转惯性 inertia（留给瞄准镜炮管跟随用）、
// 开炮震动+火光参数 recoil。“武器系统”(WeaponSystem) 是玩家可选择的最小单位，
// 由 1~2 门炮组成（主炮 / 同轴 / 第二主炮），各炮装填状态互相独立。
const GUNS = {
  kwk30:     { label:'2cm KwK30 机关炮', cal:20,   fireMode:'auto', rpm:280, magSize:10, reloadTime:4.0,
               reloadSound:'magazine', inertia:6.5, recoil:{shake:.35, flash:.18, kick:.15} },
  mg34:      { label:'MG34 同轴机枪',    cal:7.92, fireMode:'auto', rpm:850, magSize:Infinity, reloadTime:0,
               reloadSound:'belt', inertia:9.0, recoil:{shake:.08, flash:.08, kick:.04} },
  d10t:      { label:'100mm D-10T',      cal:100,  fireMode:'single', reloadTime:7,
               reloadSound:'single', inertia:3.2, recoil:{shake:.9, flash:.6, kick:.8} },
  coaxMg:    { label:'7.62mm 同轴机枪',  cal:7.62, fireMode:'auto', rpm:650, magSize:Infinity, reloadTime:0,
               reloadSound:'belt', inertia:9.5, recoil:{shake:.07, flash:.07, kick:.035} },
  kwk36:     { label:'88mm KwK36 L/56',  cal:88,   fireMode:'single', reloadTime:7,
               reloadSound:'single', inertia:3.0, recoil:{shake:.85, flash:.55, kick:.75} },
  kwk44_128: { label:'128mm KwK44',      cal:128,  fireMode:'single', reloadTime:15,
               reloadSound:'single_heavy', inertia:1.8, recoil:{shake:1.2, flash:.8, kick:1.0} },
  kwk44_75:  { label:'75mm KwK44 同轴炮',cal:75,   fireMode:'single', reloadTime:5,
               reloadSound:'single', inertia:4.0, recoil:{shake:.6, flash:.4, kick:.5} },
  amx120:    { label:'120mm 弹夹炮',     cal:120,  fireMode:'burstMag', magSize:4, interShot:2.5, reloadTime:30,
               reloadSound:'magazine_heavy', inertia:2.6, recoil:{shake:1.0, flash:.65, kick:.85} },
  frMg:      { label:'7.5mm 机枪',       cal:7.5,  fireMode:'auto', rpm:900, magSize:Infinity, reloadTime:0,
               reloadSound:'belt', inertia:9.5, recoil:{shake:.07, flash:.07, kick:.035} },
  flak57:    { label:'57mm 高炮',        cal:57,   fireMode:'auto', rpm:110, magSize:4, reloadTime:1.6,
               reloadSound:'magazine', inertia:5.0, recoil:{shake:.5, flash:.35, kick:.4} },
  m3_75:     { label:'75mm M3',          cal:75,   fireMode:'single', reloadTime:6,
               reloadSound:'single', inertia:3.6, recoil:{shake:.65, flash:.45, kick:.55} },
  m1919:     { label:'.30cal M1919A4',   cal:7.62, fireMode:'auto', rpm:500, magSize:Infinity, reloadTime:0,
               reloadSound:'belt', inertia:9.0, recoil:{shake:.06, flash:.06, kick:.03} },
};
const WEAPON_SYSTEMS = {
  sdkfz222: { label:'Sd.Kfz.222（国军版）', reticle:'german', guns:[{role:'main',  gun:'kwk30'},     {role:'coax', gun:'mg34'}] },
  type59:   { label:'59 式',                reticle:'soviet', guns:[{role:'main',  gun:'d10t'},      {role:'coax', gun:'coaxMg'}] },
  tiger:    { label:'虎式',                  reticle:'german', guns:[{role:'main',  gun:'kwk36'},     {role:'coax', gun:'mg34'}] },
  maus:     { label:'鼠式',                  reticle:'german', guns:[{role:'main',  gun:'kwk44_128'}, {role:'coax', gun:'kwk44_75'}] },
  amx50:    { label:'AMX 50 120',            reticle:'generic', guns:[{role:'main',  gun:'amx120'},    {role:'coax', gun:'frMg'}] },
  twin57:   { label:'双 57 自行高炮',         reticle:'generic', guns:[{role:'main',  gun:'flak57'},    {role:'main2', gun:'flak57'}] },
  sherman:  { label:'谢尔曼',                reticle:'generic', guns:[{role:'main',  gun:'m3_75'},     {role:'coax', gun:'m1919'}] },
};
let weaponSysId = null;
let gunStates = {}, shakeAmp = 0;

// ================= Tank（坦克）=================
// Tank -(包含)- WeaponSystem -(包含)- Gun 的面向对象设计里，Tank 这一层只负责两件事：
// 固定一套声音（发动机 + 履带，玩家不能再单独切换）、以及绑定恰好一个武器系统
// （不同坦克允许指向同一个武器系统，架构上没问题，只是现在 7 辆车各用各的）。
const TANKS = {
  type59:   { label:'59 式',     weaponSystem:'type59',   engine:'sample',  track:'rec' },
  sdkfz222: { label:'SdKfz 222', weaponSystem:'sdkfz222', engine:'sample',  track:'v1'  },
  tiger:    { label:'虎式',       weaponSystem:'tiger',    engine:'cyl',     track:'rec' },
  maus:     { label:'鼠式',       weaponSystem:'maus',     engine:'cyl',     track:'v1'  },
  amx50:    { label:'AMX 50',    weaponSystem:'amx50',    engine:'classic', track:'rec' },
  twin57:   { label:'双 57 AA',  weaponSystem:'twin57',   engine:'sample',  track:'rec' },
  sherman:  { label:'谢尔曼',     weaponSystem:'sherman',  engine:'classic', track:'v1'  },
};
const TANK_SLOTS = ['type59', 'sdkfz222', 'tiger', 'maus', 'amx50', 'twin57', 'sherman'];   // 底部坦克切换栏的顺序
let currentTankId = 'type59'; try { currentTankId = localStorage.getItem('tankId') || currentTankId; } catch (e) {}

function selectTank(id) {
  const t = TANKS[id]; if (!t) return;
  currentTankId = id;
  try { localStorage.setItem('tankId', id); } catch (e) {}
  setEngineMode(t.engine);
  setTrackMode(t.track);
  exitScope();
  initWeaponSystem(t.weaponSystem);
  buildTankNav();
}
function buildTankNav() {
  const box = $('tankNav'); if (!box) return;
  box.innerHTML = '';
  TANK_SLOTS.forEach(id => {
    const btn = document.createElement('button');
    btn.className = 'tank-slot' + (id === currentTankId ? ' on' : '');
    btn.textContent = TANKS[id].label;
    btn.onclick = () => selectTank(id);
    box.appendChild(btn);
  });
}

function initWeaponSystem(id) {
  const sys = WEAPON_SYSTEMS[id]; if (!sys) return;
  weaponSysId = id;
  gunStates = {};
  sys.guns.forEach((slot, i) => {
    const def = GUNS[slot.gun];
    gunStates[slot.role] = {
      def, role: slot.role,
      ammo: isFinite(def.magSize) ? def.magSize : Infinity,
      reloading: false, reloadLeft: 0, nextShotAt: i * 0.25,  // stagger twin mounts a bit
    };
  });
  buildScopeButtons();
  updateGunStatusText();
}

function tryFireGun(role, now) {
  if (!ctx) return false;   // 还没启动引擎（炮手图标在首页就能点，摄像头不需要 ctx，但开炮声音需要）
  const g = gunStates[role];
  if (!g || g.reloading || now < g.nextShotAt) return false;
  if (g.ammo <= 0) { startReload(role); return false; }
  fireShot(g);
  g.ammo--;
  const def = g.def;
  if (def.fireMode === 'single') startReload(role);
  else if (def.fireMode === 'burstMag') { if (g.ammo <= 0) startReload(role); else g.nextShotAt = now + def.interShot; }
  else if (def.magSize !== Infinity && g.ammo <= 0) startReload(role);
  return true;
}
function startReload(role) {
  const g = gunStates[role];
  g.reloading = true; g.reloadLeft = g.def.reloadTime;
  playReloadSound(g.def);
}
function updateGuns(dt) {
  for (const role in gunStates) {
    const g = gunStates[role];
    if (g.reloading) {
      g.reloadLeft -= dt;
      if (g.reloadLeft <= 0) { g.reloading = false; g.ammo = isFinite(g.def.magSize) ? g.def.magSize : Infinity; }
    }
  }
  updateGunStatusText();
}

// 开炮声：按口径(cal)和射击方式缩放现有的 thump/noiseHit 合成层
function fireShot(g) {
  const t = ctx.currentTime, def = g.def;
  const s = clamp(def.cal / 90, 0.12, 1.6);
  if (def.cal < 15) {                                 // 步/机枪级：短促单发
    noiseHit(t, 0.03 + 0.01 * s, 0.15 + 0.35 * s, 'bandpass', 2600, 4);
    thump(t, 180, 90, 0.05, 0.05 + 0.12 * s);
  } else if (def.fireMode === 'auto') {                // 机关炮/高炮：介于机枪和主炮之间
    noiseHit(t, 0.08, 0.5 * s, 'highpass', 1800);
    noiseHit(t, 0.5, 0.45 * s, 'lowpass', 500);
    thump(t, 110, 45, 0.3, 0.4 * s);
  } else {                                             // 主炮：沿用原 boom() 的分层思路，按口径缩放
    thump(t, 70 * s + 20, 25, 0.8 + 0.6 * s, 0.6 + 0.5 * s);
    noiseHit(t, 0.1, 0.2 + 0.9 * s, 'highpass', 2200);
    noiseHit(t, 1.8 + 0.8 * s, 0.2 + 0.7 * s, 'lowpass', 650);
    noiseHit(t + 0.15, 2.0 + 1.0 * s, 0.25 * s, 'lowpass', 280);
  }
  triggerRecoilFX(def.recoil);
}
// 装填声：弹链不装填；单发是“开闩—入膛闭锁”两段；弹匣是多段哗啦声+到位声
function playReloadSound(def) {
  if (def.reloadSound === 'belt') return;
  const t = ctx.currentTime, T = def.reloadTime;
  if (def.reloadSound === 'single' || def.reloadSound === 'single_heavy') {
    const heavy = def.reloadSound === 'single_heavy';
    noiseHit(t, 0.06, 0.55, 'bandpass', heavy ? 1400 : 2000, 5);
    thump(t, 140, 70, 0.12, heavy ? 0.5 : 0.3);
    const t2 = t + Math.max(0.2, T - 0.18);
    noiseHit(t2, 0.07, 0.65, 'bandpass', heavy ? 1700 : 2400, 5);
    noiseHit(t2 + 0.1, 0.1, 0.7, 'bandpass', heavy ? 1200 : 1800, 5);
    thump(t2 + 0.1, heavy ? 150 : 120, heavy ? 70 : 60, 0.16, heavy ? 0.55 : 0.4);
  } else {
    const heavy = def.reloadSound === 'magazine_heavy';
    const stages = heavy ? 4 : 3, step = T / (stages + 1);
    for (let i = 0; i < stages; i++) noiseHit(t + step * (i + 0.5), 0.1, 0.3 + 0.1 * i, 'bandpass', 1500 - i * 150, 4);
    const t2 = t + T - 0.15;
    noiseHit(t2, 0.08, 0.6, 'bandpass', heavy ? 1300 : 1900, 5);
    thump(t2, heavy ? 140 : 130, heavy ? 65 : 70, 0.14, heavy ? 0.5 : 0.35);
  }
}
function triggerRecoilFX(recoil) {
  shakeAmp = Math.max(shakeAmp, recoil.shake);
  if (aiming) flashScope(recoil.flash);
}
function flashScope(intensity) {
  const el = $('scopeFlash');
  el.style.transition = 'none';
  el.style.opacity = Math.min(1, 0.3 + intensity);
  requestAnimationFrame(() => {
    el.style.transition = `opacity ${(0.25 + intensity * 0.3).toFixed(2)}s ease-out`;
    el.style.opacity = 0;
  });
}

// ================= 瞄准镜 / 开炮界面（后置摄像头 DEMO） =================
let scopeStream = null, scopeRAF = null, fireTimers = {}, aiming = false;
function buildScopeButtons() {
  const box = $('scopeBottom'); if (!box) return;
  box.innerHTML = '';
  const sys = WEAPON_SYSTEMS[weaponSysId];
  $('scopeSysName').textContent = sys.label;
  sys.guns.forEach(slot => {
    const btn = document.createElement('button');
    btn.className = 'fire-btn' + (slot.role === 'coax' ? ' coax' : '');
    btn.textContent = slot.role === 'coax' ? '同轴' : (slot.role === 'main2' ? '炮 2' : '开火');
    box.appendChild(btn);
    bindFireButton(btn, slot.role);
  });
}
function stopFireTimer(role) { clearInterval(fireTimers[role]); fireTimers[role] = null; }
function stopAllFireTimers() { for (const r in fireTimers) stopFireTimer(r); }
// 手机浏览器长按容易把 pointerup/pointercancel 吞掉（iOS 的长按呼出菜单会抢走手势，
// 或手指在小按钮上轻微滑动触发 pointerleave），导致连发定时器/踏板状态永远没人清掉。
// bindPress() 是所有“按住生效、松手停止”控件（开火键、油门/刹车/离合器踏板）共用的
// 健壮实现：pointerdown 时用 setPointerCapture 把后续事件锁死在按钮上，并把 end()
// 注册进全局兜底列表——只要 window 收到任何 pointerup/pointercancel，或者页面切后台/
// 失焦，所有正在按住的控件都会被强制松开，不会有漏掉释放事件导致“卡住”的情况。
let pressFailsafes = [];
function bindPress(el, onStart, onEnd) {
  let active = false;
  const start = e => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    if (!active) { active = true; onStart(); }
  };
  const end = () => { if (active) { active = false; onEnd(); } };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', e => e.preventDefault());
  pressFailsafes.push(end);
}
window.addEventListener('pointerup', () => pressFailsafes.forEach(f => f()));
window.addEventListener('pointercancel', () => pressFailsafes.forEach(f => f()));
window.addEventListener('blur', () => pressFailsafes.forEach(f => f()));
document.addEventListener('visibilitychange', () => { if (document.hidden) pressFailsafes.forEach(f => f()); });

function bindFireButton(el, role) {
  const fireOnce = () => tryFireGun(role, performance.now() / 1000);
  bindPress(el,
    () => {
      stopFireTimer(role);          // never stack two intervals for the same gun
      fireOnce();
      const def = gunStates[role].def;
      if (def.fireMode === 'auto') fireTimers[role] = setInterval(fireOnce, 60000 / def.rpm);
    },
    () => stopFireTimer(role)
  );
}
function updateGunStatusText() {
  const sys = WEAPON_SYSTEMS[weaponSysId]; if (!sys) return;
  const box = $('scopeBottom');
  if (box) sys.guns.forEach((slot, i) => {
    const btn = box.children[i]; if (btn) btn.classList.toggle('reloading', gunStates[slot.role].reloading);
  });
  if (!aiming) return;
  $('scopeStatus').textContent = sys.guns.map(slot => {
    const g = gunStates[slot.role];
    if (g.reloading) return `${g.def.label} 装填中 ${Math.max(0, g.reloadLeft).toFixed(1)}s`;
    return isFinite(g.ammo) ? `${g.def.label} ${g.ammo}/${g.def.magSize}` : `${g.def.label} 待发`;
  }).join(' · ');
}
async function enterScope() {
  activeRole = 'gunner';
  document.querySelectorAll('.role-btn').forEach(b => b.classList.toggle('on', b.dataset.role === 'gunner'));
  aiming = true;
  motionSince = null; preRev = 0;   // 举手机瞄准时的晃动不该被当成”车辆起步”去推高转速
  $('scopeView').classList.remove('hidden');
  $('scopeStatus').textContent = '正在打开后置摄像头…';
  try {
    scopeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    $('scopeVideo').srcObject = scopeStream;
  } catch (e) {
    $('scopeStatus').textContent = '无法打开后置摄像头：' + e.message;
  }
  updateGunStatusText();
  scopeRAF = requestAnimationFrame(scopeFrame);
}
function exitScope() {
  const wasAiming = aiming;
  aiming = false;
  motionSince = null; preRev = 0;
  $('scopeView').classList.add('hidden');
  if (scopeStream) { scopeStream.getTracks().forEach(tr => tr.stop()); scopeStream = null; }
  stopAllFireTimers();
  if (scopeRAF) cancelAnimationFrame(scopeRAF); scopeRAF = null;
  $('scopeStage').style.transform = '';
  // 只有真的在瞄准、且走的是"炮手"这条路进来的才需要把角色切回整车——
  // selectTank() 切坦克时也会调用这个函数防御性地关相机，那时不该打断驾驶员页面。
  if (wasAiming && activeRole === 'gunner') setRole('overview');
}
// 每个武器系统单独保存一种瞄准镜图样（WEAPON_SYSTEMS[id].reticle），这里按名字分发到
// 对应的绘制函数；没有专门图样的武器系统退回到通用十字瞄准镜。
function drawReticle(cv) {
  const style = (WEAPON_SYSTEMS[weaponSysId] || {}).reticle;
  if (style === 'soviet') drawReticleSoviet(cv);
  else if (style === 'german') drawReticleGerman(cv);
  else drawReticleGeneric(cv);
}
function drawReticleGeneric(cv) {
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(80,255,120,.85)'; c.lineWidth = Math.max(1, w * 0.0025);
  c.beginPath();
  c.moveTo(cx - r * 0.9, cy); c.lineTo(cx - r * 0.18, cy);
  c.moveTo(cx + r * 0.18, cy); c.lineTo(cx + r * 0.9, cy);
  c.moveTo(cx, cy - r * 0.9); c.lineTo(cx, cy - r * 0.18);
  c.moveTo(cx, cy + r * 0.18); c.lineTo(cx, cy + r * 0.9);
  c.stroke();
  c.beginPath(); c.arc(cx, cy, r * 0.04, 0, Math.PI * 2); c.fillStyle = 'rgba(80,255,120,.85)'; c.fill();
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2, tick = (i % 6 === 0) ? r * 0.07 : r * 0.035;
    const x1 = cx + Math.cos(a) * (r * 0.94 - tick), y1 = cy + Math.sin(a) * (r * 0.94 - tick);
    const x2 = cx + Math.cos(a) * r * 0.94, y2 = cy + Math.sin(a) * r * 0.94;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
}
// 苏式：中央倒 V 箭头 + 水平密位刻度（59 式）
function drawReticleSoviet(cv) {
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(80,255,120,.9)'; c.lineWidth = Math.max(1, w * 0.0025);
  c.beginPath();
  c.moveTo(cx, cy - r * 0.08); c.lineTo(cx - r * 0.22, cy + r * 0.28);
  c.moveTo(cx, cy - r * 0.08); c.lineTo(cx + r * 0.22, cy + r * 0.28);
  c.moveTo(cx, cy - r * 0.85); c.lineTo(cx, cy - r * 0.08);
  c.stroke();
  for (let i = -6; i <= 6; i++) {
    const x = cx + i * r * 0.1, tall = i % 3 === 0;
    c.beginPath(); c.moveTo(x, cy + r * 0.45); c.lineTo(x, cy + r * 0.45 + (tall ? r * 0.08 : r * 0.04)); c.stroke();
  }
  c.beginPath(); c.moveTo(cx - r * 0.65, cy + r * 0.45); c.lineTo(cx + r * 0.65, cy + r * 0.45); c.stroke();
}
// 德式 TZF：中央大三角 + 两侧小三角 + 外圈距离刻度（虎式/鼠式/Sd.Kfz.222）
function drawReticleGerman(cv) {
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(80,255,120,.9)'; c.fillStyle = 'rgba(80,255,120,.9)'; c.lineWidth = Math.max(1, w * 0.0025);
  const triH = r * 0.22;
  c.beginPath();
  c.moveTo(cx, cy - triH); c.lineTo(cx - triH * 0.6, cy); c.lineTo(cx + triH * 0.6, cy);
  c.closePath(); c.fill();
  [-1, 1].forEach(side => {
    const bx = cx + side * r * 0.5;
    c.beginPath();
    c.moveTo(bx, cy - triH * 0.5); c.lineTo(bx - triH * 0.3, cy); c.lineTo(bx + triH * 0.3, cy);
    c.closePath(); c.fill();
  });
  for (let i = 0; i < 36; i++) {
    const a = i / 36 * Math.PI * 2, tick = (i % 9 === 0) ? r * 0.07 : r * 0.03;
    const x1 = cx + Math.cos(a) * (r * 0.94 - tick), y1 = cy + Math.sin(a) * (r * 0.94 - tick);
    const x2 = cx + Math.cos(a) * r * 0.94, y2 = cy + Math.sin(a) * r * 0.94;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
}
function scopeFrame() {
  shakeAmp *= 0.86; if (shakeAmp < 0.01) shakeAmp = 0;
  $('scopeStage').style.transform = shakeAmp
    ? `translate(${(Math.random() * 2 - 1) * shakeAmp * 16}px, ${(Math.random() * 2 - 1) * shakeAmp * 16}px) rotate(${(Math.random() * 2 - 1) * shakeAmp * 1.2}deg)`
    : '';
  const cv = $('scopeCanvas'), rect = cv.parentElement.getBoundingClientRect();
  if (cv.width !== rect.width) { cv.width = rect.width; cv.height = rect.height; }
  drawReticle(cv);
  updateGunStatusText();
  scopeRAF = requestAnimationFrame(scopeFrame);
}
// ================= track synth v2 =================
// Modal metal clank: each link impact rings a bank of inharmonic resonances.
// Squeal: friction noise through very narrow resonances, gated per wheel turn.
const CLANK_MODES = [[310, 14, 1.0], [870, 18, 0.9], [1460, 22, 0.7], [2330, 26, 0.55], [3480, 30, 0.4]];
const SQUEAL_MODES = [[1980, 45, 1.0], [2860, 50, 0.6], [4350, 55, 0.35]];
function buildTrackSynth() {
  trk = {};
  trk.clankIn = ctx.createGain();
  trk.clankOut = ctx.createGain(); trk.clankOut.gain.value = 1; trk.clankOut.connect(master);
  for (const [f, q, g] of CLANK_MODES) {
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q;
    const gg = ctx.createGain(); gg.gain.value = g * q * 0.55;          // compensate narrow band energy
    trk.clankIn.connect(b); b.connect(gg); gg.connect(trk.clankOut);
  }
  const th = ctx.createBiquadFilter(); th.type = 'lowpass'; th.frequency.value = 180; th.Q.value = 3;
  const thg = ctx.createGain(); thg.gain.value = 1.6;                  // heavy "thunk" of the link
  trk.clankIn.connect(th); th.connect(thg); thg.connect(trk.clankOut);

  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  trk.gate = ctx.createGain(); trk.gate.gain.value = 0;
  trk.sq = [];
  const sum = ctx.createGain(); sum.gain.value = 1;
  for (const [f, q, g] of SQUEAL_MODES) {
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q;
    const gg = ctx.createGain(); gg.gain.value = g * q * 0.5;
    src.connect(b); b.connect(gg); gg.connect(sum);
    trk.sq.push([b, f]);
  }
  const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(1.5);
  sum.connect(sh); sh.connect(trk.gate); trk.gate.connect(master);
  src.start();
}
function clank2(time, amp) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const g = ctx.createGain();
  const dur = 0.004 + Math.random() * 0.004;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(amp, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  s.connect(g); g.connect(trk.clankIn);
  s.start(time, Math.random() * 1.8); s.stop(time + dur + 0.02);
}
function squealAmount(v) {                 // strongest at low-mid speed
  if (v < 0.5) return 0;
  const rise = clamp(v / 4, 0, 1);
  const fade = v < 12 ? 1 : Math.max(0.45, 1 - (v - 12) / 40);
  return rise * fade;
}
function squealEvent(t, wheelRate, v) {
  const amt = squealAmount(v) * (0.35 + Math.random() * 0.65);
  const dur = Math.min(0.08 + Math.random() * 0.22, 0.6 / wheelRate);
  const k = 0.93 + Math.random() * 0.15;
  for (const [b, f] of trk.sq) {
    b.frequency.setValueAtTime(f * k, t);
    b.frequency.linearRampToValueAtTime(f * k * (1.02 + Math.random() * 0.04), t + dur);
  }
  const floor = 0.06 * squealAmount(v);
  trk.gate.gain.setTargetAtTime(0.16 * amt, t, 0.012);
  trk.gate.gain.setTargetAtTime(floor, t + dur, 0.035);
}
// Schedule all track sounds for [now, now+ahead) at tank speed v.
function scheduleTrack(now, ahead, v) {
  if (nextClank < now) nextClank = now;
  if (nextSqueal < now) nextSqueal = now;
  if (trackLoop && trackMode === 'rec') { nextClank = nextSqueal = now + 0.1; return; }
  const v2 = trackMode === 'v2' && trk;
  const rate = clamp(v * 0.9, 0, 32);                    // link hits per second
  if (rate < 0.8) nextClank = now + 0.1;
  else {
    const amp = clamp(0.15 + v / 40, 0, 0.9) * trackFade(realKmh);
    while (nextClank < now + ahead) {
      const a = amp * (0.6 + Math.random() * 0.4);
      if (v2) clank2(nextClank, a * 0.7); else clank(nextClank, a);
      nextClank += (1 / rate) * (0.8 + Math.random() * 0.4);
    }
  }
  if (v2) {
    const wheelRate = v / 3.6 / 2.2;                    // road-wheel turns per second
    if (wheelRate < 0.12) { nextSqueal = now + 0.1; if (v < 0.5) trk.gate.gain.setTargetAtTime(0, now, 0.05); }
    else while (nextSqueal < now + ahead) {
      if (Math.random() < 0.65) squealEvent(nextSqueal, wheelRate, v);
      nextSqueal += (1 / wheelRate) * (0.7 + Math.random() * 0.6);
    }
  } else if (v > 2 && Math.random() < 0.16 * ahead * trackFade(realKmh)) squeak(now);
}

// ================= accelerometer pre-rev =================
// GPS lags 1-2 s at launch. If the phone feels the car start moving while GPS
// still reads 0, slip the clutch a little: modest extra rpm, SOUND ONLY.
const PREREV_THRESH = 0.5;        // m/s^2 smoothed linear acceleration = "car is moving off"
const PREREV_CONFIRM = 0.25;      // s the acceleration must persist
const PREREV_MAX_R = 0.15;        // extra rpm fraction at full pre-rev (~ +290 rpm)
const PREREV_GIVEUP = 4;          // s: GPS still 0 after this -> phone was just handled, back off
const PREREV_STOPPED = 1.5;       // s GPS must have read 0 (ignores the jolt of stopping)
let accSmooth = 0, grav = null, motionSince = null, preRev = 0, startedAt = 0, motionSeen = false;
function onMotion(e) {
  let x, y, z;
  const a = e.acceleration;
  if (a && a.x != null) { x = a.x; y = a.y; z = a.z; }
  else {                                   // no linear accel: remove gravity with a slow low-pass
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    if (!grav) grav = { x: g.x, y: g.y, z: g.z };
    grav.x += (g.x - grav.x) * 0.02; grav.y += (g.y - grav.y) * 0.02; grav.z += (g.z - grav.z) * 0.02;
    x = g.x - grav.x; y = g.y - grav.y; z = g.z - grav.z;
  }
  motionSeen = true;
  accSmooth += (Math.hypot(x, y, z) - accSmooth) * 0.1;
}
function motionStep(nowS, dt) {
  const stopped = realKmh === 0 && zeroSince !== null && nowS - zeroSince >= PREREV_STOPPED && nowS - startedAt > 2;
  let want = 0;
  if (stopped && accSmooth > PREREV_THRESH) {
    if (motionSince === null) motionSince = nowS;
    const held = nowS - motionSince;
    if (held >= PREREV_CONFIRM && held < PREREV_GIVEUP) want = 1;
  } else if (!stopped || accSmooth < PREREV_THRESH * 0.6) motionSince = null;
  preRev += (want - preRev) * clamp(dt / (want > preRev ? 0.4 : 0.6), 0, 1);
  if (preRev < 0.001) preRev = 0;
  return preRev;
}
async function enableMotion(permission) {
  try { if ((await permission) !== 'granted') return; window.addEventListener('devicemotion', onMotion); } catch (e) {}
}

// ================= voice lines =================
// Push-to-talk sound: sharp click + burst of band-limited static ("kssht").
function radioKey(t, down) {
  t = Math.max(t, ctx.currentTime);
  const g0 = RADIO_CLICK_GAIN;
  // click: very short broadband transient
  const c = ctx.createBufferSource(); c.buffer = noiseBuf;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.exponentialRampToValueAtTime(g0 * 1.6, t + 0.001);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  c.connect(cg); cg.connect(master); c.start(t, Math.random()); c.stop(t + 0.03);
  // static burst: key-down short, key-up longer fading squelch tail
  const dur = down ? RADIO_KEYDOWN_DUR : 0.18;
  const lvl = g0 * (down ? 1.5 : 1.1);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t + 0.004);
  ng.gain.exponentialRampToValueAtTime(lvl, t + 0.010);
  ng.gain.setValueAtTime(lvl, t + dur * 0.6);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(bp); bp.connect(ng); ng.connect(master); n.start(t, Math.random()); n.stop(t + dur + 0.02);
}
function sayRandom(cat) {
  const list = voices[cat];
  if (!list.length) return 0;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === lastVoice[cat]) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  lastVoice[cat] = i;
  const b = list[i], now = ctx.currentTime;
  const t0 = now + (RADIO_FX ? RADIO_KEYDOWN_DUR + RADIO_GAP : 0);   // voice only after key-down static has ended
  const s = ctx.createBufferSource(); s.buffer = b;
  s.connect(voiceBus); s.start(t0);
  if (RADIO_FX) {
    radioKey(now, true);                       // key down
    radioKey(t0 + b.duration, false);          // key up + squelch tail
  }
  if (window.onVoice) window.onVoice(cat, i + 1);
  return b.duration;
}
// A: armed once real speed > HALT_ARM; "Halt" when it then drops below HALT_SAY.
// B: armed after standing at 0 for GO_HOLD s; "Losfahren" when speed then reaches GO_SAY.
function checkVoiceEvents(nowS) {
  if (realKmh > HALT_ARM) stateA = true;
  if (stateA && realKmh < HALT_SAY) { sayRandom('halt'); stateA = false; }
  if (realKmh === 0) {
    if (zeroSince === null) zeroSince = nowS;
    if (nowS - zeroSince >= GO_HOLD) stateB = true;
  } else zeroSince = null;
  if (stateB && realKmh >= GO_SAY) { sayRandom('losfahren'); stateB = false; }
}

// ================= 驾驶员页面：手动油门/刹车/离合器/手动挂挡 =================
// 整车(overview) 页面用 GPS/手动滑块模拟"自动驾驶"；驾驶员页面是真的在开——
// 不挂挡、不给油就不会走，离合不分离换挡会打齿轮。离开驾驶员页面后，物理
// 计算切回 physicsStep()，行驶声音回到默认（GPS/手动）模式。
let activeRole = 'overview';
let drv = { throttle: 0, brake: 0, clutch: false, gear: 0, throttleHeld: false, brakeHeld: false };
function driverPhysicsStep(dt) {
  drv.throttle += ((drv.throttleHeld ? 1 : 0) - drv.throttle) * clamp(dt / 0.15, 0, 1);
  drv.brake    += ((drv.brakeHeld    ? 1 : 0) - drv.brake)    * clamp(dt / 0.10, 0, 1);
  const engaged = !drv.clutch && drv.gear > 0;
  if (engaged) {
    const target = GEAR_TOP[drv.gear] * drv.throttle;
    const accel = clamp((target - speedKmh) * 0.9, -MAX_ACCEL * 3, MAX_ACCEL);
    speedKmh = Math.max(0, speedKmh + accel * dt);
  }
  speedKmh = Math.max(0, speedKmh - (drv.brake * 8 + 0.1) * dt);   // 刹车 + 滚动阻力，离合/空挡时也生效
  curGear = drv.gear;

  const demand = clamp(0.08 + drv.throttle * 0.92, 0, 1);
  const rpmT = engaged
    ? clamp(rpmIn(drv.gear, speedKmh, demand), IDLE_RPM, MAX_RPM)
    : IDLE_RPM + drv.throttle * (MAX_RPM - IDLE_RPM) * 0.85;       // 空挡/踩离合：自由升转，不受车速牵制
  engRpm += clamp(rpmT - engRpm, -RPM_FALL * dt, RPM_RISE * dt * (engaged ? 1 : 1.8));
  load += (demand - load) * 0.15;
  realKmh = speedKmh / SPEED_SCALE;   // 仅用于显示，驾驶员页面不读 GPS/陀螺仪
  return { r: (engRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), rpm: engRpm, shift: 0 };
}
function shiftTo(g) {
  if (!ctx) return;
  if (!drv.clutch) { grindGears(); return; }
  if (g !== drv.gear) { drv.gear = g; gearShift(true); }
  document.querySelectorAll('.gear-btn').forEach(b => b.classList.toggle('on', +b.dataset.gear === drv.gear));
}
function grindGears() {
  if (!ctx) return;
  const t = ctx.currentTime;
  noiseHit(t, 0.18, 0.4, 'bandpass', 2200, 3);
  noiseHit(t + 0.05, 0.15, 0.3, 'bandpass', 1500, 4);
  $('driverStatus').textContent = '没踩离合器，挂不进挡！';
}
function updateDriverStatus() {
  $('driverStatus').textContent =
    `挡位 ${drv.gear === 0 ? 'N' : drv.gear} · 离合${drv.clutch ? '分离' : '结合'} · ` +
    `油门 ${Math.round(drv.throttle * 100)}% · 刹车 ${Math.round(drv.brake * 100)}%`;
}
function setRole(r) {
  if (r === 'gunner') { enterScope(); return; }   // 炮手 = 刚做好的瞄准镜/开炮界面
  activeRole = r;
  $('pageOverview').classList.toggle('hidden', r !== 'overview');
  $('pageDriver').classList.toggle('hidden', r !== 'driver');
  document.querySelectorAll('.role-btn').forEach(b => b.classList.toggle('on', b.dataset.role === r));
  if (r !== 'driver') { drv.throttleHeld = false; drv.brakeHeld = false; drv.clutch = false; }
}
document.querySelectorAll('.role-btn').forEach(b => { if (!b.disabled) b.onclick = () => setRole(b.dataset.role); });
bindPress($('pedThrottle'), () => { drv.throttleHeld = true; $('pedThrottle').classList.add('active'); },
                             () => { drv.throttleHeld = false; $('pedThrottle').classList.remove('active'); });
bindPress($('pedBrake'), () => { drv.brakeHeld = true; $('pedBrake').classList.add('active'); },
                          () => { drv.brakeHeld = false; $('pedBrake').classList.remove('active'); });
bindPress($('pedClutch'), () => { drv.clutch = true; $('pedClutch').classList.add('active'); },
                           () => { drv.clutch = false; $('pedClutch').classList.remove('active'); });
document.querySelectorAll('.gear-btn').forEach(b => b.onclick = () => shiftTo(+b.dataset.gear));

// ================= schedulers =================
function scheduleClanks() { scheduleTrack(ctx.currentTime, 0.12, speedKmh); }

function loop() {
  const nowS = performance.now() / 1000;
  const res = activeRole === 'driver' ? driverPhysicsStep(0.05) : physicsStep(realKmh, nowS);
  if (res.shift) gearShift(res.shift > 0);
  $('gear').textContent = curGear === 0 ? 'N' : curGear;
  $('spd').textContent = Math.round(speedKmh);
  $('realSpd').textContent = Math.round(realKmh);
  if (activeRole !== 'driver') checkVoiceEvents(nowS);   // 驾驶员页面是玩家自己开车，不触发车长语音
  updateGuns(0.05);
  const pr = aiming ? 0 : motionStep(nowS, 0.05);          // 举瞄准镜时不让晃动误触发"体感起步"升转
  let sr = res.r, sl = load;
  if (pr > 0) { sr = Math.max(sr, pr * PREREV_MAX_R); sl = Math.max(sl, 0.08 + pr * 0.3); }   // sound only
  $('motionTag').textContent = pr > 0.3 ? ' · 体感起步' : '';
  updateAudio(sr, sl);
  if (activeRole === 'driver') updateDriverStatus();

  if (activeRole !== 'driver' && mode === 'gps' && lastFix && Date.now() - lastFix.wall > 6000) {
    $('status').textContent = 'GPS 信号丢失（隧道？）——保持上次车速';
  }
}

// ================= GPS =================
function hav(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.latitude - a.latitude), dLon = toR(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.latitude)) * Math.cos(toR(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function startGps() {
  if (!navigator.geolocation) { $('status').textContent = '此浏览器不支持定位，用手动模式吧'; return; }
  watchId = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    let v = (c.speed != null && !isNaN(c.speed)) ? c.speed : null;
    if (v == null && lastFix) {
      const dt = (p.timestamp - lastFix.ts) / 1000;
      if (dt > 0.3) v = hav(lastFix.c, c) / dt;
    }
    lastFix = { c, ts: p.timestamp, wall: Date.now() };
    $('acc').textContent = Math.round(c.accuracy) + 'm';
    if (v != null && mode === 'gps') {
      let k = v * 3.6;
      if (k < 2.5) k = 0;
      realKmh = clamp(k, 0, 200);
      if ($('status').textContent.startsWith('GPS 信号丢失')) $('status').textContent = 'GPS 已恢复';
    }
  }, e => {
    $('status').textContent = '定位失败：' + e.message + '（可切到手动测试）';
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

// ================= wake lock =================
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) { keepAwake(); ctx && ctx.resume(); }
});

// ================= UI =================
$('start').onclick = async () => {
  // iOS asks for motion permission; must be requested directly inside the tap
  const motionPerm = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
    ? DeviceMotionEvent.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
  $('start').disabled = true;
  if (!ctx) await buildAudio(); else await ctx.resume();
  running = true;
  const t = ctx.currentTime + 0.05;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime($('vol').value / 100, t);
  if (engineMode !== 'sample') starterMotor(t);
  for (const k in engines) if (engines[k]) engines[k].crank(t);
  engineReadyAt = t + 2.2;
  $('start').disabled = false;
  $('start').classList.add('hidden');
  $('controls').classList.remove('hidden');
  loopTimer = setInterval(loop, 50);
  schedTimer = setInterval(scheduleClanks, 25);
  startGps(); keepAwake();
  startedAt = performance.now() / 1000;
  enableMotion(motionPerm);
};
$('stop').onclick = () => {
  running = false;
  clearInterval(loopTimer); clearInterval(schedTimer);
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  let tail = 0;
  if (engineMode === 'sample' && engines.sample) tail = engines.sample.stop(ctx.currentTime) || 0;
  master.gain.setTargetAtTime(0, ctx.currentTime + tail, 0.3);
  setTimeout(() => ctx.suspend(), (tail + 1.5) * 1000);
  try { wakeLock && wakeLock.release(); } catch (e) {}
  $('controls').classList.add('hidden');
  $('start').classList.remove('hidden');
};
$('scopeExit').onclick = exitScope;
// 发动机/履带声音不再由玩家单独切换——固定由当前选中的坦克(TANKS)决定。
function setEngineMode(m) {
  if (m === 'sample' && ctx && !engines.sample) m = 'classic';   // files missing
  engineMode = m;
  if (ctx) for (const k in engBus) engBus[k].gain.setTargetAtTime(k === m ? 1 : 0, ctx.currentTime, 0.1);
}
function setTrackMode(m) { trackMode = m; }
$('vol').oninput = e => master && master.gain.setTargetAtTime(e.target.value / 100, ctx.currentTime, 0.05);
$('mGps').onclick = () => { mode = 'gps'; $('mGps').classList.add('on'); $('mMan').classList.remove('on'); $('manualBox').classList.add('hidden'); };
$('mMan').onclick = () => { mode = 'man'; $('mMan').classList.add('on'); $('mGps').classList.remove('on'); $('manualBox').classList.remove('hidden'); realKmh = +$('man').value; };
$('man').oninput = e => { $('manVal').textContent = e.target.value; if (mode === 'man') realKmh = +e.target.value; };

// 到这里为止所有 let/const 顶层变量都已经执行过了，现在才真正选定初始坦克
// （selectTank 会调用 exitScope()/initWeaponSystem()，提前调用会踩到还没初始化的变量）。
selectTank(currentTankId);
