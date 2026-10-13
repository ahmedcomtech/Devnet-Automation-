'use strict';

// Hidden helper page: records the screen (plus microphone / system audio) with MediaRecorder
// and streams the encoded chunks to the main process, which writes them to disk.
(() => {
  const api = window.annotator;
  const MIME_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

  let recorder = null;
  let streams = [];
  let audioContext = null;
  let chain = Promise.resolve(); // keeps chunks in order and ahead of the "stopped" event

  function cleanup() {
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    streams = [];
    if (audioContext) audioContext.close();
    audioContext = null;
  }

  async function microphone(deviceId) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (!deviceId) throw err;
      // The saved microphone may be unplugged: fall back to the default one.
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    }
  }

  async function start(opts) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: opts.fps }, audio: !!opts.systemAudio });
      streams.push(display);
      const tracks = [...display.getVideoTracks()];
      const audioSources = display.getAudioTracks().length ? [display] : [];
      if (opts.mic) {
        try {
          const mic = await microphone(opts.micDeviceId);
          streams.push(mic);
          audioSources.push(mic);
        } catch (err) {
          api.recorderEvent('warning', `Microphone unavailable (${err.message}); recording without it.`);
        }
      }
      if (audioSources.length === 1) {
        tracks.push(...audioSources[0].getAudioTracks());
      } else if (audioSources.length > 1) {
        // Mix system audio and microphone into one track.
        audioContext = new AudioContext();
        const mix = audioContext.createMediaStreamDestination();
        for (const s of audioSources) audioContext.createMediaStreamSource(s).connect(mix);
        tracks.push(...mix.stream.getAudioTracks());
      }

      const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: opts.fps > 30 ? 12e6 : 8e6, audioBitsPerSecond: 160e3 });
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        chain = chain.then(async () => api.recorderEvent('chunk', new Uint8Array(await e.data.arrayBuffer())));
      };
      recorder.onstop = () => {
        cleanup();
        chain = chain.then(() => api.recorderEvent('stopped'));
      };
      recorder.onerror = (e) => api.recorderEvent('error', (e.error && e.error.message) || 'Recording failed');
      // Stop cleanly if the captured screen goes away.
      display.getVideoTracks()[0].addEventListener('ended', () => recorder && recorder.state !== 'inactive' && recorder.stop());

      api.recorderEvent('started', { mimeType: recorder.mimeType || mimeType });
      recorder.start(1000);
    } catch (err) {
      cleanup();
      api.recorderEvent('error', err.message || String(err));
    }
  }

  api.onCommand((name, arg) => {
    if (name === 'start') start(arg);
    else if (!recorder || recorder.state === 'inactive') return;
    else if (name === 'pause' && recorder.state === 'recording') recorder.pause();
    else if (name === 'resume' && recorder.state === 'paused') recorder.resume();
    else if (name === 'stop') recorder.stop();
  });

  api.ready();
})();
