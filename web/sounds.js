'use strict';
/* ======================================================================
   Sound engine. All presets are synthesized with Web Audio (no files),
   and every preset scales with rarity rank (0 = common … 4 = exotic).
   Users can also pick their own audio file for any slot.
   ====================================================================== */
const SFX = (() => {
  let a = null, master = null, noiseBuf = null;
  const fileCache = new Map();

  function ctx() {
    if (!a) {
      try { a = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      master = a.createGain();
      master.connect(a.destination);
    }
    if (a.state === 'suspended') a.resume();
    return a;
  }
  function noise() {
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  // A per-sound output bus so the whole sound can be faded/stopped at once.
  function bus(vol) {
    const g = a.createGain();
    g.gain.value = vol;
    g.connect(master);
    return g;
  }
  const v = (x) => Math.max(0.0001, x);

  // ---- building blocks ----
  function tone(out, t, dur, { type = 'sine', f, f2, vol = 0.2, att = 0.005, detune = 0 }) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v(vol), t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function hiss(out, t, dur, { vol = 0.2, type = 'bandpass', f = 1000, f2, q = 1, att = 0.005 }) {
    const s = a.createBufferSource(), fl = a.createBiquadFilter(), g = a.createGain();
    s.buffer = noise(); s.loop = true;
    fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v(vol), t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(out);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  // Gain node that swells from silence to `vol` over `d` seconds.
  function swell(out, t, d, vol) {
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v(vol), t + d);
    g.connect(out);
    return g;
  }
  const hz = (semis, base = 261.63) => base * Math.pow(2, semis / 12);
  const PENTA = [0, 2, 4, 7, 9];
  const pent = (i, base = 523.25) => base * Math.pow(2, (PENTA[i % 5] + 12 * Math.floor(i / 5)) / 12);

  // Brass-like voice: detuned saws through an opening lowpass.
  function brass(out, t, f, dur, vol) {
    const fl = a.createBiquadFilter(), g = a.createGain();
    fl.type = 'lowpass'; fl.Q.value = 2;
    fl.frequency.setValueAtTime(500, t); fl.frequency.exponentialRampToValueAtTime(3200, t + 0.06); fl.frequency.exponentialRampToValueAtTime(1400, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v(vol), t + 0.03);
    g.gain.setValueAtTime(v(vol), t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    fl.connect(g); g.connect(out);
    for (const d of [-8, 8]) {
      const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  // Vowel-ish "aah" voice: saws through two formant filters with vibrato.
  function voice(out, t, f, dur, vol, att = 0.25) {
    const g = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
    lfo.frequency.value = 5.2; lg.gain.value = f * 0.012; lfo.connect(lg);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v(vol), t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [ff, q, gv] of [[750, 6, 1], [1200, 8, 0.6]]) {
      const bp = a.createBiquadFilter(), bg = a.createGain();
      bp.type = 'bandpass'; bp.frequency.value = ff; bp.Q.value = q; bg.gain.value = gv;
      bp.connect(bg); bg.connect(g);
      for (const d of [-6, 6]) {
        const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
        lg.connect(o.frequency); o.connect(bp); o.start(t); o.stop(t + dur + 0.05);
      }
    }
    g.connect(out); lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  function thump(out, t, vol = 0.5, f = 150) { tone(out, t, 0.45, { f, f2: 40, vol }); }

  /* ------------------------------------------------------------------
     Build-up presets: (out, t, d seconds, rank). Scheduled up-front;
     the caller fades the bus to stop early.
     ------------------------------------------------------------------ */
  const BUILDUPS = {
    riser: { label: 'Classic riser', fn(out, t, d, r) {
      const top = [500, 650, 850, 1100, 1500][r];
      const fl = a.createBiquadFilter(); fl.type = 'lowpass';
      fl.frequency.setValueAtTime(300, t); fl.frequency.exponentialRampToValueAtTime(4000, t + d);
      fl.connect(swell(out, t, d * 0.95, 0.13));
      for (const [type, k] of [['sawtooth', 1], ['triangle', 0.5]]) {
        const o = a.createOscillator(); o.type = type;
        o.frequency.setValueAtTime(90 * k, t); o.frequency.exponentialRampToValueAtTime(top * k, t + d);
        o.connect(fl); o.start(t); o.stop(t + d + 0.1);
      }
    } },
    drumroll: { label: 'Drum roll', fn(out, t, d, r) {
      for (let tt = t; tt < t + d; ) {
        const p = (tt - t) / d;
        hiss(out, tt, 0.09, { vol: 0.05 + 0.25 * p, type: 'highpass', f: 1800 });
        tone(out, tt, 0.07, { type: 'triangle', f: 190, f2: 100, vol: 0.05 + 0.18 * p });
        if (r >= 3) tone(out, tt, 0.25, { f: 75, f2: 55, vol: 0.12 + 0.2 * p });
        tt += 0.14 - 0.1 * p + (Math.random() - 0.5) * 0.01;
      }
    } },
    heartbeat: { label: 'Heartbeat', fn(out, t, d, r) {
      for (let tt = t; tt < t + d - 0.2; ) {
        const p = (tt - t) / d;
        thump(out, tt, 0.35 + 0.35 * p, 75);
        thump(out, tt + 0.17, 0.22 + 0.3 * p, 62);
        tt += 0.85 - 0.5 * p;
      }
      if (r >= 2) { const g = swell(out, t, d, 0.03 + r * 0.012); tone(g, t, d + 0.1, { type: 'sine', f: 1760, vol: 1, att: d * 0.9 }); }
    } },
    scifi: { label: 'Sci-fi charge', fn(out, t, d, r) {
      const o = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), fl = a.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime([440, 520, 660, 880, 1200][r], t + d);
      lfo.frequency.setValueAtTime(3, t); lfo.frequency.exponentialRampToValueAtTime(28 + r * 6, t + d);
      lg.gain.setValueAtTime(20, t); lg.gain.linearRampToValueAtTime(160, t + d);
      lfo.connect(lg); lg.connect(o.frequency);
      fl.type = 'bandpass'; fl.Q.value = 3; fl.frequency.setValueAtTime(400, t); fl.frequency.exponentialRampToValueAtTime(3500, t + d);
      o.connect(fl); fl.connect(swell(out, t, d, 0.22));
      o.start(t); lfo.start(t); o.stop(t + d + 0.1); lfo.stop(t + d + 0.1);
    } },
    chimes: { label: 'Wind chimes', fn(out, t, d, r) {
      for (let tt = t; tt < t + d; ) {
        const p = (tt - t) / d;
        const f = pent(Math.floor(p * (6 + r * 2) + Math.random() * 4));
        tone(out, tt, 1.3, { f, vol: 0.05 + 0.05 * p });
        tone(out, tt, 0.6, { f: f * 2.76, vol: 0.015 });
        tt += 0.3 - 0.24 * p + Math.random() * 0.05;
      }
    } },
    wheel: { label: 'Prize wheel', fn(out, t, d, r) {
      // Fast clicks that slow down as the wheel settles.
      let tt = t, i = 0;
      while (tt < t + d - 0.05) {
        const p = (tt - t) / d;
        hiss(out, tt, 0.025, { vol: 0.25, type: 'highpass', f: 3000 });
        tone(out, tt, 0.03, { type: 'square', f: 1500 + (i++ % 2) * 200, vol: 0.04 });
        tt += 0.035 + 0.3 * p * p * p;
      }
    } },
    arcade: { label: 'Arcade climb', fn(out, t, d, r) {
      const steps = [0, 4, 7, 12];
      let i = 0;
      for (let tt = t; tt < t + d; tt += 0.075) {
        const p = (tt - t) / d;
        const oct = Math.floor(p * (2 + r * 0.5));
        tone(out, tt, 0.07, { type: 'square', f: hz(steps[i++ % 4] + oct * 12 - 12), vol: 0.035 + 0.03 * p });
      }
    } },
    choir: { label: 'Angelic swell', fn(out, t, d, r) {
      const g = swell(out, t, d, 0.5);
      const chord = [0, 3, 7, 12, 15].slice(0, 3 + Math.min(2, r));
      for (const s of chord) voice(g, t, hz(s, 220), d + 0.2, 0.18, 0.1);
    } },
    rumble: { label: 'Earthquake', fn(out, t, d, r) {
      const g = swell(out, t, d, 0.6 + r * 0.1);
      hiss(g, t, d + 0.1, { vol: 0.6, type: 'lowpass', f: 90, f2: 500 + r * 150, att: 0.05 });
      tone(g, t, d + 0.1, { f: 38, f2: 60, vol: 0.5, att: 0.05 });
      if (r >= 3) for (let tt = t + d * 0.4; tt < t + d; tt += 0.06 + Math.random() * 0.1)
        hiss(out, tt, 0.05, { vol: 0.1, type: 'highpass', f: 2000 });
    } },
    tension: { label: 'Suspense strings', fn(out, t, d, r) {
      // Tremolo-ish dissonant cluster that rises a semitone at a time.
      const g = swell(out, t, d, 0.35);
      const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(800, t); fl.frequency.exponentialRampToValueAtTime(5000, t + d); fl.connect(g);
      for (const s of [0, 1, 6]) {
        const o = a.createOscillator(); o.type = 'sawtooth';
        const steps = 3 + r;
        for (let i = 0; i <= steps; i++) o.frequency.setValueAtTime(hz(s + i, 196), t + (d * i) / (steps + 1));
        const trem = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
        lfo.frequency.value = 9 + r * 2; lg.gain.value = 0.5; trem.gain.value = 0.5;
        lfo.connect(lg); lg.connect(trem.gain);
        o.connect(trem); trem.connect(fl);
        o.start(t); lfo.start(t); o.stop(t + d + 0.1); lfo.stop(t + d + 0.1);
      }
    } },
    none: { label: 'Silent', fn() {} },
  };

  /* ------------------------------------------------------------------
     Reveal presets: (out, t, rank)
     ------------------------------------------------------------------ */
  const REVEALS = {
    chime: { label: 'Crystal chime', fn(out, t, r) {
      thump(out, t, 0.35, 160);
      const chord = [[523], [523, 659], [523, 659, 784], [523, 659, 784, 1047, 1319], [392, 523, 659, 784, 1047, 1319, 1568, 2093]][r];
      const step = r === 4 ? 0.07 : 0.09, len = r === 0 ? 0.5 : 1.6;
      chord.forEach((f, i) => tone(out, t + 0.05 + i * step, len, { type: i % 2 ? 'triangle' : 'sine', f, vol: 0.09, att: 0.02 }));
    } },
    fanfare: { label: 'Royal fanfare', fn(out, t, r) {
      const C = 523.25, E = 659.25, G = 783.99, G4 = 392, C6 = 1046.5;
      const seqs = [
        [[C, 0, 0.3]],
        [[G4, 0, 0.12], [C, 0.13, 0.4]],
        [[G4, 0, 0.12], [C, 0.13, 0.12], [E, 0.26, 0.5]],
        [[G4, 0, 0.1], [G4, 0.11, 0.1], [G4, 0.22, 0.1], [C, 0.33, 0.25], [E, 0.6, 0.15], [G, 0.77, 0.9]],
        [[C, 0, 0.1], [C, 0.11, 0.1], [C, 0.22, 0.1], [G, 0.33, 0.35], [E, 0.7, 0.12], [G, 0.84, 0.12], [C6, 0.98, 1.4]],
      ][r];
      for (const [f, s, d] of seqs) { brass(out, t + s, f, d, 0.1); if (r >= 3) brass(out, t + s, f / 2, d, 0.07); }
      if (r >= 3) thump(out, t, 0.5, 110);
    } },
    coins: { label: 'Coin shower', fn(out, t, r) {
      const n = [3, 6, 12, 24, 45][r], spread = 0.15 + r * 0.35;
      for (let i = 0; i < n; i++) {
        const s = t + Math.random() * spread, k = 0.9 + Math.random() * 0.25;
        tone(out, s, 0.08, { type: 'square', f: 988 * k, vol: 0.03 });
        tone(out, s + 0.07, 0.35, { type: 'square', f: 1319 * k, vol: 0.03 });
      }
    } },
    sparkle: { label: 'Magic sparkle', fn(out, t, r) {
      const n = 6 + r * 6, len = 0.35 + r * 0.2;
      for (let i = 0; i < n; i++) tone(out, t + (i / n) * len, 0.9, { f: pent(i + 2), vol: 0.06, att: 0.01 });
      hiss(out, t, 1 + r * 0.5, { vol: 0.08 + r * 0.03, type: 'highpass', f: 6000, att: 0.05 });
      if (r >= 3) tone(out, t + len, 2, { type: 'triangle', f: pent(n + 4), vol: 0.07 });
    } },
    bit8: { label: '8-bit power-up', fn(out, t, r) {
      const seq = [[0, 4, 7], [0, 4, 7, 12], [0, 4, 7, 12, 16], [0, 4, 7, 12, 7, 12, 16, 19], [0, 4, 7, 12, 4, 7, 12, 16, 7, 12, 16, 19, 24]][r];
      seq.forEach((s, i) => tone(out, t + i * 0.06, i === seq.length - 1 ? 0.25 + r * 0.15 : 0.07, { type: 'square', f: hz(s, 523.25), vol: 0.05 }));
    } },
    orchestra: { label: 'Orchestra hit', fn(out, t, r) {
      const chord = [0, 7, 12, 16, 19, 24].slice(0, 2 + r);
      const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 2400; fl.connect(out);
      for (const s of chord) brass(fl, t, hz(s, 130.81), 1 + r * 0.4, 0.07);
      tone(out, t, 1 + r * 0.3, { f: 95, f2: 50, vol: 0.5 });
      if (r >= 2) hiss(out, t, 1.2 + r * 0.6, { vol: 0.12, type: 'highpass', f: 5000 });
    } },
    gong: { label: 'Temple gong', fn(out, t, r) {
      const base = [220, 170, 130, 100, 75][r];
      [1, 1.48, 1.98, 2.44, 2.92, 3.6, 4.1].forEach((k, i) => tone(out, t, 2 + r * 0.8 - i * 0.15, { f: base * k, vol: 0.12 / (i + 1), att: 0.01 }));
      hiss(out, t, 0.25, { vol: 0.2, type: 'lowpass', f: 500 });
    } },
    choir: { label: 'Heavenly choir', fn(out, t, r) {
      const chord = [[0], [0, 7], [0, 4, 7], [0, 4, 7, 12], [0, 4, 7, 12, 16, 19]][r];
      for (const s of chord) voice(out, t, hz(s, 261.63), 1.4 + r * 0.5, 0.12, 0.08);
      if (r >= 3) tone(out, t, 2, { type: 'triangle', f: 2093, vol: 0.03, att: 0.3 });
    } },
    laser: { label: 'Laser zap', fn(out, t, r) {
      for (let i = 0; i <= r; i++) tone(out, t + i * 0.11, 0.25, { type: 'square', f: 1600 + i * 300, f2: 120, vol: 0.06 });
      if (r >= 3) tone(out, t + (r + 1) * 0.11, 0.6, { type: 'sawtooth', f: 200, f2: 2400, vol: 0.05 });
    } },
    boom: { label: 'Explosion', fn(out, t, r) {
      hiss(out, t, 1 + r * 0.5, { vol: 0.5, type: 'lowpass', f: 1500, f2: 80 });
      tone(out, t, 1 + r * 0.3, { f: 120, f2: 30, vol: 0.6 });
      if (r >= 3) for (let i = 0; i < 12 * (r - 2); i++) hiss(out, t + 0.2 + Math.random() * 1.2, 0.05, { vol: 0.08, type: 'bandpass', f: 1500 + Math.random() * 3000, q: 4 });
    } },
    bell: { label: 'Victory bells', fn(out, t, r) {
      const n = 1 + r * 2;
      for (let i = 0; i < n; i++) {
        const f = pent(r * 2 + (n - i), 392), s = t + i * 0.16;
        for (const [k, vol] of [[1, 0.08], [2.4, 0.03], [3.9, 0.015]]) tone(out, s, 1.8, { f: f * k, vol });
      }
    } },
    none: { label: 'Silent', fn() {} },
  };

  async function fileBuffer(file) {
    if (!fileCache.has(file)) {
      fileCache.set(file, fetch(imgURL(file)).then((r) => r.arrayBuffer()).then((b) => a.decodeAudioData(b)).catch(() => null));
    }
    return fileCache.get(file);
  }
  function playFile(out, file, t) {
    fileBuffer(file).then((buf) => {
      if (!buf) return;
      const s = a.createBufferSource(); s.buffer = buf; s.connect(out); s.start(Math.max(t, a.currentTime));
    });
  }

  // Fade a bus out and disconnect it.
  function fadeOut(g, sec = 0.08) {
    try {
      const n = a.currentTime;
      g.gain.cancelScheduledValues(n); g.gain.setValueAtTime(g.gain.value, n); g.gain.linearRampToValueAtTime(0, n + sec);
      setTimeout(() => g.disconnect(), sec * 1000 + 100);
    } catch {}
  }

  return {
    BUILDUPS, REVEALS,
    preload(file) { if (ctx() && file) fileBuffer(file); },
    // cfg: { enabled, master, volume (0..1), id, file }
    buildup(cfg, ms, rank) {
      if (!cfg.enabled || !ctx()) return () => {};
      master.gain.value = cfg.master;
      const out = bus(cfg.volume);
      const t = a.currentTime + 0.02;
      if (cfg.id === 'custom') { if (cfg.file) playFile(out, cfg.file, t); }
      else (BUILDUPS[cfg.id] || BUILDUPS.riser).fn(out, t, ms / 1000, rank);
      let stopped = false;
      return () => { if (!stopped) { stopped = true; fadeOut(out); } };
    },
    reveal(cfg, rank) {
      if (!cfg.enabled || !ctx()) return () => {};
      master.gain.value = cfg.master;
      const out = bus(cfg.volume);
      const t = a.currentTime + 0.01;
      if (cfg.id === 'custom') { if (cfg.file) playFile(out, cfg.file, t); }
      else (REVEALS[cfg.id] || REVEALS.chime).fn(out, t, rank);
      return () => fadeOut(out, 0.3);
    },
    setMaster(x) { if (master) master.gain.value = x; },
  };
})();
