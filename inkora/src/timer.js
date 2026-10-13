'use strict';

// Floating class timer: countdown with presets (beeps and flashes at zero) or stopwatch.
(() => {
  const api = window.annotator;
  const svg = window.svgIcon;
  const display = document.getElementById('display');
  const startBtn = document.getElementById('start');

  let mode = 'countdown';
  let duration = 5 * 60 * 1000; // countdown length
  let elapsed = 0; // time run so far, excluding the current running stretch
  let runningSince = null; // timestamp when the current stretch started
  let alarmed = false;
  let tick = 0;

  document.getElementById('minus').innerHTML = svg('minus');
  document.getElementById('plus').innerHTML = svg('plus');
  document.getElementById('reset').innerHTML = svg('reset');
  document.getElementById('close').innerHTML = svg('close');

  function total() {
    return elapsed + (runningSince ? Date.now() - runningSince : 0);
  }

  function format(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  function beep() {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
    setTimeout(() => ctx.close(), 1500);
  }

  function render() {
    const t = total();
    const left = duration - t;
    if (mode === 'countdown') {
      display.textContent = format(left);
      if (left <= 0 && runningSince && !alarmed) {
        alarmed = true;
        beep();
      }
    } else {
      display.textContent = format(t - 999); // stopwatch counts up from 00:00
    }
    document.body.classList.toggle('warning', mode === 'countdown' && left > 0 && left <= 10000 && !!runningSince);
    document.body.classList.toggle('done', mode === 'countdown' && left <= 0);
    document.body.classList.toggle('stopwatch', mode === 'stopwatch');
    startBtn.innerHTML = svg(runningSince ? 'pause' : 'play');
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.mode === mode);
  }

  function setRunning(run) {
    if (run && !runningSince) runningSince = Date.now();
    if (!run && runningSince) {
      elapsed += Date.now() - runningSince;
      runningSince = null;
    }
    clearInterval(tick);
    if (run) tick = setInterval(render, 200);
    render();
  }

  function reset() {
    setRunning(false);
    elapsed = 0;
    alarmed = false;
    render();
  }

  startBtn.addEventListener('click', () => {
    if (mode === 'countdown' && total() >= duration) reset();
    setRunning(!runningSince);
  });
  document.getElementById('reset').addEventListener('click', reset);
  document.getElementById('minus').addEventListener('click', () => {
    duration = Math.max(60000, duration - 60000);
    alarmed = false;
    render();
  });
  document.getElementById('plus').addEventListener('click', () => {
    duration = Math.min(5 * 3600000, duration + 60000);
    alarmed = false;
    render();
  });
  for (const b of document.querySelectorAll('#presets button')) {
    b.addEventListener('click', () => {
      duration = Number(b.dataset.min) * 60000;
      reset();
    });
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      reset();
    });
  }
  document.getElementById('close').addEventListener('click', () => api.command('timer'));
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') startBtn.click();
    if (e.key.toLowerCase() === 'r') reset();
  });

  api.onState((state) => document.body.classList.toggle('light', state.settings.theme === 'light'));
  render();
})();
