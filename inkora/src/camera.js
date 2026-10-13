'use strict';

// Floating webcam bubble, so students can see the teacher next to the content.
(() => {
  const api = window.annotator;
  const svg = window.svgIcon;
  const video = document.getElementById('video');
  const message = document.getElementById('message');
  let settings = null;
  let deviceId = null;
  let stream = null;

  document.getElementById('shape').innerHTML = svg('ellipse');
  document.getElementById('smaller').innerHTML = svg('minus');
  document.getElementById('bigger').innerHTML = svg('plus');
  document.getElementById('mirror').innerHTML = svg('mirror');
  document.getElementById('close').innerHTML = svg('close');

  const save = (patch) => api.invoke('settings:update', patch);
  document.getElementById('shape').addEventListener('click', () => save({ cameraShape: settings.cameraShape === 'circle' ? 'rounded' : 'circle' }));
  document.getElementById('smaller').addEventListener('click', () => save({ cameraSize: settings.cameraSize - 40 }));
  document.getElementById('bigger').addEventListener('click', () => save({ cameraSize: settings.cameraSize + 40 }));
  document.getElementById('mirror').addEventListener('click', () => save({ cameraMirror: !settings.cameraMirror }));
  document.getElementById('close').addEventListener('click', () => api.command('webcam'));

  async function startCamera(id) {
    deviceId = id;
    if (stream) for (const t of stream.getTracks()) t.stop();
    message.textContent = 'Starting camera…';
    const video_ = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: id ? { ...video_, deviceId: { exact: id } } : video_ });
      } catch (err) {
        if (!id) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video: video_ }); // saved camera unplugged
      }
      video.srcObject = stream;
      message.textContent = '';
    } catch (err) {
      message.textContent = `No camera available (${err.message})`;
    }
  }

  api.onState((state) => {
    settings = state.settings;
    document.body.className = `${settings.cameraShape}${settings.cameraMirror ? ' mirror' : ''}`;
    if (deviceId !== settings.cameraDeviceId) startCamera(settings.cameraDeviceId);
  });
})();
