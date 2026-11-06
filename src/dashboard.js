'use strict';
const get = id => document.getElementById(id);
const canvas = get('drawing');
const ink = canvas.getContext('2d', { willReadFrequently: true });
const modelNames = {
  mnist: 'MNIST', 'conv-small': 'Small convolution', 'conv-wide': 'Wide convolution', 'conv-large': 'Large convolution'
};
let benchmarkRows = [];
let activePointer = null;

function bar(label, value, max, text, color) {
  const row = document.createElement('div');
  row.className = 'bar-row';
  const name = document.createElement('span');
  name.textContent = label;
  const track = document.createElement('div');
  track.className = 'bar-track';
  track.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'bar ' + color;
  fill.style.width = (max && value !== undefined ? value / max * 100 : 0) + '%';
  track.append(fill);
  const display = document.createElement('span');
  display.textContent = text;
  row.append(name, track, display);
  return row;
}

function parseBenchmarks(report) {
  const sections = report.split(/^=== (.+) \/ (CPU|GPU|NPU) ===\r?$/m);
  const rows = [];
  for (let i = 1; i + 2 < sections.length; i += 3) {
    const [, path, device, output] = sections.slice(i - 1, i + 3);
    const filename = path.split(/[\\/]/).pop().replace(/\.(xml|onnx)$/i, '');
    const row = { model: filename === 'mnist-8' ? 'mnist' : filename, device };
    if (output.includes('Result: completed')) {
      const time = regex => {
        const match = output.match(regex);
        if (match) return Number(match[1]) * ({ ns: .000001, us: .001, ms: 1, s: 1000 }[match[2]]);
      };
      row.median = time(/Median:\s+([\d.]+)\s+(ns|us|ms|s)\b/);
      row.first = time(/First inference took\s+([\d.]+)\s+(ns|us|ms|s)\b/);
      const fps = output.match(/Throughput:\s+([\d.]+)\s+FPS/);
      if (fps) row.throughput = Number(fps[1]);
    }
    rows.push(row);
  }
  return rows;
}

function renderChart() {
  const chart = get('chart');
  chart.replaceChildren();
  const metric = get('metric').value;
  const max = Math.max(0, ...benchmarkRows.map(row => row[metric] ?? 0));
  for (const model of new Set(benchmarkRows.map(row => row.model))) {
    const group = document.createElement('div');
    group.className = 'chart-group';
    const title = document.createElement('strong');
    title.textContent = modelNames[model] ?? model;
    group.append(title);
    for (const row of benchmarkRows.filter(row => row.model === model)) {
      const value = row[metric];
      const unit = metric === 'throughput' ? ' inf/s' : ' ms';
      const text = value === undefined ? 'Unavailable' : value.toFixed(metric === 'throughput' ? 1 : 3) + unit;
      group.append(bar(row.device, value, max, text, row.device));
    }
    chart.append(group);
  }
}

const localActivity = new Map();
let serverLocalBusy = false;
function renderLocalActivity() {
  const messages = [...localActivity.keys()].map(status => status.textContent);
  const text = messages.join(' · ') || (serverLocalBusy ? 'Local worker running' : 'Idle');
  const output = get('header-local-activity');
  if (output.textContent !== text) output.textContent = text;
}

async function withBusy(form, status, pending, action) {
  const controls = [...form.elements].filter(element => !element.disabled);
  controls.forEach(element => element.disabled = true);
  status.textContent = pending;
  const observer = new MutationObserver(renderLocalActivity);
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  localActivity.set(status, observer);
  renderLocalActivity();
  try {
    await action();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    observer.disconnect();
    localActivity.delete(status);
    renderLocalActivity();
    controls.forEach(element => element.disabled = false);
  }
}

get('metric').onchange = renderChart;
get('benchmark-form').onsubmit = event => {
  event.preventDefault();
  const model = get('benchmark-model').value;
  const iterations = get('iterations').value;
  const status = get('benchmark-status');
  benchmarkRows = [];
  renderChart();
  get('benchmark-details').hidden = true;
  withBusy(event.currentTarget, status, 'Running device comparisons…', async () => {
    const route = model === 'mnist' ? '/bench/mnist' : '/suite';
    const response = await fetch(route + '?iterations=' + iterations, { method: 'POST' });
    const report = await response.text();
    get('benchmark-log').textContent = report;
    get('benchmark-details').hidden = false;
    benchmarkRows = parseBenchmarks(report);
    renderChart();
    status.textContent = response.ok ? 'Benchmark complete. All bars share the same scale.' :
      'Some measurements are unavailable. Check the full OpenVINO output.';
  });
};

get('probe').onclick = async () => {
  const panel = get('hardware');
  panel.hidden = false;
  panel.textContent = 'Detecting hardware…';
  try {
    panel.textContent = await (await fetch('/probe')).text();
  } catch (error) {
    panel.textContent = error.message;
  }
};

function clear() {
  ink.fillStyle = '#000';
  ink.fillRect(0, 0, canvas.width, canvas.height);
}

function draw(event, start) {
  const bounds = canvas.getBoundingClientRect();
  const x = (event.clientX - bounds.left) * canvas.width / bounds.width;
  const y = (event.clientY - bounds.top) * canvas.height / bounds.height;
  ink.strokeStyle = '#fff';
  ink.fillStyle = '#fff';
  ink.lineWidth = 15;
  ink.lineCap = 'round';
  ink.lineJoin = 'round';
  if (start) {
    ink.beginPath();
    ink.arc(x, y, 7.5, 0, 2 * Math.PI);
    ink.fill();
    ink.beginPath();
    ink.moveTo(x, y);
  } else {
    ink.lineTo(x, y);
    ink.stroke();
    ink.beginPath();
    ink.moveTo(x, y);
  }
}

canvas.onpointerdown = event => {
  if (activePointer !== null || get('clear').disabled) return;
  canvas.setPointerCapture(event.pointerId);
  activePointer = event.pointerId;
  draw(event, true);
};
canvas.onpointermove = event => {
  if (activePointer === event.pointerId && !get('clear').disabled) draw(event, false);
};
canvas.onlostpointercapture = () => { activePointer = null; };
get('clear').onclick = clear;
get('sample').onclick = () => {
  clear();
  const digit = get('expected').value || '3';
  get('expected').value = digit;
  ink.fillStyle = '#fff';
  ink.font = 'bold 144px sans-serif';
  ink.textAlign = 'center';
  ink.textBaseline = 'middle';
  ink.fillText(digit, 112, 112);
};
get('task-model').onchange = () => {
  get('task-guide').textContent = get('task-model').value === 'mnist' ?
    'Draw a digit from 0 to 9. The drawing is cropped and centered before inference.' :
    'Try a line, corner, or loop. The filter visualizer preserves the drawing position.';
};

function pixels(center) {
  const source = ink.getImageData(0, 0, 224, 224).data;
  let left = 224, top = 224, right = -1, bottom = -1;
  for (let y = 0; y < 224; y++) {
    for (let x = 0; x < 224; x++) {
      if (source[(y * 224 + x) * 4] > 32) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < 0) throw new Error('Draw something or load a sample first.');
  const tile = document.createElement('canvas');
  tile.width = tile.height = 28;
  const context = tile.getContext('2d');
  context.fillRect(0, 0, 28, 28);
  if (center) {
    const width = right - left + 1;
    const height = bottom - top + 1;
    const scale = 20 / Math.max(width, height);
    context.drawImage(canvas, left, top, width, height, (28 - width * scale) / 2,
      (28 - height * scale) / 2, width * scale, height * scale);
  } else {
    context.drawImage(canvas, 0, 0, 28, 28);
  }
  return Array.from(context.getImageData(0, 0, 28, 28).data.filter((_, i) => i % 4 === 0),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

function renderTask(model, expected, result) {
  const heatmap = get('heatmap');
  const scores = get('scores');
  const status = get('task-status');
  const device = result.devices.join(', ');
  const first = result.inferenceMs.toFixed(2) + ' ms';
  const timing = device + ' · compile ' + result.compileMs.toFixed(2) + ' ms · first call ' + first;
  let summary;
  if (model === 'mnist') {
    const ranked = result.scores.map((score, digit) => ({ score, digit })).sort((a, b) => b.score - a.score);
    const digit = String(ranked[0].digit);
    summary = 'Predicted ' + digit + (expected === '' ? '' : digit === expected ? ' · match' : ' · mismatch');
    for (const { score, digit } of ranked) {
      scores.append(bar(digit, score, 1, (score * 100).toFixed(1) + '%', ''));
    }
  } else {
    summary = 'Channel ' + result.channel + ' · peak ' + result.peak.toFixed(3);
    const context = heatmap.getContext('2d');
    const image = context.createImageData(28, 28);
    result.heatmap.forEach((value, i) => image.data.set([value * 145, value * 242, value * 199, 255], i * 4));
    context.putImageData(image, 0, 0);
    heatmap.hidden = false;
  }
  status.textContent = summary + ' · ' + timing;
  const row = get('trials').insertRow(0);
  for (const value of [modelNames[model], device, model === 'mnist' && expected !== '' ? expected : '—', summary, first]) {
    row.insertCell().textContent = value;
  }
}

get('task-form').onsubmit = event => {
  event.preventDefault();
  const model = get('task-model').value;
  const device = get('device').value;
  const expected = get('expected').value;
  const status = get('task-status');
  get('scores').replaceChildren();
  get('heatmap').hidden = true;
  withBusy(event.currentTarget, status, 'Compiling and running on ' + device + '…', async () => {
    const response = await fetch('/task/' + model + '/' + device + '?pixels=' + pixels(model === 'mnist'), { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    renderTask(model, expected, await response.json());
  });
};

clear();


const views = ['chat', 'images', 'benchmark', 'playground', 'media', 'runpod', 'catalog'];
const themeSelector = get('theme-preference');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
try {
  themeSelector.value = localStorage.getItem('npu-lab-theme') || 'system';
} catch {
  themeSelector.value = 'system';
}
if (!themeSelector.value) themeSelector.value = 'system';
function applyTheme() {
  const preference = themeSelector.value;
  document.documentElement.dataset.theme = preference === 'dark' ||
    (preference === 'system' && systemTheme.matches) ? 'dim' : 'light';
}
themeSelector.onchange = () => {
  applyTheme();
  try { localStorage.setItem('npu-lab-theme', themeSelector.value); } catch {}
};
systemTheme.addEventListener('change', applyTheme);
applyTheme();

function mediaPage() {
  const hash = location.hash;
  if (hash === '#media') return 'speech';
  const page = hash.startsWith('#media/') ? hash.slice(7) : '';
  return ['speech', 'music', 'video'].includes(page) ? page : '';
}

const mediaRail = get('media-nav-group');
try { mediaRail.open = localStorage.getItem('npu-lab-media-rail') !== 'closed'; } catch {}
mediaRail.addEventListener('toggle', () => {
  try { localStorage.setItem('npu-lab-media-rail', mediaRail.open ? 'open' : 'closed'); } catch {}
});

function showView() {
  const target = location.hash.slice(1);
  const page = mediaPage();
  const selected = page ? 'media' : views.includes(target) ? target : 'chat';
  for (const view of views) {
    get(view).hidden = view !== selected;
  }
  const destination = page ? '#media/' + page : '#' + selected;
  for (const link of get('workbench-nav').querySelectorAll('a')) {
    if (link.getAttribute('href') === destination) {
      link.setAttribute('aria-current', 'page');
      get('workspace-view').textContent = page ? 'Media Studio / ' + link.textContent : link.textContent;
    } else link.removeAttribute('aria-current');
  }
  if (page) mediaRail.open = true;
}
window.addEventListener('hashchange', showView);
showView();

let mediaConfig = {};
const mediaSource = get('media-source');
const mediaOptions = [...mediaSource.options];
const mediaDrafts = new Map();
let activeMediaPage;
function updateMediaForm() {
  const external = mediaSource.value.startsWith('eleven-');
  const music = mediaSource.value.endsWith('-music');
  const runpodMusic = mediaSource.value.startsWith('runpod-');
  get('media-lyrics-control').hidden = !runpodMusic;
  get('media-heartmula-settings').hidden = !runpodMusic;
  const video = mediaSource.value === 'local-video';
  get('media-approval').hidden = !external;
  get('media-quota-panel').hidden = !external || !mediaConfig.elevenlabs;
  get('media-voice-label').hidden = mediaSource.value !== 'eleven-speech';
  get('media-paid').checked = false;
  get('media-text-label').textContent = video ? 'Video prompt' : music ? 'Instrumental music prompt' : 'Text to speak';
  get('media-text').maxLength = music || video ? 500 : 1000;
  get('media-key').textContent = external
    ? (mediaConfig.elevenlabs ? 'ElevenLabs key configured' : 'Set ELEVENLABS_DEV_KEY in .env or the server environment.')
    : video ? (mediaConfig.videoSetup || 'Wan runs locally on an NVIDIA CUDA GPU.')
    : runpodMusic ? (mediaConfig.runpod ? 'Enter comma-separated style and instrument tags. Style examples keep your lyrics in place.' : 'Configure the Runpod keys to use GPU music.')
    : music ? (mediaConfig.musicSetup || 'MusicGen runs locally on the CPU.')
    : 'Runs on this PC using an installed Windows voice.';
}
let elevenQuotaNext = 0;
async function refreshMediaQuota(force = false) {
  const button = get('media-refresh-quota');
  if (button.disabled || (!force && (document.hidden || Date.now() < elevenQuotaNext))) return;
  elevenQuotaNext = Date.now() + 60000;
  const display = get('media-quota');
  const balance = get('header-eleven-balance');
  const updated = get('header-eleven-updated');
  button.disabled = true;
  display.textContent = 'Checking ElevenLabs credits…';
  try {
    const response = await fetch('/media/quota');
    if (!response.ok) throw new Error(await response.text());
    const quota = await response.json();
    if (quota.updated) {
      balance.textContent = quota.remaining.toLocaleString() + ' left';
      updated.textContent = (quota.error ? 'Last checked ' : 'Updated ') +
        new Date(quota.updated * 1000).toLocaleTimeString();
    }
    if (quota.error) throw new Error(quota.error);
    updated.title = '';
    const reset = typeof quota.reset === 'number' ? ' · Resets ' + new Date(quota.reset * 1000).toLocaleDateString() : '';
    display.textContent = quota.tier + ' plan · ' + quota.used.toLocaleString() + ' / ' +
      quota.limit.toLocaleString() + ' used · ' + quota.remaining.toLocaleString() + ' left · ' +
      quota.reserve.toLocaleString() + ' held in reserve' + reset;
  } catch (error) {
    if (balance.textContent === 'Loading…') balance.textContent = 'Unavailable';
    updated.textContent = updated.textContent.startsWith('Last checked ')
      ? 'Refresh unavailable · ' + updated.textContent : 'Refresh unavailable';
    updated.title = error.message;
    display.textContent = 'Credit check unavailable. ' + error.message;
  } finally {
    button.disabled = false;
  }
}
get('media-refresh-quota').onclick = () => refreshMediaQuota(true);
document.addEventListener('visibilitychange', () => refreshMediaQuota());
setInterval(refreshMediaQuota, 5000);
refreshMediaQuota();
async function openMedia() {
  const page = mediaPage();
  if (!page) return;
  if (activeMediaPage && activeMediaPage !== page) {
    mediaDrafts.set(activeMediaPage, { source: mediaSource.value, text: get('media-text').value });
  }
  if (activeMediaPage !== page) {
    activeMediaPage = page;
    const draft = mediaDrafts.get(page);
    mediaSource.replaceChildren(...mediaOptions.filter(option => option.dataset.media === page));
    if (draft) mediaSource.value = draft.source;
    get('media-text').value = draft?.text || '';
    get('media-page-title').textContent = { speech: 'Speech', music: 'Music', video: 'Video' }[page];
    for (const slot of ['a', 'b']) {
      get('media-history-' + slot).replaceChildren();
      get('media-result-' + slot).replaceChildren();
    }
  }
  try {
    const response = await fetch('/media/config');
    if (!response.ok) throw new Error(await response.text());
    const config = await response.json();
    if (mediaPage() !== page) return;
    mediaConfig = config;
    const windows = mediaSource.querySelector('[value="windows"]');
    if (windows) {
      windows.disabled = !mediaConfig.windows;
      if (!mediaConfig.windows && mediaSource.value === 'windows') mediaSource.value = 'eleven-speech';
    }
    updateMediaForm();
    await loadMediaHistory();
    await refreshMediaQuota();
  } catch (error) {
    get('media-status').textContent = error.message;
  }
}
mediaSource.onchange = () => {
  updateMediaForm();
  refreshMediaQuota();
};
get('media-sample').onclick = () => {
  if (mediaSource.value === 'runpod-music') {
    get('media-style-samples').querySelector('button').click();
    return;
  }
  get('media-text').value = mediaSource.value === 'local-video'
    ? 'A locked camera watches Crystal Rowan mend a Dayton cottage gate in a pocketed apron. Her red-framed glasses, straight brown work bun, and silver crescent necklace stay consistent. A mossy root curls around a wheelbarrow. Gentle morning light, subtle movements, no lettering.'
    : mediaSource.value.endsWith('-music')
    ? 'A whimsical instrumental cue for The Witch of Dayton. The Undefeated Root has tangled the lanterns, and neighbors work together to free them. Playful bassoon and pizzicato strings, gentle waltz pulse, warm celesta, and a quiet resolved ending. Leave room for dialogue.'
    : 'Crystal Rowan set two mugs on the porch. The garden gate was rooted shut again. David unfolded his tape measure. “We can fix it,” he said. Crystal handed him a mug. “Good. I could use the help.”';
};
function showMediaResult(slot, result) {
  const player = document.createElement(result.mime === 'video/mp4' ? 'video' : 'audio');
  player.controls = true;
  player.className = 'w-full';
  player.src = 'data:' + result.mime + ';base64,' + result.audio;
  const details = document.createElement('p');
  const usage = result.usage?.characterCost;
  details.textContent = [result.replay && 'Replay', result.location, result.model, result.voice,
    (result.elapsedMs / 1000).toFixed(2) + ' s original runtime', result.billing,
    usage != null && usage + ' provider-reported character cost',
    result.durationSeconds != null && result.durationSeconds.toFixed(1) + ' s audio' +
      (result.requestedDurationSeconds != null ? ' / ' + result.requestedDurationSeconds + ' s maximum' : '')]
    .filter(Boolean).join(' · ');
  const prompt = document.createElement('p');
  prompt.textContent = result.text;
  get('media-result-' + slot).replaceChildren(player, details, prompt);
}
async function loadMediaHistory(latest) {
  const page = mediaPage();
  if (!page) return;
  const response = await fetch('/media/history?type=' + page);
  if (!response.ok) throw new Error(await response.text());
  const rows = await response.json();
  if (mediaPage() !== page) return;
  if (latest && !mediaOptions.some(option => option.value === latest.source && option.dataset.media === page)) latest = null;
  for (const slot of ['a', 'b']) {
    const select = get('media-history-' + slot);
    const selected = slot === 'a' && latest ? String(latest.id) : select.value;
    select.replaceChildren(new Option('Choose a saved run', ''));
    for (const row of rows) {
      select.add(new Option('#' + row.id + ' · ' + row.model + ' · ' + row.text.slice(0, 48), row.id));
    }
    select.value = selected;
    select.onchange = async () => {
      const id = select.value;
      get('media-result-' + slot).replaceChildren();
      if (!id) return;
      try {
        const response = await fetch('/media/history/' + id);
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        if (select.value === id) showMediaResult(slot, { ...result, replay: true });
      } catch (error) {
        get('media-status').textContent = error.message;
      }
    };
    if (slot === 'a' && latest) showMediaResult(slot, latest);
  }
}
get('media-form').onsubmit = async (event) => {
  event.preventDefault();
  const submittedPage = mediaPage();
  const status = get('media-status');
  const button = get('media-submit');
  const replayButton = get('media-replay');
  const replay = event.submitter === replayButton;
  const source = mediaSource.value;
  const runpodMusic = source.startsWith('runpod-');
  const external = source.startsWith('eleven-');
  const allowPaid = get('media-paid').checked;
  const activity = get('media-activity');
  activity.replaceChildren();
  const setupError = source === 'local-video' ? mediaConfig.videoSetup
    : source === 'local-music' ? mediaConfig.musicSetup : null;
  if (setupError) {
    status.textContent = setupError;
    return;
  }
  if (runpodMusic) {
    if (replay || !mediaConfig.runpod || !get('media-text').value.trim()) {
      status.textContent = replay ? 'Choose the saved Runpod clip in Results A or B to replay it.'
        : 'Configure Runpod and enter a music prompt.';
      return;
    }
    if (!confirm('Generate up to ' + get('media-music-duration').value + ' seconds with HeartMuLa 3B on one paid Runpod Pod? Quoted ceiling $0.65/hour. Local deadline 20 minutes.')) return;
  }
  if (!replay && external && (!mediaConfig.elevenlabs || !allowPaid)) {
    status.textContent = 'Configure the key and authorize this individual external request.';
    return;
  }
  button.disabled = true;
  replayButton.disabled = true;
  get('media-paid').checked = false;
  const header = get('media-workload-status');
  const start = performance.now();
  let stage = replay ? 'Looking for a saved match' : 'Preparing media request';
  const showProgress = () => {
    const elapsed = Math.floor((performance.now() - start) / 1000);
    header.textContent = status.textContent = stage + ' · ' + elapsed + 's elapsed';
  };
  const record = (message) => {
    const entry = document.createElement('li');
    entry.textContent = Math.floor((performance.now() - start) / 1000) + 's · ' + message;
    activity.append(entry);
  };
  header.hidden = false;
  showProgress();
  const timer = setInterval(showProgress, 1000);
  try {
    if (runpodMusic) {
      const run = await runRemoteComparison({ action: 'music' },
        { prompt: get('media-text').value.trim(), batch: crypto.randomUUID(),
          variant: '3b', lyrics: get('media-lyrics').value.trim(),
          duration: Number(get('media-music-duration').value) }, next => {
          if (next === stage) return;
          stage = next;
          record(stage);
          showProgress();
        });
      const result = await readComparisonJson('/media/history/' + run.mediaId);
      clearInterval(timer);
      if (mediaPage() === submittedPage) showMediaResult('a', result);
      status.textContent = 'Saved run #' + result.id + ' · Pod cleanup complete.';
      record(status.textContent);
      await loadMediaHistory(result);
      return;
    }
    const response = await fetch('/media/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, allowPaid, replay, text: get('media-text').value, voice: get('media-voice').value.trim() }),
    });
    if (!response.ok) throw new Error(await response.text());
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    let result;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = (pending + value).split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(message.error);
          if (message.stage) {
            stage = message.stage;
            record(stage);
            showProgress();
          }
          if (message.result) result = message.result;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!result) throw new Error('The media connection closed before a result arrived.');
    clearInterval(timer);
    if (mediaPage() === submittedPage) showMediaResult('a', result);
    status.textContent = (replay ? 'Replaying run #' : 'Saved run #') + result.id + '.';
    record(status.textContent);
    try {
      await loadMediaHistory(result);
    } catch (error) {
      record('Could not refresh the history list. ' + error.message);
    }
  } catch (error) {
    status.textContent = error.message + (external && !replay ? ' Check provider usage before submitting again.' : '');
    record(status.textContent);
  } finally {
    clearInterval(timer);
    header.hidden = true;
    button.disabled = false;
    replayButton.disabled = false;
    if (external && !replay) refreshMediaQuota();
  }
};
window.addEventListener('hashchange', openMedia);
openMedia();

let stopImageBatch = false;
get('stop-work').onclick = async () => {
  stopImageBatch = true;
  try {
    const response = await fetch('/stop', { method: 'POST' });
    get('workload-status').textContent = await response.text();
  } catch (error) {
    get('workload-status').textContent = error.message;
  }
};

function samples(container, field, entries, onSelect) {
  for (const [label, prompt, companionText] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline btn-sm';
    button.textContent = label;
    button.onclick = () => {
      const input = get(field);
      if (input.disabled) return;
      input.value = prompt;
      if (onSelect) onSelect(companionText);
      input.focus();
    };
    get(container).append(button);
  }
}
let selectedHeartMuLaSong;
let lastPresetLyrics;
function fillHeartMuLaLyrics(song) {
  const [verse, chorus, secondVerse, bridge, outro] = song.split('\n\n');
  const duration = Number(get('media-music-duration').value);
  const sections = [verse, chorus];
  if (duration >= 60) sections.push(secondVerse, chorus);
  if (duration >= 90) sections.push(bridge, chorus);
  if (duration >= 120) sections.push(outro, chorus);
  selectedHeartMuLaSong = song;
  lastPresetLyrics = sections.join('\n\n');
  get('media-lyrics').value = lastPresetLyrics;
}
get('media-music-duration').onchange = () => {
  if (selectedHeartMuLaSong && get('media-lyrics').value === lastPresetLyrics) {
    fillHeartMuLaLyrics(selectedHeartMuLaSong);
  }
};
samples('media-style-samples', 'media-text', [
  ['Storybook waltz', 'english vocals,whimsical,cozy fantasy,playful waltz,celesta,pizzicato strings,bassoon,warm',
    `[Verse]
Crystal ties her hair up tight
Apron pockets dusted white
Jazzy circles by the door
While she kneads a little more

[Chorus]
One, two, three around the floor
Mind your tail beside the door
Let the kettle keep the time
While the kitchen candles shine

[Verse]
Silver crescent catches light
David brings the kindling in
Crystal clears a place to sit
Jazzy gives the broom a spin

[Bridge]
When the fire settles low
Let the spoons and saucers slow
Then a kettle starts to sing
And the dancers form a ring

[Outro]
Set the broom beside the wall
Take a bow before we fall`],
  ['Porch folk', 'english vocals,acoustic folk,fingerpicked guitar,fiddle,mandolin,hand percussion,cozy,morning',
    `[Verse]
Crystal carries coffee to the porch at break of day
Jazzy checks the garden where the Root got in the way
David brings a hinge to set the garden gate aright
Crystal fetches tools before the dew has dried in light

[Chorus]
Take a little time to sit
Watch the sunlight move a bit
Pass the berries, pour the brew
There's a chair out here for you

[Verse]
Crystal breaks a biscuit into pieces for the plate
Jazzy drops the feather at the bottom of the gate
David sets the hinge and gives the gate a gentle swing
Crystal tops his coffee off and hears the blackbirds sing

[Bridge]
Let the village hurry by
We've a patch of morning sky
And a song the fiddle knows
Where the garden rosemary grows

[Outro]
Leave the porch light off today
We've got sun enough to stay`],
  ['Cottage jazz', 'english vocals,cafe jazz,brush drums,upright bass,muted trumpet,soft piano,playful,swing',
    `[Verse]
Eddie sets the coffee down
Jazzy makes the breakfast rounds
Crystal warms her hands around
A cup as rain taps on the town

[Chorus]
Coffee first, then cast your spell
Let the kettle ring its bell
Jazzy taps a little swing
Eddie lets the teaspoon ring

[Verse]
Crystal deals three saucers out
Jazzy turns the beat about
Eddie sets a pastry down
And the rain keeps time around

[Bridge]
Brush the drum and walk the bass
Leave a little empty space
Then let Crystal count us in
With a wink above her grin

[Outro]
One last sip before we go
Take the ending nice and slow`],
  ['Moonlit lullaby', 'english vocals,lullaby,slow,harp,music box,soft strings,intimate,moonlit,dreamy',
    `[Verse]
Crystal folds her cardigan
Jazzy curls up by the chair
Crystal draws the cottage curtains
Moonlight lingers on the stair

[Chorus]
Sleep till morning finds the sill
Till the cups and clocks are still
Leave one lantern glowing low
For the moths with miles to go

[Verse]
Crystal leaves a book half read
Jazzy dreams beside the bed
Embers settle in the grate
Stars shine past the garden gate

[Bridge]
If the wind should shake the eaves
Listen for the falling leaves
Even when the rafters creak
Morning's only half asleep

[Outro]
Close your eyes and count to three
Night has room for you and me`],
  ['Little parade', 'english vocals,storybook march,clarinet,piccolo,pizzicato strings,light snare,mischievous,bright',
    `[Verse]
Marge looks down her clipboard list
Jazzy sniffs a pumpkin twist
Crystal finds the Root beneath
Looped around a harvest wreath

[Chorus]
Round the rosemary, past the gate
Keep your feet in time, don't wait
Jazzy leads us down the lane
Then we turn and march again

[Verse]
Crystal brings the broom along
Jazzy barks between the songs
David frees the wheelbarrow
Lucy finds the path is narrow

[Bridge]
Hush the drum beside the pond
Let the sleepy frogs respond
Then the clarinet will play
As we march the other way

[Outro]
Hang the drum beside the door
Tomorrow we can march once more`],
], fillHeartMuLaLyrics);

samples('chat-samples', 'chat-prompt', [
  ['DaytonWitch scene', 'Write an 80-word draft scene set at Crystal Rowan’s cottage outside Dayton, Ohio. Crystal, wearing red-framed glasses and a silver crescent necklace, finds the harmless Undefeated Root has tangled a garden gate. David offers to help and Jazzy takes the Root’s return personally. Let ordinary repair work lead, keep the humor gentle, and end on dialogue.'],
  ['Continuity check', 'Reference facts. Crystal Rowan wears red-framed glasses and usually ties her straight medium-brown hair in a low ponytail. Her signature necklace is a silver crescent. Draft sentence. Crystal adjusts her blue frames, ties back her black curls, and straightens her gold sun pendant. List exactly three continuity errors, treating hair color and texture as one error, then rewrite the sentence.'],
  ['Music brief', 'Write a five-line instrumental brief for a draft Witch of Dayton lantern walk scene. The harmless Root tangles the decorations, Jazzy investigates, and Crystal and David help their neighbors untangle the display. Specify mood, instruments, rhythm, a recurring motif, and an ending. Keep the comedy gentle and leave room for dialogue.'],
  ['Tiny story', 'Write a three-sentence story about a robot that finds a lost houseplant.'],
  ['Rewrite', 'Rewrite this to sound warm and casual: Your presence is requested at the gathering on Friday.'],
  ['Easy explanation', 'Explain why the Moon changes shape in the sky in three short sentences.'],
  ['Brainstorm', 'Suggest five names for a tiny bookshop that stays open after midnight.']
]);
const daytonImageSamples = [
  ['Crystal Rowan', 'dwstorybook full-body illustration of dwcrystal, Crystal Rowan, a short plus-size cottage witch with blue eyes, red-framed glasses and straight medium-brown hair in a low ponytail. Black knee-length dress with deep red plaid, cozy cardigan, silver crescent moon necklace and black leather work boots. Dayton cottage garden, realistic cozy Midwest fantasy, no lettering.'],
  ['Lantern walk', 'dwstorybook illustration of dwcrystal in red-framed glasses, straight brown ponytail, silver crescent necklace and a black dress with deep red plaid, helping David Bennett untangle lanterns from a natural mossy root. dwjazzy investigates. Warm Midwestern community festival, gentle humor, unlettered.'],
  ['Root and wheelbarrow', 'dwstorybook illustration of dwjazzy investigating the Undefeated Root, an organic mossy root wrapped around a wheelbarrow in a Dayton garden. Bark texture, pumpkins, warm autumn light, harmless mischief, no eyes or teeth on the root, no lettering.'],
];
samples('image-samples', 'image-prompt', [
  ...daytonImageSamples,
  ['Watercolor fox', 'Watercolor illustration of a red fox in an autumn forest, warm orange leaves'],
  ['Moonlit library', 'Cozy old library at midnight, moonlight through tall arched windows, oil painting'],
  ['Robot gardener', 'A tiny round robot watering a houseplant, pastel clay illustration, simple background'],
  ['Retro postcard', 'Retro travel postcard of a mountain lake, pine trees, pink sunset, screen print']
]);

const storageKey = 'npu-lab-rooms-v1';
let rooms;
try {
  rooms = JSON.parse(localStorage.getItem(storageKey));
} catch {
  rooms = null;
}
if (!Array.isArray(rooms) || !rooms.length) rooms = [{ title: 'Room 1', messages: [] }];
let currentRoom = 0;
let generationBusy = false;

function addMessage(label, content, metrics) {
  const entry = document.createElement('div');
  const name = document.createElement('strong');
  const body = document.createElement('pre');
  name.textContent = label;
  body.textContent = content;
  entry.append(name, body);
  if (metrics) {
    const detail = document.createElement('small');
    detail.textContent = metrics;
    entry.append(detail);
  }
  get('conversation').append(entry);
  return body;
}

function renderRooms() {
  get('rooms').replaceChildren();
  rooms.forEach((room, index) => {
    const button = document.createElement('button');
    button.className = 'btn btn-outline btn-sm';
    button.textContent = room.title;
    button.setAttribute('aria-current', String(index === currentRoom));
    button.onclick = () => {
      if (generationBusy) return;
      currentRoom = index;
      get('chat-status').textContent = 'Ready';
      renderRooms();
    };
    get('rooms').append(button);
  });
  get('conversation').replaceChildren();
  for (const message of rooms[currentRoom].messages) {
    addMessage(message.role === 'user' ? 'You' : message.label || 'Qwen', message.content, message.metrics);
  }
}

function saveRooms() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(rooms));
  } catch {
    get('chat-status').textContent += ' · Room history could not be saved.';
  }
}
get('new-room').onclick = () => {
  if (generationBusy) return;
  rooms.push({ title: 'Room ' + (rooms.length + 1), messages: [] });
  currentRoom = rooms.length - 1;
  get('chat-status').textContent = 'Ready';
  saveRooms();
  renderRooms();
};
renderRooms();

async function generate(kind, device, request, onDelta = () => {}) {
  const response = await fetch('/generate/' + kind + '/' + device, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(await response.text());
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let result;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const lines = (pending + chunk.value).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('E')) throw new Error(line.slice(1));
        if (line.startsWith('D')) {
          const event = JSON.parse(line.slice(1));
          if (typeof event.delta === 'string') onDelta(event.delta);
          else result = event;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  if (!result) throw new Error('The generation connection closed before a result arrived.');
  return result;
}

function generationTiming(result) {
  return result.device + ' requested · setup ' + result.setupSeconds.toFixed(2) +
    ' s · generation ' + result.runSeconds.toFixed(2) + ' s';
}

async function loadChatModels() {
  try {
    const models = await readComparisonJson('/chat/models');
    const picker = get('chat-model');
    const selected = picker.value;
    picker.replaceChildren(...models.map(model => {
      const option = new Option(model.label + (model.installed ? '' : ' · setup needed'), model.id);
      option.disabled = !model.installed;
      return option;
    }));
    if ([...picker.options].some(option => option.value === selected && !option.disabled)) picker.value = selected;
    else picker.selectedIndex = [...picker.options].findIndex(option => !option.disabled);
    get('chat-model-setup').textContent = models.some(model => !model.installed)
      ? 'Install Qwen2.5 7B with setup-chat.ps1, then refresh this page.' : '';
  } catch (error) {
    get('chat-model-setup').textContent = error.message;
  }
}
loadChatModels();

function setChatMode(compare) {
  get('chat-mode-chat').setAttribute('aria-pressed', String(!compare));
  get('chat-mode-compare').setAttribute('aria-pressed', String(compare));
  get('conversation').hidden = compare;
  get('chat-send').hidden = compare;
  get('chat-compare-controls').hidden = !compare;
  get('chat-comparison').hidden = !compare;
}
get('chat-mode-chat').onclick = () => setChatMode(false);
get('chat-mode-compare').onclick = () => setChatMode(true);

function addChatComparisonRow(label, paid) {
  const rows = get('chat-comparison-rows');
  const reader = get('chat-comparison-reader');
  const row = rows.insertRow();
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'btn btn-ghost btn-xs';
  pick.textContent = 'Read';
  pick.setAttribute('aria-label', 'Read ' + label);
  pick.setAttribute('aria-pressed', 'false');
  row.insertCell().append(pick);
  row.insertCell().textContent = label;
  const status = row.insertCell();
  status.textContent = 'Queued';
  const time = row.insertCell();
  const tokens = row.insertCell();
  const cost = row.insertCell();
  cost.textContent = paid ? 'Pending' : 'Local';
  const rating = document.createElement('select');
  rating.className = 'select select-xs';
  rating.setAttribute('aria-label', 'Rate ' + label);
  rating.append(new Option('—', ''), ...[1, 2, 3, 4, 5].map(value => new Option(value + '/5', value)));
  rating.disabled = true;
  row.insertCell().append(rating);
  const card = document.createElement('article');
  card.className = 'panel card bg-base-200 border border-base-300';
  const title = document.createElement('h3');
  title.textContent = label;
  const reply = document.createElement('pre');
  card.append(title, reply);
  pick.onclick = () => {
    if (card.isConnected) {
      card.remove();
      pick.setAttribute('aria-pressed', 'false');
      return;
    }
    if (reader.childElementCount === 2) {
      rows.querySelector('[aria-pressed=true]').click();
    }
    reader.append(card);
    pick.setAttribute('aria-pressed', 'true');
  };
  if (reader.childElementCount < 2) pick.click();
  return { status, time, tokens, cost, rating, reply };
}

async function compareChatModels({ remote, remoteModels, includeLocal, modelPicker, model, user, device, tokens }) {
  const status = get('chat-status');
  if (remote && !remoteModels.length) throw new Error('Select at least one Runpod chat model.');
  if (remote && !confirm('Run ' + remoteModels.length + ' paid chat jobs, one Pod at a time? ' +
    'Each has a $0.65/hour quoted ceiling and 20-minute local Pod deadline. The current prompt is sent to Runpod.')) {
    status.textContent = 'Comparison cancelled.';
    return;
  }
  const local = [...modelPicker.options].filter(option => !option.disabled && (!remote || (includeLocal && option.value === model)))
    .map(option => ({ label: option.textContent + ' · ' + device, model: option.value }));
  const targets = remote ? [...local, ...remoteModels.map(variant => ({
    label: 'Qwen2.5 ' + variant.toUpperCase() + ' · Runpod', variant,
  }))] : local;
  get('chat-comparison-prompt').textContent = user.content;
  get('chat-comparison-rows').replaceChildren();
  get('chat-comparison-reader').replaceChildren();
  const results = targets.map(target => ({ target, ...addChatComparisonRow(target.label, !!target.variant) }));
  let halted = false;
  for (const entry of results) {
    const { target, reply, time, cost, rating } = entry;
    if (stopImageBatch || halted) {
      entry.status.textContent = 'Skipped';
      continue;
    }
    const stage = text => {
      entry.status.textContent = text;
      status.textContent = target.label + ' · ' + text;
    };
    try {
      if (target.variant) {
        const run = await runRemoteComparison({ action: 'chat' },
          { prompt: user.content, tokens, batch: crypto.randomUUID(), variant: target.variant }, stage);
        reply.textContent = run.chatReply;
        time.textContent = run.runSeconds.toFixed(1) + ' s';
        entry.tokens.textContent = run.outputTokens;
        const billed = runpodBilling?.charges?.[run.pod]?.usd;
        cost.textContent = billed != null ? usd(billed) : run.rate && run.deletedAt && run.podCreated
          ? usd(run.rate * (run.deletedAt - run.podCreated) / 3600) + ' est.' : 'Unavailable';
      } else {
        stage('Generating');
        const result = await generate('chat', device, { messages: [user], tokens, model: target.model },
          delta => { reply.textContent += delta; });
        reply.textContent = result.text;
        time.textContent = result.runSeconds.toFixed(1) + ' s';
        entry.tokens.textContent = result.tokens;
      }
      entry.status.textContent = 'Complete';
      rating.disabled = false;
    } catch (error) {
      entry.status.textContent = stopImageBatch ? 'Stopped' : 'Failed';
      reply.textContent = error.message;
      if (target.variant) {
        cost.textContent = 'See Runpod';
        halted = true;
      }
    }
  }
  status.textContent = stopImageBatch ? 'Comparison stopped.' : halted ? 'Paid queue ended after an error.' : 'Comparison finished.';
}

get('chat-form').onsubmit = event => {
  event.preventDefault();
  if (generationBusy) return;
  const prompt = get('chat-prompt');
  const content = prompt.value.trim();
  if (!content) return;
  const device = get('chat-device').value;
  const tokens = get('chat-tokens').valueAsNumber;
  const modelPicker = get('chat-model');
  const model = modelPicker.value;
  const remote = event.submitter?.value === 'remote';
  const includeLocal = get('chat-local-reference').checked;
  const remoteModels = [...event.currentTarget.querySelectorAll('[name="chat-remote"]:checked')].map(input => input.value);
  if (!model && (!remote || includeLocal)) {
    get('chat-status').textContent = 'Install a chat model first.';
    return;
  }
  const room = rooms[currentRoom];
  const user = { role: 'user', content };
  const messages = [...room.messages.slice(-12), user].map(({ role, content }) => ({ role, content }));
  generationBusy = true;
  stopImageBatch = false;
  withBusy(event.currentTarget, get('chat-status'), 'Starting local chat…', async () => {
    if (remote || event.submitter?.value === 'compare') {
      await compareChatModels({ remote, remoteModels, includeLocal, modelPicker, model, user, device, tokens });
      return;
    }
    const question = addMessage('You', content);
    const label = modelPicker.selectedOptions[0].textContent + ' · ' + device;
    const reply = addMessage(label, '');
    try {
      const result = await generate('chat', device, { messages, tokens, model }, delta => {
        reply.textContent += delta;
        const conversation = get('conversation');
        conversation.scrollTop = conversation.scrollHeight;
      });
      reply.textContent = result.text;
      const metrics = generationTiming(result) + ' · ' + result.tokens + ' tokens';
      room.messages = [...room.messages.slice(-98), user, { role: 'assistant', content: result.text, label, metrics }];
      prompt.value = '';
      get('chat-status').textContent = metrics;
      renderRooms();
      saveRooms();
    } catch (error) {
      if (reply.textContent) reply.textContent += '\n[Interrupted]';
      else {
        question.parentElement.remove();
        reply.parentElement.remove();
      }
      throw error;
    }
  }).finally(() => { generationBusy = false; });
};

let referenceData = '';
const referenceResults = get('reference-results');
const referenceCards = new Map();
function referenceCard(label, description, uri) {
  let card = referenceCards.get(label);
  if (!card) {
    card = document.createElement('article');
    referenceCards.set(label, card);
    referenceResults.append(card);
  }
  const title = document.createElement('h3');
  title.textContent = label;
  const detail = document.createElement('p');
  detail.textContent = description;
  card.replaceChildren(title, detail);
  if (uri) {
    const image = document.createElement('img');
    image.src = uri;
    image.alt = label;
    image.width = 256;
    image.height = 256;
    image.style.cssText = 'max-width:100%;height:auto;display:block';
    card.append(image);
    if (label !== 'Reference') {
      const save = document.createElement('a');
      save.href = uri;
      save.download = 'reference-' + label.toLowerCase() + '.png';
      save.textContent = 'Save PNG';
      card.append(save);
    }
  }
}

function resetReferenceResults() {
  referenceCards.clear();
  referenceResults.replaceChildren();
  referenceResults.hidden = !referenceData;
  if (referenceData) referenceCard('Reference', '256 × 256 input used by the model', referenceData);
}

get('image-reference').onchange = async event => {
  const file = event.target.files[0];
  referenceData = '';
  get('image-strength-control').hidden = true;
  get('image-device').options[2].disabled = true;
  if (get('image-device').value === 'NPU') get('image-device').value = 'CPU';
  resetReferenceResults();
  if (!file) return;
  const submit = get('image-form').querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image under 20 MB.');
    const bitmap = await createImageBitmap(file);
    try {
      if (event.target.files[0] !== file) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d', { alpha: false });
      const scale = 256 / Math.max(bitmap.width, bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
      referenceData = canvas.toDataURL('image/jpeg', 0.9);
    } finally {
      bitmap.close();
    }
    get('image-strength-control').hidden = false;
    get('image-device').options[2].disabled = false;
    get('image-status').textContent = 'Reference ready.';
    get('generated-image').hidden = get('image-download').hidden = true;
    resetReferenceResults();
  } catch (error) {
    get('image-status').textContent = error.message;
    event.target.value = '';
  } finally {
    submit.disabled = false;
  }
};

let referenceSettings = '';

get('image-form').onsubmit = event => {
  event.preventDefault();
  if (generationBusy) return;
  const prompt = get('image-prompt').value.trim();
  const status = get('image-status');
  if (!prompt && !referenceData) {
    status.textContent = 'Enter a prompt or choose a reference image.';
    return;
  }
  const all = event.submitter?.value === 'all';
  const adapter = event.submitter?.value === 'batch' || all ? null :
    runpodRuns.find(run => 'lora:' + run.run === get('image-device').value && run.artifacts && run.resultId);
  if (adapter && (referenceData || !prompt)) {
    status.textContent = 'Saved LoRAs accept a positive text prompt. Remove the reference image to run this comparison.';
    return;
  }
  const batch = all || event.submitter?.value === 'batch';
  const targets = batch
    ? [...get('batch-targets').querySelectorAll('input:checked')].map(input => input.value)
      .filter(device => device !== 'NPU' || referenceData)
    : adapter ? [] : [get('image-device').value];
  if (!all && !adapter && !targets.length) {
    status.textContent = 'Select at least one compatible target.';
    return;
  }
  const request = { prompt, negativePrompt: get('image-negative-prompt').value.trim(),
    seed: get('image-seed').valueAsNumber, steps: get('image-steps').valueAsNumber };
  const kind = referenceData ? 'reference' : 'image';
  if (referenceData) {
    request.reference = referenceData.split(',')[1];
    request.strength = get('image-strength').valueAsNumber;
  }
  const settings = JSON.stringify(request);
  if (settings !== referenceSettings || batch) resetReferenceResults();
  referenceSettings = settings;
  if (batch || adapter) request.batch = crypto.randomUUID();
  referenceResults.hidden = false;
  get('generated-image').hidden = get('image-download').hidden = true;
  generationBusy = true;
  stopImageBatch = false;
  withBusy(event.currentTarget, status, 'Starting image run…', async () => {
    const paid = [];
    if (adapter) {
      if (!confirm('Run base SDXL and both saved checkpoints on one paid Runpod Pod? Quoted ceiling $0.65/hour. Local deadline 20 minutes.')) return;
      paid.push({ label: adapter.model + ' · #' + adapter.resultId, action: 'eval', run: adapter.run });
    }
    if (all) {
      const availability = await readComparisonJson('/image/availability');
      targets.splice(0, targets.length);
      if (availability.local && (!referenceData || availability.reference)) {
        targets.push('CPU', 'GPU');
        if (referenceData) targets.push('NPU');
      } else referenceCard('OpenVINO · SD 1.5', 'Skipped · compatible local checkpoint files are missing.');
      if (get('image-include-runpod').checked) {
        if (referenceData) referenceCard('Runpod', 'Skipped · this adapter comparison accepts text prompts.');
        else if (!availability.runpod) referenceCard('Runpod', 'Skipped · Runpod keys are missing.');
        else {
          const job = await readComparisonJson('/runpod/job');
          if (job.running || job.pending) referenceCard('Runpod', 'Skipped · another job or cleanup is pending.');
          else {
            if (request.negativePrompt) referenceCard('Runpod · SDXL Turbo', 'Skipped · this model does not support negative prompts.');
            else paid.push({ label: 'Runpod · SDXL Turbo', action: 'start' });
            for (const run of (job.runs || []).filter(run => run.artifacts && run.resultId)) {
              paid.push({ label: 'Runpod · ' + run.model + ' · #' + run.resultId, action: 'eval', run: run.run });
            }
            if (paid.length && (stopImageBatch || !confirm('Run ' + paid.length + ' paid Runpod jobs, one Pod at a time? ' +
              'Each is capped at $0.65/hour with a 20-minute local Pod deadline. ' +
              'Combined estimate at those limits: $' + (paid.length * 0.65 / 3).toFixed(2) +
              ' before any cleanup delay. Runpod receives the prompts and selected adapters.'))) {
              paid.length = 0;
            }
          }
        }
      }
    }
    const total = targets.length + paid.length;
    if (!total) {
      status.textContent = 'No compatible targets selected or configured.';
      return;
    }
    let failed = 0;
    let finished = 0;
    for (const device of targets) {
      if (stopImageBatch) break;
      const label = device;
      status.textContent = device + ' active' +
        ' · ' + (finished + 1) + ' / ' + total;
      referenceCard(label, 'Running…');
      try {
        const result = await generate(kind, device, request);
        let detail = generationTiming(result);
        if (Number.isFinite(result.rgbDifference)) detail += ' · RGB difference ' + result.rgbDifference.toFixed(1) + '%';
        referenceCard(label, detail, 'data:image/png;base64,' + result.png);
      } catch (error) {
        failed++;
        referenceCard(label, error.message);
      }
      finished++;
    }
    for (const target of paid) {
      if (stopImageBatch) break;
      status.textContent = target.label + ' · ' + (finished + 1) + ' / ' + total;
      try {
        await runPaidComparison(target, request);
        finished++;
      } catch (error) {
        failed++;
        finished++;
        referenceCard(target.label, error.message);
        break;
      }
    }
    status.textContent = (stopImageBatch ? 'Stopped. ' : '') + finished + ' of ' + total +
      ' finished' + (failed ? ' · ' + failed + ' failed or stopped' : '') + '.';
    await loadHistory();
  }).finally(() => {
    generationBusy = false;
  });
};

async function readComparisonJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function runPaidComparison(target, request) {
  const run = await runRemoteComparison(target, request, stage => referenceCard(target.label, stage));
  const saved = await readComparisonJson('/history/' + run.resultId);
  const estimate = run.rate && run.deletedAt && run.podCreated
    ? ' · estimated $' + (run.rate * (run.deletedAt - run.podCreated) / 3600).toFixed(4) : '';
  referenceCard(target.label, 'Run #' + run.resultId + ' · ' + generationTiming(saved.result) +
    ' · ' + saved.request.steps + ' steps' + estimate, 'data:image/png;base64,' + saved.result.png);
}

async function runRemoteComparison(target, request, onStage) {
  onStage('Requesting a Pod…');
  const response = await fetch('/runpod/job/' + target.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: request.prompt, negativePrompt: request.negativePrompt,
      seed: request.seed, batch: request.batch, run: target.run, variant: request.variant,
      lyrics: request.lyrics, duration: request.duration, tokens: request.tokens }),
  });
  if (!response.ok) throw new Error(await response.text());
  while (true) {
    const job = await readComparisonJson('/runpod/job');
    const run = [job.state, ...(job.runs || [])].find(run =>
      run?.batch === request.batch && run.parentRun === target.run);
    if (run) {
      const progress = run.uploadBytes ? ' · ' + Math.round(100 * run.uploadedBytes / run.uploadBytes) + '% uploaded' : '';
      onStage(run.phase + progress);
    }
    if (!job.running) {
      if (job.pending || run?.phase !== 'Complete' || !(run.resultId || run.mediaId || run.chatReply)) {
        throw new Error(run?.error || (job.pending ? 'Pod cleanup is pending.' : 'Runpod finished without a result.'));
      }
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
}

let savedRuns = [];
function renderHistory() {
  const filter = get('history-filter').value.trim().toLowerCase();
  const list = get('history-list');
  list.replaceChildren();
  for (const run of savedRuns.filter(run => [run.prompt, run.model, run.device, run.batch, run.status]
    .some(value => String(value ?? '').toLowerCase().includes(filter)))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-sm';
    button.textContent = selectedRuns.has(run.id) ? 'Remove' : 'Compare';
    button.setAttribute('aria-label', 'Compare saved image #' + run.id);
    button.setAttribute('aria-pressed', String(selectedRuns.has(run.id)));
    button.onclick = () => compareSaved(run.id);
    const row = list.insertRow();
    row.onclick = event => {
      if (!event.target.closest('button')) previewSaved(run.id);
    };
    row.insertCell().textContent = '#' + run.id;
    const description = row.insertCell();
    description.textContent = (run.prompt || 'Reference reconstruction') + ' · ' + run.model;
    description.title = run.created + ' UTC';
    row.insertCell().textContent = run.device;
    row.insertCell().textContent = run.status;
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn btn-primary btn-sm';
    view.textContent = 'View';
    view.setAttribute('aria-label', 'View saved result #' + run.id);
    view.onclick = () => previewSaved(run.id);
    row.insertCell().append(view, button);
  }
}

async function loadHistory() {
  try {
    const response = await fetch('/history');
    if (!response.ok) throw new Error(await response.text());
    savedRuns = await response.json();
    renderHistory();
    get('history-status').textContent = savedRuns.length
      ? 'Click a row to view its result, or use Compare to keep it side by side.'
      : 'Saved runs will appear here.';
  } catch (error) {
    get('history-status').textContent = error.message;
  }
}

const selectedRuns = new Map();
function previewSaved(id) {
  const dialog = get('history-preview');
  const card = document.createElement('article');
  get('history-preview-content').replaceChildren(card);
  if (!dialog.open) dialog.showModal();
  loadSavedResult(id, card);
}

async function compareSaved(id) {
  if (selectedRuns.has(id)) {
    selectedRuns.get(id).remove();
    selectedRuns.delete(id);
    renderHistory();
    return;
  }
  const card = document.createElement('article');
  selectedRuns.set(id, card);
  renderHistory();
  get('history-comparison').append(card);
  await loadSavedResult(id, card);
}

async function loadSavedResult(id, card) {
  card.textContent = 'Loading run #' + id + '…';
  try {
    const response = await fetch('/history/' + id);
    if (!response.ok) throw new Error(await response.text());
    const run = await response.json();
    const title = document.createElement('h3');
    title.textContent = '#' + id + ' · ' + run.device + ' · ' + run.model;
    const settings = document.createElement('p');
    settings.textContent = (run.request.prompt || 'Reference reconstruction') +
      ' · seed ' + run.request.seed + ' · steps ' + run.request.steps +
      (run.request.strength == null ? '' : ' · strength ' + run.request.strength);
    if (run.request.negativePrompt) settings.textContent += ' · Negative prompt: ' + run.request.negativePrompt;
    const detail = document.createElement('p');
    detail.textContent = run.error || (run.result ? generationTiming(run.result) : 'Run incomplete.');
    if (Number.isFinite(run.result?.rgbDifference)) detail.textContent += ' · RGB difference ' + run.result.rgbDifference.toFixed(1) + '%';
    card.replaceChildren(title, settings, detail);
    for (const [data, format, label] of [[run.request.reference, 'jpeg', 'Reference'], [run.result?.png, 'png', 'Output']]) {
      if (!data) continue;
      const image = document.createElement('img');
      image.src = 'data:image/' + format + ';base64,' + data;
      image.alt = label;
      image.style.cssText = 'max-width:100%;height:auto;display:block';
      card.append(image);
      if (label === 'Output') {
        const save = document.createElement('a');
        save.href = image.src;
        save.download = 'renderledger-run-' + id + '.png';
        save.textContent = 'Save PNG';
        card.append(save);
      }
    }
  } catch (error) {
    card.textContent = error.message;
  }
}
get('history-filter').oninput = renderHistory;
get('history-refresh').onclick = loadHistory;
window.addEventListener('hashchange', () => {
  if (location.hash === '#images') loadHistory();
});
if (location.hash === '#images') loadHistory();


let lastRunpodOffer = '';
let runpodRefreshPending = false;
let runpodTimelineKey = '';
function renderRunpodTimeline(watch) {
  const clock = Math.floor(Date.now() / 1000);
  const elapsed = watch.started ? Math.max(0, (watch.ended ?? clock) - watch.started) : 0;
  get('runpod-progress').value = elapsed;
  const next = watch.next ? ' · Next check in ' + Math.max(0, watch.next - clock) + ' s' : '';
  get('runpod-summary').textContent = watch.checks + ' checks · ' + watch.errors + ' errors · ' +
    Math.floor(elapsed / 60) + 'm ' + elapsed % 60 + 's elapsed' + next;
  const key = JSON.stringify(watch.events);
  if (key === runpodTimelineKey) return;
  runpodTimelineKey = key;
  const openChecks = new Set([...get('runpod-timeline').querySelectorAll('details[open]')]
    .map(detail => detail.dataset.check));
  const entries = [...watch.events].reverse().map(event => {
    const entry = document.createElement('li');
    entry.className = 'rounded-box bg-base-300 p-3';
    const label = '#' + event.check + ' · ' + new Date(event.time * 1000).toLocaleTimeString() +
      ' · ' + event.elapsed + ' ms';
    const badge = document.createElement('span');
    badge.className = event.error ? 'badge badge-error badge-soft' : 'badge badge-info badge-soft';
    badge.textContent = event.error ? 'Error' : event.gpu ? 'Offer found' : 'No eligible offer';
    if (event.error) {
      const details = document.createElement('details');
      details.className = 'mt-0';
      details.dataset.check = event.check;
      details.open = openChecks.has(details.dataset.check);
      const summary = document.createElement('summary');
      summary.append(badge, ' ' + label);
      const message = document.createElement('p');
      message.className = 'mt-2 break-words';
      message.textContent = event.error;
      details.append(summary, message);
      entry.append(details);
    } else {
      const detail = event.rows + ' GPU types scanned' +
        (event.gpu ? ' · ' + event.gpu.name + ' at $' + event.gpu.rate.toFixed(3) + '/hr' : '');
      entry.append(badge, ' ' + label + ' · ' + detail);
    }
    return entry;
  });
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Completed checks will appear here.';
    entries.push(empty);
  }
  get('runpod-timeline').replaceChildren(...entries);
}
async function refreshRunpod() {
  if (runpodRefreshPending) return;
  runpodRefreshPending = true;
  try {
    const response = await fetch('/runpod/status');
    if (!response.ok) throw new Error('Could not read the Runpod watch.');
    const watch = await response.json();
    const { active, last } = watch;
    get('runpod-start').disabled = active;
    get('runpod-stop').disabled = !active;
    get('runpod-status').textContent = watch.phase;
    get('header-watch-activity').textContent = active ? watch.phase : 'Idle';
    renderRunpodTimeline(watch);
    get('runpod-checked').textContent = last ? 'Last checked ' + new Date(last.time * 1000).toLocaleString() : '';
    const gpu = last?.gpu;
    const quote = gpu
      ? gpu.name + ' · ' + gpu.vram + ' GB VRAM · $' + gpu.rate.toFixed(3) + '/hr GPU quote · ' + gpu.stock + ' stock'
      : last?.error || (last ? 'No eligible GPU is currently quoted in stock.' : '');
    get('runpod-quote').textContent = quote;
    const offer = gpu ? gpu.id + ':' + gpu.rate : '';
    if (active && offer && offer !== lastRunpodOffer &&
        'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('Runpod GPU available', { body: quote, tag: 'npu-lab-runpod' });
      } catch {
        get('runpod-notifications').textContent = 'Desktop alerts unavailable. The quote is shown above.';
      }
    }
    lastRunpodOffer = offer;
  } catch (error) {
    get('runpod-status').textContent = error.message;
    get('header-watch-activity').textContent = 'Status unavailable';
  } finally {
    runpodRefreshPending = false;
  }
}
async function controlRunpod(action) {
  try {
    const response = await fetch('/runpod/' + action, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    await refreshRunpod();
  } catch (error) {
    get('runpod-status').textContent = error.message;
  }
}
get('runpod-start').onclick = () => controlRunpod('start');
get('runpod-stop').onclick = () => controlRunpod('stop');
get('runpod-alerts').onclick = async () => {
  const status = get('runpod-notifications');
  try {
    const permission = 'Notification' in window ? await Notification.requestPermission() : 'unavailable';
    status.textContent = permission === 'granted'
      ? 'Browser alerts enabled. Keep this tab open.'
      : 'Desktop notifications are ' + permission + '. The watch still displays updates here.';
    lastRunpodOffer = '';
    await refreshRunpod();
  } catch (error) {
    status.textContent = error.message;
  }
};
window.addEventListener('hashchange', () => {
  if (location.hash === '#runpod') refreshRunpod();
});
setInterval(refreshRunpod, 5000);
refreshRunpod();

let runpodRuns = [];
let runpodBilling;
let runpodBillingPending = false;
let runpodBillingRetryAt = 0;
let lastRunpodJobRunning = false;
let runpodJobRefreshPending = false;
let runpodHistoryKey = '';
const pinnedRunpodResults = new Map();
let selectedRunpodId;
const usd = value => '$' + Number(value).toFixed(4);

let balancePending = false;
let balanceNext = 0;
async function refreshHeaderBalance() {
  if (document.hidden || balancePending || Date.now() < balanceNext) return;
  balancePending = true;
  const balance = get('header-runpod-balance');
  const updated = get('header-runpod-updated');
  try {
    const response = await fetch('/runpod/balance');
    if (!response.ok) throw new Error('Runpod balance unavailable.');
    const data = await response.json();
    const interval = data.jobRunning ? 30000 : 60000;
    balanceNext = Math.max(Date.now() + interval, (data.next || 0) * 1000);
    balance.textContent = data.balance == null ? 'Unavailable' : usd(data.balance);
    const timestamp = data.updated ? new Date(data.updated * 1000).toLocaleTimeString() : '';
    updated.textContent = data.balanceError
      ? (data.retryAfter ? 'Rate limited · refresh paused' : 'Refresh unavailable') + (timestamp ? ' · last ' + timestamp : '')
      : 'Updated ' + timestamp;
    updated.title = data.balanceError || '';
  } catch (error) {
    balanceNext = Date.now() + 60000;
    updated.textContent = error.message;
  } finally {
    balancePending = false;
  }
}
document.addEventListener('visibilitychange', refreshHeaderBalance);
setInterval(refreshHeaderBalance, 5000);
refreshHeaderBalance();

function renderRunpodHistory() {
  const filter = get('runpod-history-filter').value.trim().toLowerCase();
  const sort = get('runpod-history-sort').value;
  const key = JSON.stringify([runpodRuns, runpodBilling, selectedRunpodId, filter, sort, [...pinnedRunpodResults.keys()]]);
  if (key === runpodHistoryKey) return;
  runpodHistoryKey = key;
  const history = get('runpod-job-history');
  history.replaceChildren();
  const inspector = get('runpod-run-detail');
  inspector.replaceChildren();
  const visible = runpodRuns.filter(run =>
    [run.model, run.prompt, run.gpu, run.phase, run.resultId].some(value =>
      String(value ?? '').toLowerCase().includes(filter)));
  const costOf = run => runpodBilling?.charges?.[run.pod]?.usd ??
    (run.rate != null && run.deletedAt && run.podCreated
      ? run.rate * (run.deletedAt - run.podCreated) / 3600 : Infinity);
  if (sort === 'cost') visible.sort((a, b) => costOf(a) - costOf(b));
  if (sort === 'speed') visible.sort((a, b) => (a.runSeconds ?? Infinity) - (b.runSeconds ?? Infinity));
  const selected = visible.find(run => run.run === selectedRunpodId) ?? visible[0];
  const preview = get('runpod-inline-result');
  preview.hidden = !selected?.resultId;
  if (selected?.resultId && preview.dataset.result !== String(selected.resultId)) {
    preview.dataset.result = selected.resultId;
    const result = document.createElement('article');
    preview.replaceChildren(result);
    loadSavedResult(selected.resultId, result);
  }
  if (!selected) inspector.textContent = 'Run details will appear here.';
  for (const run of visible) {
    const charge = runpodBilling?.charges?.[run.pod];
    const estimated = run.rate != null && run.deletedAt && run.podCreated
      ? run.rate * (run.deletedAt - run.podCreated) / 3600 : null;
    const cost = charge ? usd(charge.usd) + ' billed to date' :
      estimated != null ? usd(estimated) + ' estimated · billing pending' : 'Charge unavailable';
    const row = history.insertRow();
    const button = document.createElement('button');
    button.className = 'btn btn-ghost btn-sm';
    button.textContent = new Date(run.started * 1000).toLocaleString();
    button.setAttribute('aria-pressed', String(run === selected));
    button.onclick = () => {
      selectedRunpodId = run.run;
      renderRunpodHistory();
      history.querySelector('[aria-pressed=true]')?.focus();
    };
    const model = document.createElement('small');
    model.textContent = run.model || 'Runpod';
    row.insertCell().append(button, model);
    row.insertCell().textContent = run.device || run.gpu || '—';
    const badge = document.createElement('span');
    badge.className = 'badge badge-soft ' + (run.error ? 'badge-error' : run.phase === 'Complete' ? 'badge-success' : 'badge-info');
    badge.textContent = run.phase;
    row.insertCell().append(badge);
    row.insertCell().textContent = cost;
    const actions = row.insertCell();
    if (run.resultId) {
      actions.append(savedRunButton(run.resultId));
      const pin = document.createElement('button');
      pin.className = 'btn btn-ghost btn-sm';
      pin.textContent = pinnedRunpodResults.has(run.resultId) ? 'Unpin' : 'Compare';
      pin.setAttribute('aria-pressed', String(pinnedRunpodResults.has(run.resultId)));
      pin.onclick = () => {
        if (pinnedRunpodResults.has(run.resultId)) {
          pinnedRunpodResults.get(run.resultId).remove();
          pinnedRunpodResults.delete(run.resultId);
        } else {
          const result = document.createElement('article');
          pinnedRunpodResults.set(run.resultId, result);
          get('runpod-pinned-results').append(result);
          loadSavedResult(run.resultId, result);
        }
        renderRunpodHistory();
      };
      actions.append(pin);
      if (run.artifacts || run.parentRun) {
        const edit = document.createElement('button');
        edit.className = 'btn btn-ghost btn-sm';
        edit.textContent = 'Use in editor';
        edit.onclick = async () => {
          try {
            const saved = await readComparisonJson('/history/' + run.resultId);
            await refreshRunpodJob();
            get('image-device').value = 'lora:' + (run.parentRun || run.run);
            get('image-prompt').value = saved.request.prompt || '';
            get('image-negative-prompt').value = saved.request.negativePrompt || '';
            get('image-seed').value = saved.request.seed ?? 42;
            location.hash = '#images';
          } catch (error) {
            get('runpod-job-error').textContent = error.message;
          }
        };
        actions.append(edit);
      }
    }
    if (run !== selected) continue;
    const card = inspector;
    const title = document.createElement('h3');
    title.textContent = run.model || 'Run details';
    card.append(title);
    const summary = document.createElement('p');
    summary.textContent = [
      run.pod && 'Pod ' + run.pod,
      run.rate != null && usd(run.rate) + '/hr actual Pod rate',
      run.setupSeconds != null && run.setupSeconds.toFixed(1) + (run.artifacts ? ' s dependency and dataset setup' : ' s model setup'),
      run.runSeconds != null && run.runSeconds.toFixed(1) + (run.artifacts ? ' s training incl. model load' : ' s generation'),
      run.evaluationSeconds != null && run.evaluationSeconds.toFixed(1) + ' s evaluation',
      run.artifacts && 'Adapters saved to ' + run.artifacts,
      run.deletedAt && 'Deletion verified',
      run.prompt && run.prompt + ' · seed ' + run.seed + ' · ' + run.steps + ' steps',
      run.error
    ].filter(Boolean).join(' · ');
    card.append(summary);
    if (run.chatReply) {
      const reply = document.createElement('pre');
      reply.textContent = run.chatReply;
      card.append(reply);
    }
    if (run.prompts) {
      const prompts = document.createElement('ul');
      for (const [category, prompt] of Object.entries(run.prompts)) {
        const item = document.createElement('li');
        item.textContent = category + ' · ' + prompt;
        prompts.append(item);
      }
      card.append(prompts);
    }
    if (run.resultId) card.append(savedRunButton(run.resultId));
    const events = document.createElement('ol');
    for (const event of run.events) {
      const item = document.createElement('li');
      item.textContent = new Date(event.time * 1000).toLocaleTimeString() + ' · ' + event.phase;
      events.append(item);
    }
    card.append(events);
  }
}

for (const tab of document.querySelectorAll('[data-runpod-view]')) {
  tab.onclick = () => {
    for (const item of document.querySelectorAll('[data-runpod-view]')) {
      const active = item === tab;
      item.setAttribute('aria-pressed', String(active));
      get('runpod-view-' + item.dataset.runpodView).hidden = !active;
    }
  };
}

function savedRunButton(id) {
  const button = document.createElement('a');
  button.className = 'btn btn-outline btn-sm';
  button.textContent = 'View #' + id;
  button.href = '?result=' + id + '#runpod';
  button.onclick = event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    previewSaved(id);
  };
  return button;
}

async function refreshRunpodBilling() {
  if (runpodBillingPending || Date.now() < runpodBillingRetryAt) return;
  runpodBillingPending = true;
  const status = get('runpod-billing-status');
  try {
    const response = await fetch('/runpod/billing');
    if (!response.ok) throw new Error(await response.text());
    runpodBilling = await response.json();
    runpodBillingRetryAt = Date.now() + (runpodBilling.retryAfter || 0) * 1000;
    const charges = Object.values(runpodBilling.charges || {});
    const total = charges.reduce((sum, charge) => sum + (Number(charge.usd) || 0), 0);
    status.textContent = runpodBilling.chargesError
      ? runpodBilling.chargesError + (runpodBilling.retryAfter ? ' · refresh paused' : '')
      : usd(total) + ' billed · last 7 days · ' + new Date(runpodBilling.time * 1000).toLocaleTimeString();
    renderRunpodHistory();
    const linked = new Set(runpodRuns.map(run => run.pod));
    const unlinked = get('runpod-billing-unlinked');
    unlinked.replaceChildren();
    for (const [id, charge] of Object.entries(runpodBilling.charges || {})) {
      if (linked.has(id)) continue;
      const row = document.createElement('p');
      row.textContent = 'Unlinked Pod ' + id + ' · ' + (charge.gpu || 'GPU unknown') + ' · ' + usd(charge.usd) + ' billed';
      unlinked.append(row);
    }
    get('runpod-billing-other').hidden = !unlinked.childElementCount;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    runpodBillingPending = false;
  }
}

async function showEarlierRunpodImages() {
  const response = await fetch('/history');
  if (!response.ok) return;
  const linked = new Set(runpodRuns.map(run => run.resultId));
  const earlier = (await response.json()).filter(run => run.device === 'Runpod' &&
    run.status === 'Saved' && !linked.has(run.id));
  const container = get('runpod-previous-images');
  container.replaceChildren();
  if (earlier.length) {
    const label = document.createElement('p');
    label.textContent = 'Earlier images without a recorded Pod ID';
    container.append(label, ...earlier.slice(0, 20).map(run => savedRunButton(run.id)));
  }
}

async function refreshRunpodJob() {
  if (runpodJobRefreshPending) return;
  runpodJobRefreshPending = true;
  try {
    const response = await fetch('/runpod/job');
    if (!response.ok) throw new Error('Could not read the Runpod job.');
    const job = await response.json();
    serverLocalBusy = !!job.localBusy;
    renderLocalActivity();
    runpodRuns = job.runs || [];
    const sources = runpodRuns.filter(run => run.artifacts && run.resultId);
    const imageTargets = get('image-lora-targets');
    if ([...imageTargets.children].map(option => option.value).join(',') !== sources.map(run => 'lora:' + run.run).join(',')) {
      const device = get('image-device');
      const selected = device.value;
      imageTargets.replaceChildren(...sources.map(run => new Option(
        (run.model || 'Saved LoRA') + ' · #' + run.resultId, 'lora:' + run.run)));
      if ([...device.options].some(option => option.value === selected)) device.value = selected;
    }
    const picker = get('runpod-eval-source');
    if ([...picker.options].map(option => option.value).join(',') !== sources.map(run => run.run).join(',')) {
      const selected = picker.value;
      picker.replaceChildren(...sources.map(run => new Option(
        'Image #' + run.resultId + ' · ' + new Date(run.started * 1000).toLocaleString(), run.run)));
      if (sources.some(run => run.run === selected)) picker.value = selected;
    }
    get('runpod-eval-submit').disabled = job.running || job.pending || !sources.length;
    if (lastRunpodJobRunning && !job.running && job.state?.resultId) selectedRunpodId = job.state.run;
    renderRunpodHistory();
    if (lastRunpodJobRunning && !job.running) refreshRunpodBilling();
    lastRunpodJobRunning = job.running;
    get('runpod-job-start').disabled = job.running || job.pending;
    get('runpod-job-train').disabled = job.running || job.pending;
    get('runpod-job-train-dayton').disabled = job.running || job.pending;
    get('runpod-job-train-dayton-extended').disabled = job.running || job.pending;
    get('runpod-job-train-dayton-context').disabled = job.running || job.pending;
    get('runpod-job-stop').disabled = !job.running;
    get('runpod-job-cleanup').disabled = job.running || !job.pending;
    const state = job.state;
    get('runpod-job-status').textContent = state
      ? [state.phase, state.uploadBytes && state.uploadedBytes < state.uploadBytes &&
          (100 * state.uploadedBytes / state.uploadBytes).toFixed(0) + '% uploaded',
          state.step != null && state.step + '/' + state.totalSteps + ' steps',
        state.gpu, state.pod && 'Pod ' + state.pod, state.rate && '$' + state.rate + '/hr']
        .filter(Boolean).join(' · ')
      : job.running ? 'Starting' : 'Idle';
    get('runpod-job-error').textContent = [state?.error, job.pending && state?.cleanupIssue,
      !job.running && job.pending && 'Pod cleanup is unverified.'].filter(Boolean).join(' ') ||
      (job.running && state?.workerIssue ? 'Check ' + state.attempts + ' · last response ' + state.workerIssue : '') ||
      (!job.running && job.pending ? 'A prior Pod needs cleanup.' : '');
    get('header-runpod-activity').textContent = job.running || job.pending
      ? get('runpod-job-status').textContent + (job.pending && !job.running ? ' · cleanup unverified' : '')
      : state?.phase || 'Idle';
  } catch (error) {
    get('runpod-job-error').textContent = error.message;
    get('header-runpod-activity').textContent = 'Status unavailable';
  } finally {
    runpodJobRefreshPending = false;
  }
}
async function controlRunpodJob(action, options) {
  get('runpod-job-status').textContent = 'Sending ' + action + ' request…';
  get('runpod-job-error').textContent = '';
  try {
    const response = await fetch('/runpod/job/' + action, {
      method: 'POST',
      ...(options ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) } : {})
    });
    if (!response.ok) throw new Error(await response.text());
    await refreshRunpodJob();
  } catch (error) {
    get('runpod-job-error').textContent = error.message;
  }
}
get('runpod-job-start').onclick = () => {
  if (confirm('Arm one paid Runpod test at a quoted ceiling of $0.65/hour? Billing starts if a Pod is created.')) {
    controlRunpodJob('start');
  }
};
get('runpod-job-stop').onclick = () => controlRunpodJob('stop');
get('runpod-job-train').onclick = () => {
  if (confirm('Arm one paid botanical training run? The quoted ceiling is $0.65/hour and the local Pod deadline is two hours.')) {
    controlRunpodJob('train');
  }
};
get('runpod-job-train-dayton').onclick = () => {
  if (confirm('Upload 13 DaytonWitch training images and the reviewed captions to one paid Runpod Pod? The quoted ceiling is $0.65/hour and the local Pod deadline is two hours.')) {
    controlRunpodJob('train-dayton');
  }
};
get('runpod-job-train-dayton-extended').onclick = () => {
  if (confirm('Upload DaytonWitch to one paid Pod for 480 steps at 768 px and rank 8? Quoted ceiling: 0.65 USD/hour. Local deadline: two hours.')) controlRunpodJob('train-dayton-extended');
};
get('runpod-job-train-dayton-context').onclick = () => {
  if (confirm('Upload the 13 DaytonWitch training images and revised captions to one paid Runpod Pod? The quoted ceiling is $0.65/hour and the local Pod deadline is two hours.')) {
    controlRunpodJob('train-dayton-context');
  }
};
get('runpod-job-cleanup').onclick = () => controlRunpodJob('cleanup');
samples('runpod-eval-samples', 'runpod-eval-prompt', [
  ...daytonImageSamples,
  ['Night bloom', 'Japanese botanical woodblock print on paper, a night-blooming cereus with a single white blossom under a crescent moon.'],
  ['Glass fern', 'A glass fern with translucent fronds, rendered as a Japanese botanical woodblock print on warm ivory paper.'],
  ['Autumn branch', 'Japanese botanical woodblock print on paper, a crooked branch of scarlet maple leaves and a small moth, generous empty space.'],
  ['Photo control', 'A sharp modern macro photograph of a scarlet maple leaf on a matte black studio backdrop.']
]);
get('runpod-eval').onsubmit = event => {
  event.preventDefault();
  const prompt = get('runpod-eval-prompt').value.trim();
  if (!prompt) {
    get('runpod-job-error').textContent = 'Enter a prompt to compare.';
    return;
  }
  if (confirm('Run one paid comparison on Runpod at a quoted ceiling of $0.65/hour?')) {
    controlRunpodJob('eval', { run: get('runpod-eval-source').value, prompt,
      negativePrompt: get('runpod-eval-negative').value.trim(), seed: get('runpod-eval-seed').valueAsNumber });
  }
};
async function openRunpodJobView() {
  await refreshRunpodJob();
  await Promise.allSettled([refreshRunpodBilling(), showEarlierRunpodImages()]);
}
window.addEventListener('hashchange', () => {
  if (location.hash === '#runpod') openRunpodJobView();
  if (location.hash === '#images') refreshRunpodJob();
});
get('runpod-history-filter').oninput = renderRunpodHistory;
get('runpod-history-sort').onchange = renderRunpodHistory;
setInterval(refreshRunpodJob, 2500);
setInterval(refreshRunpodBilling, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshRunpodJob();
  refreshRunpod();
  refreshRunpodBilling();
});
if (location.hash === '#runpod') openRunpodJobView();
else {
  refreshRunpodJob();
  refreshRunpodBilling();
}
const linkedResult = Number(new URLSearchParams(location.search).get('result'));
if (Number.isSafeInteger(linkedResult) && linkedResult > 0) previewSaved(linkedResult);

