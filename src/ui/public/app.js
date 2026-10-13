// Giao diện quản lý minigame: đọc /api/data, duyệt tay qua /api/manual, chạy quét qua /api/run.
// Tên và nội dung bình luận đến từ Facebook, luôn escape trước khi đưa vào HTML (hoặc dùng textContent).

const STATUS = { QUALIFIED: 'ĐỦ ĐIỀU KIỆN', PENDING: 'CHỜ DUYỆT', REJECTED: 'LOẠI' };
const STATUS_CLASS = { [STATUS.QUALIFIED]: 'ok', [STATUS.PENDING]: 'warn', [STATUS.REJECTED]: 'bad' };
const FILTERS = [
  ['all', 'Tất cả'],
  ['qualified', 'Đủ điều kiện'],
  ['pending', 'Chờ duyệt'],
  ['rejected', 'Loại'],
  ['manual', 'Đã duyệt tay'],
];
const FILTER_STATUS = { qualified: STATUS.QUALIFIED, pending: STATUS.PENDING, rejected: STATUS.REJECTED };
const PAGE = 100;
const ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
};
const THEME_KEY = 'drnatro-theme';

const ui = {
  data: null,
  running: false,
  tab: 'records',
  filter: 'all',
  search: '',
  sort: 'default',
  limit: PAGE,
  rejectedSearch: '',
  rejectedLimit: PAGE,
  busy: new Set(),
  postDirty: false,
  lastLogLine: '',
  series: null,
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
}

function timeZone() {
  return ui.data?.config?.timezone || 'Asia/Ho_Chi_Minh';
}

function partsOf(date, withHour = false) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withHour ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { d: get('day'), m: get('month'), y: get('year'), h: get('hour'), min: get('minute') };
}

/** "09/10/2026 17:30" theo múi giờ của tool (giống định dạng trên Google Sheet). */
function fmt(iso, withYear = true) {
  if (!iso) return '';
  const p = partsOf(new Date(iso), true);
  return `${p.d}/${p.m}${withYear ? `/${p.y}` : ''} ${p.h}:${p.min}`;
}

function fmtTime(iso) {
  return fmt(iso, false).split(' ').pop();
}

const num = (n) => Number(n || 0).toLocaleString('vi-VN');

async function api(path, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Phiên đăng nhập Google hết hạn hoặc Gmail vừa bị chặn: về trang đăng nhập.
    location.reload();
    throw new Error(data.error || 'Cần đăng nhập lại.');
  }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

const VISITOR_STATUS = { allowed: ['ok', 'Được phép'], pending: ['warn', 'Chờ cấp quyền'], blocked: ['bad', 'Đã chặn'] };

let toastTimer;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3000);
}

// ---------- Tải dữ liệu ----------

async function loadData({ refresh = false, quiet = false } = {}) {
  try {
    ui.data = await api(`/api/data${refresh ? '?refresh=1' : ''}`);
    ui.running = ui.data.run.running;
    render();
  } catch (err) {
    if (!quiet) toast(`Không tải được dữ liệu: ${err.message}`, true);
  }
}

function recount() {
  const counts = { [STATUS.QUALIFIED]: 0, [STATUS.PENDING]: 0, [STATUS.REJECTED]: 0 };
  for (const r of ui.data.records) counts[r.status] = (counts[r.status] || 0) + 1;
  ui.data.counts = counts;
}

// ---------- Vẽ giao diện ----------

function render() {
  if (!ui.data) return;
  renderHeader();
  renderKpis();
  renderChart();
  renderControls();
  renderAlerts();
  renderFilters();
  renderRecords();
  renderRejected();
}

function renderHeader() {
  const { config, run } = ui.data;
  const pill = $('run-pill');
  if (ui.running) {
    pill.className = 'pill running';
    pill.textContent = 'Đang quét…';
  } else if (config.frozen) {
    pill.className = 'pill frozen';
    pill.textContent = 'Đã chốt';
  } else {
    pill.className = 'pill';
    pill.textContent = 'Sẵn sàng';
  }
  pill.title = run.lock ? `PID ${run.lock.pid}, bắt đầu ${fmt(run.lock.startedAt)}` : '';
  const viewer = $('viewer');
  viewer.hidden = !ui.data.viewer?.remote;
  viewer.textContent = ui.data.viewer?.email ? `Đăng nhập: ${ui.data.viewer.email}` : '';
  viewer.title = viewer.textContent;
  $('logout-btn').hidden = !ui.data.viewer?.remote;
  $('tab-visitors').hidden = !ui.data.viewer?.admin;
  $('tab-count-visitors').textContent = ui.data.pendingVisitors ? `${ui.data.pendingVisitors} chờ` : '';
  renderCountdown();
}

function renderCountdown() {
  if (!ui.data) return;
  const { config } = ui.data;
  const el = $('countdown');
  if (config.frozen) {
    el.innerHTML = `Đã chốt lúc <strong>${esc(fmt(config.freezeAt))}</strong>`;
    return;
  }
  const ms = new Date(config.freezeAt) - Date.now();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const n = (v) => `<strong>${v}</strong>`;
  const left = days > 0 ? `${n(days)} ngày ${n(hours)} giờ` : hours > 0 ? `${n(hours)} giờ ${n(minutes)} phút` : `${n(Math.max(minutes, 0))} phút`;
  el.innerHTML = `Chốt sau ${left} · ${esc(fmt(config.freezeAt))}`;
}

function renderKpis() {
  const { counts, records, rejected, results } = ui.data;
  const manual = records.filter((r) => r.manualNormalized).length;
  const card = (filter, icon, label, value, sub, accent = false) =>
    `<button type="button" class="kpi" data-filter="${filter}" aria-pressed="${ui.filter === filter}">
      <span class="kpi-label"><span class="ic-${icon}">${ICON[icon]}</span>${label}</span>
      <span class="kpi-value${accent ? ' accent' : ''}">${results ? num(value) : '–'}</span>
      <span class="kpi-sub">${results ? sub : 'Chưa quét lần nào'}</span>
    </button>`;
  $('kpis').innerHTML = [
    card('qualified', 'ok', 'Đủ điều kiện', counts[STATUS.QUALIFIED], `trên <strong>${num(records.length)}</strong> người đủ tag`, true),
    card('pending', 'warn', 'Chờ duyệt', counts[STATUS.PENDING], `<strong>${num(manual)}</strong> người đã được duyệt tay`),
    card('rejected', 'bad', 'Loại', counts[STATUS.REJECTED], `thêm <strong>${num(rejected.length)}</strong> người không đủ tag`),
  ].join('');
}

// ---------- Biểu đồ: người tham gia theo ngày (hoặc theo giờ khi mới chạy được 1–2 ngày) ----------

function participationSeries() {
  const stamps = [...ui.data.records, ...ui.data.rejected]
    .map((r) => (r.comment?.createdAt ? Date.parse(r.comment.createdAt) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!stamps.length) return null;

  const dayKey = (t) => {
    const p = partsOf(new Date(t));
    return { key: `${p.y}-${p.m}-${p.d}`, label: `${p.d}/${p.m}`, long: `Ngày ${p.d}/${p.m}/${p.y}` };
  };
  const hourKey = (t) => {
    const p = partsOf(new Date(t), true);
    return { key: `${p.y}-${p.m}-${p.d}T${p.h}`, label: `${p.h}h ${p.d}/${p.m}`, long: `${p.h}:00–${p.h}:59 ngày ${p.d}/${p.m}` };
  };
  const build = (keyOf, stepMs) => {
    const buckets = [];
    const index = new Map();
    const last = stamps[stamps.length - 1];
    for (let t = Math.floor(stamps[0] / stepMs) * stepMs; t <= last + stepMs; t += stepMs) {
      const k = keyOf(t);
      if (index.has(k.key)) continue;
      index.set(k.key, buckets.length);
      buckets.push({ ...k, value: 0 });
    }
    for (const t of stamps) {
      const i = index.get(keyOf(t).key);
      if (i !== undefined) buckets[i].value += 1;
    }
    while (buckets.length > 1 && buckets[buckets.length - 1].value === 0 && buckets[buckets.length - 1].key > keyOf(last).key) buckets.pop();
    let total = 0;
    for (const b of buckets) b.total = total += b.value;
    return buckets;
  };
  const daily = build(dayKey, 3_600_000);
  if (daily.length >= 3) return { unit: 'ngày', points: daily };
  return { unit: 'giờ', points: build(hourKey, 3_600_000) };
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Đường cong monotone (Fritsch–Carlson): làm mượt đỉnh mà không vẽ vượt quá giá trị thật. */
function monotonePath(pts) {
  const n = pts.length;
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(pts[i + 1].x - pts[i].x);
    m.push((pts[i + 1].y - pts[i].y) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i += 1) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i] / 3;
    d += ` C${pts[i].x + h},${pts[i].y + t[i] * h} ${pts[i + 1].x - h},${pts[i + 1].y - t[i + 1] * h} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

function renderChart() {
  const { results, records, rejected } = ui.data;
  const stats = results?.stats || {};
  $('chart-total').innerHTML = results
    ? `<span class="big">${num(records.length + rejected.length)}</span><span class="small">người đã bình luận</span>`
    : '';
  $('chart-foot').innerHTML = results
    ? [
        [stats.commentCount, 'bình luận quét được'],
        ...(stats.shareTotal != null ? [[stats.shareTotal, 'lượt chia sẻ trên bài']] : []),
        [stats.shareCount, 'người xác nhận đã share'],
        [records.length, 'người đủ tag'],
        [rejected.length, 'không đủ tag'],
      ]
        .map(([v, l]) => `<span><strong>${num(v)}</strong>${l}</span>`)
        .join('')
    : '';

  ui.series = results ? participationSeries() : null;
  const tableBox = $('chart-table');
  tableBox.closest('details').hidden = !ui.series;
  if (!ui.series) {
    $('chart').innerHTML = `<div class="chart-empty">${results ? 'Chưa đọc được thời gian bình luận.' : 'Chưa có dữ liệu. Lưu link bài viết rồi bấm Chạy quét ngay.'}</div>`;
    tableBox.innerHTML = '';
    return;
  }
  $('chart-sub').textContent = `Mỗi người tính một lần, theo ${ui.series.unit} của bình luận được chọn`;
  tableBox.innerHTML = `<table><thead><tr><th>${ui.series.unit === 'ngày' ? 'Ngày' : 'Giờ'}</th><th class="num">Người mới</th><th class="num">Tích luỹ</th></tr></thead><tbody>${ui.series.points
    .map((p) => `<tr><td>${esc(p.long)}</td><td class="num">${num(p.value)}</td><td class="num">${num(p.total)}</td></tr>`)
    .join('')}</tbody></table>`;
  drawChart();
}

function drawChart() {
  const el = $('chart');
  const series = ui.series;
  if (!series) return;
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!W || !H) return;
  const pts = series.points;
  const n = pts.length;
  const M = { l: 40, r: 16, t: 28, b: 28 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const peak = Math.max(...pts.map((p) => p.value));
  const step = niceStep(Math.max(peak, 4) / 4);
  const max = step * Math.ceil(Math.max(peak, 1) / step);
  const x = (i) => M.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => M.t + ih - (v / max) * ih;
  const xy = pts.map((p, i) => ({ x: +x(i).toFixed(1), y: +y(p.value).toFixed(1) }));
  const base = M.t + ih;

  const ticks = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  const grid = ticks
    .map((v) => `<line class="gl" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke-width="1" shape-rendering="crispEdges"/><text class="tick" x="${M.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${num(v)}</text>`)
    .join('');
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 76))));
  const xLabels = pts
    .map((p, i) => {
      if (i % every !== 0 && i !== n - 1) return '';
      if (i !== n - 1 && n - 1 - i < every / 2) return '';
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="${anchor}">${esc(p.label)}</text>`;
    })
    .join('');

  const line = monotonePath(xy);
  const area = n > 1 ? `${line} L${xy[n - 1].x},${base} L${xy[0].x},${base} Z` : '';
  const peakIndex = pts.findIndex((p) => p.value === peak);
  const pk = xy[peakIndex];
  const peakAnchor = pk.x < M.l + 60 ? 'start' : pk.x > W - M.r - 60 ? 'end' : 'middle';
  const end = xy[n - 1];

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" tabindex="0" role="img" aria-label="Người tham gia theo ${series.unit}: cao nhất ${peak} người, tổng ${pts[n - 1].total} người. Dùng phím mũi tên để xem từng mốc.">
    <defs>
      <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
        <stop class="s1" offset="0%"/>
        <stop class="s2" offset="100%"/>
      </linearGradient>
    </defs>
    ${grid}
    ${xLabels}
    ${area ? `<path d="${area}" fill="url(#area-grad)"/>` : ''}
    <path class="line" d="${line}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${peak > 0 ? `<text class="peak-label" x="${pk.x}" y="${pk.y - 12}" text-anchor="${peakAnchor}">Cao nhất ${num(peak)}</text>` : ''}
    <circle class="dot-mark" cx="${end.x}" cy="${end.y}" r="4" stroke-width="2"/>
    <g class="hover" visibility="hidden">
      <line class="cross" y1="${M.t}" y2="${base}" stroke-width="1"/>
      <circle class="hdot dot-mark" r="5" stroke-width="2"/>
    </g>
    <rect class="hit" x="${M.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>
  </svg>`;

  const svg = el.querySelector('svg');
  const hover = svg.querySelector('.hover');
  const cross = svg.querySelector('.cross');
  const hdot = svg.querySelector('.hdot');
  let tip = el.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    tip.innerHTML = '<div class="v"></div><div class="l"></div><div class="l t"></div>';
  }
  el.appendChild(tip);
  let current = n - 1;
  const show = (i) => {
    current = Math.max(0, Math.min(n - 1, i));
    const p = pts[current];
    const q = xy[current];
    cross.setAttribute('x1', q.x);
    cross.setAttribute('x2', q.x);
    hdot.setAttribute('cx', q.x);
    hdot.setAttribute('cy', q.y);
    hover.setAttribute('visibility', 'visible');
    tip.querySelector('.v').textContent = `${num(p.value)} người mới`;
    tip.querySelectorAll('.l')[0].textContent = p.long;
    tip.querySelectorAll('.l')[1].textContent = `Tích luỹ: ${num(p.total)} người`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(q.x, tw / 2), W - tw / 2)}px`;
    tip.style.top = `${q.y}px`;
  };
  const hide = () => {
    hover.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    show(n === 1 ? 0 : Math.round(((px - M.l) / iw) * (n - 1)));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(current));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(current + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });
}

// ---------- Điều khiển & cảnh báo ----------

function renderControls() {
  const { config, results, run } = ui.data;
  const input = $('post-url');
  if (!ui.postDirty && document.activeElement !== input) input.value = config.postUrl;

  const btn = $('run-btn');
  btn.disabled = ui.running || !config.postUrl || config.frozen;
  btn.textContent = ui.running ? 'Đang quét…' : 'Chạy quét ngay';
  btn.title = !config.postUrl ? 'Lưu link bài viết trước' : config.frozen ? 'Đã chốt kết quả' : '';

  const meta = [];
  if (ui.running) {
    const since = run.lock?.startedAt || run.uiRun.startedAt;
    meta.push(`Đang quét${since ? ` từ ${fmtTime(since)}` : ''}. Không đóng cửa sổ trình duyệt của tool.`);
    if (ui.lastLogLine) meta.push(`<span class="live-line">${esc(ui.lastLogLine)}</span>`);
  } else if (results) {
    meta.push(`Quét gần nhất: ${fmt(results.startedAt)} → ${fmtTime(results.finishedAt)}${results.finalRun ? ' (lần chốt cuối)' : ''}`);
  } else {
    meta.push('Chưa quét lần nào.');
  }
  if (!config.frozen && config.finalRunAt) meta.push(`Lần chạy chốt cuối: ${fmt(config.finalRunAt)}`);
  $('run-meta').innerHTML = meta.join('<br>');

  $('sheet-link').href = safeUrl(config.sheetUrl);
  const postLink = $('post-link');
  postLink.hidden = !safeUrl(config.postUrl);
  postLink.href = safeUrl(config.postUrl) || '#';

  $('lock-note').hidden = !ui.running;
}

function renderAlerts() {
  const { config, results, sheet, lastError, lastRun, run, counts, records } = ui.data;
  const items = [];
  if (lastError && (!lastRun || new Date(lastError.at) > new Date(lastRun))) {
    items.push({ kind: 'bad', title: `Lần quét lỗi lúc ${fmt(lastError.at)}`, body: lastError.message });
  }
  const uiRun = run.uiRun;
  if (!ui.running && uiRun.exitCode && uiRun.finishedAt && (!lastError || new Date(lastError.at) < new Date(uiRun.startedAt))) {
    const line = [...uiRun.output].reverse().find((l) => /LỖI|ERROR|lỗi/i.test(l)) || uiRun.output.at(-1) || '';
    items.push({ kind: 'bad', title: 'Lần quét bấm từ giao diện không chạy được', body: line });
  }
  if (!sheet.ok) {
    items.push({ kind: 'bad', title: 'Không đọc được Google Sheet', body: `${sheet.error} Cột duyệt tay đang hiển thị theo lần quét gần nhất.` });
  }
  if (!config.postUrl) {
    items.push({ kind: 'warn', title: 'Chưa có link bài viết', body: 'Dán link bài minigame ở ô Điều khiển, bấm Lưu rồi Chạy quét ngay.' });
  }
  if (results && counts[STATUS.PENDING] > 0) {
    const conflicts = records.filter((r) => r.status === STATUS.PENDING && String(r.memberEvidence || '').startsWith('conflict:')).length;
    items.push({
      kind: 'warn',
      title: `${num(counts[STATUS.PENDING])} người đang chờ duyệt tay`,
      body: `Share hoặc thành viên chưa xác nhận tự động được.${conflicts ? ` ${num(conflicts)} người có trang thành viên mâu thuẫn, nên mở hồ sơ kiểm tra.` : ''}`,
      action: ['pending', 'Xem danh sách'],
    });
  }
  if (results && !results.sharesAvailable && results.stats?.shareNote) {
    items.push({ kind: 'info', title: 'Cách kiểm tra share', body: results.stats.shareNote });
  }
  if (results && config.postUrl && results.postUrl && results.postUrl !== config.postUrl) {
    items.push({ kind: 'info', title: 'Kết quả đang hiển thị là của bài viết cũ', body: 'Bấm Chạy quét ngay để quét bài viết mới.' });
  }
  if (config.frozen) {
    items.push({ kind: 'info', title: 'Đã chốt kết quả', body: 'Tool không quét nữa, số liệu giữ nguyên. Vẫn duyệt tay được để hoàn tất danh sách.' });
  }
  if (ui.data.viewer?.admin && ui.data.pendingVisitors > 0) {
    items.push({
      kind: 'warn',
      title: `${num(ui.data.pendingVisitors)} Gmail đang chờ cấp quyền`,
      body: 'Có người đăng nhập từ xa nhưng chưa được cho phép vào giao diện.',
      action: ['tab:visitors', 'Xem và cấp quyền'],
    });
  }
  $('alert-count').textContent = items.length ? `(${items.length})` : '';
  $('alerts').innerHTML = items.length
    ? items
        .map(
          (a) =>
            `<div class="alert ${a.kind}"><strong>${esc(a.title)}</strong>${esc(a.body)}${a.action ? `<br><button type="button" class="act" data-filter="${a.action[0]}">${esc(a.action[1])}</button>` : ''}</div>`,
        )
        .join('')
    : '<div class="all-clear">Không có cảnh báo nào.</div>';
}

// ---------- Bảng ----------

function renderFilters() {
  const { counts, records } = ui.data;
  const value = {
    all: records.length,
    qualified: counts[STATUS.QUALIFIED],
    pending: counts[STATUS.PENDING],
    rejected: counts[STATUS.REJECTED],
    manual: records.filter((r) => r.manualNormalized || r.manualNote).length,
  };
  $('filters').innerHTML = FILTERS.map(
    ([key, label]) => `<button type="button" class="chip" data-filter="${key}" aria-pressed="${ui.filter === key}">${label}<span class="n">${num(value[key])}</span></button>`,
  ).join('');
  $('tab-count-records').textContent = num(records.length);
  $('tab-count-rejected').textContent = num(ui.data.rejected.length);
}

function matches(r, q) {
  return !q || String(r.name || '').toLowerCase().includes(q) || String(r.uid).includes(q);
}

function visibleRecords() {
  const q = ui.search.trim().toLowerCase();
  let rows = ui.data.records.filter((r) => {
    if (FILTER_STATUS[ui.filter] && r.status !== FILTER_STATUS[ui.filter]) return false;
    if (ui.filter === 'manual' && !(r.manualNormalized || r.manualNote)) return false;
    return matches(r, q);
  });
  if (ui.sort === 'engagement') rows = [...rows].sort((a, b) => b.engagement - a.engagement || b.likes - a.likes);
  if (ui.sort === 'name') rows = [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
  return rows;
}

function memberCell(r) {
  const dot = r.memberAuto === 'member' ? 'ok' : r.memberAuto === 'not_member' ? 'bad' : 'warn';
  const conflict = String(r.memberEvidence || '').startsWith('conflict:');
  const hint = conflict ? '<span class="hint">Trang hồ sơ có dấu hiệu mâu thuẫn, nên kiểm tra tay</span>' : '';
  return `<span class="auto" title="${esc(r.memberEvidence)}"><span class="dot ${dot}"></span>${esc(r.memberLabel)}</span>${hint}`;
}

function shareCell(r) {
  const dot = r.shareAuto === 'shared' ? 'ok' : 'warn';
  return `<span class="auto"><span class="dot ${dot}"></span>${esc(r.shareLabel)}</span>`;
}

function commentCell(c) {
  if (!c) return '<span class="muted">–</span>';
  const link = safeUrl(c.url) ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">Mở ↗</a>` : '';
  return `<div class="comment"><div class="text" title="${esc(c.text)}">${esc(c.text) || '<span class="muted">(không có chữ)</span>'}</div><div class="meta">${esc(fmt(c.createdAt))}${link}</div></div>`;
}

function whoCell(r) {
  const url = safeUrl(r.profileUrl);
  const name = esc(r.name || '(không rõ tên)');
  return `<div class="who">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>` : name}<div class="uid">${esc(r.uid)}</div></div>`;
}

function manualCell(r) {
  const d = r.manualNormalized || '';
  const disabled = ui.running ? 'disabled' : '';
  const busy = ui.busy.has(r.uid) ? ' busy' : '';
  return `<div class="manual${busy}" data-uid="${esc(r.uid)}">
    <div class="seg" role="group" aria-label="Duyệt tay">
      <button type="button" class="ok" data-decision="OK" aria-pressed="${d === 'OK'}" ${disabled}>OK</button>
      <button type="button" class="bad" data-decision="LOẠI" aria-pressed="${d === 'LOẠI'}" ${disabled}>LOẠI</button>
      <button type="button" class="clear" data-decision="" aria-pressed="${!d}" title="Bỏ duyệt tay, để tool tự xét" ${disabled}>Bỏ</button>
    </div>
    <input type="text" class="note" placeholder="Ghi chú duyệt…" maxlength="500" value="${esc(r.manualNote)}" ${disabled}>
  </div>`;
}

function renderRecords() {
  const rows = visibleRecords();
  const body = $('records-body');
  if (!ui.data.results) {
    body.innerHTML = '<tr><td class="empty" colspan="9">Chưa có kết quả. Lưu link bài viết rồi bấm Chạy quét ngay.</td></tr>';
    $('records-more').innerHTML = '';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="9">Không có ai khớp bộ lọc.</td></tr>';
    $('records-more').innerHTML = '';
    return;
  }
  body.innerHTML = rows
    .slice(0, ui.limit)
    .map(
      (r, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${whoCell(r)}</td>
      <td><span class="badge ${STATUS_CLASS[r.status] || ''}">${esc(r.status)}</span>${r.reasons.length ? `<div class="reasons">${esc(r.reasons.join('; '))}</div>` : ''}</td>
      <td class="num">${num(r.tagCount)}</td>
      <td>${memberCell(r)}</td>
      <td>${shareCell(r)}</td>
      <td class="num engagement"><strong>${num(r.engagement)}</strong><span class="split">${num(r.likes)} thích · ${num(r.replies)} trả lời</span></td>
      <td>${commentCell(r.comment)}</td>
      <td>${manualCell(r)}</td>
    </tr>`,
    )
    .join('');
  $('records-more').innerHTML =
    rows.length > ui.limit
      ? `Đang hiện ${num(ui.limit)}/${num(rows.length)} người · <button type="button" class="btn btn-ghost btn-small" data-more="records">Xem thêm ${PAGE}</button>`
      : '';
}

function renderRejected() {
  const q = ui.rejectedSearch.trim().toLowerCase();
  const rows = ui.data.rejected.filter((r) => matches(r, q));
  const body = $('rejected-body');
  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">${ui.data.rejected.length ? 'Không có ai khớp tìm kiếm.' : 'Chưa có ai trong danh sách này.'}</td></tr>`;
    $('rejected-more').innerHTML = '';
    return;
  }
  body.innerHTML = rows
    .slice(0, ui.rejectedLimit)
    .map(
      (r, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${whoCell(r)}</td>
      <td>${esc(r.reason)}</td>
      <td class="num">${num(r.tagCount)}</td>
      <td>${commentCell(r.comment)}</td>
    </tr>`,
    )
    .join('');
  $('rejected-more').innerHTML =
    rows.length > ui.rejectedLimit
      ? `Đang hiện ${num(ui.rejectedLimit)}/${num(rows.length)} người · <button type="button" class="btn btn-ghost btn-small" data-more="rejected">Xem thêm ${PAGE}</button>`
      : '';
}

async function renderLogs() {
  try {
    const { file, lines } = await api('/api/logs?lines=400');
    const el = $('log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    $('log-file').textContent = file ? `logs/${file} · 400 dòng cuối` : 'Chưa có nhật ký.';
    el.innerHTML = lines
      .map((l) => {
        const cls = /\[ERROR\]/.test(l) ? 'err' : /\[WARN\]/.test(l) ? 'warn' : '';
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      })
      .join('\n');
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch (err) {
    $('log-file').textContent = `Không đọc được nhật ký: ${err.message}`;
  }
}

// ---------- Chế độ sáng / tối ----------

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function renderThemeButton() {
  const light = currentTheme() === 'light';
  const btn = $('theme-btn');
  // Nút ghi chế độ sẽ chuyển sang, kèm biểu tượng của chế độ đó.
  btn.innerHTML = light ? `${ICON.moon}<span>Tối</span>` : `${ICON.sun}<span>Sáng</span>`;
  btn.setAttribute('aria-label', light ? 'Chuyển sang giao diện tối' : 'Chuyển sang giao diện sáng');
  btn.title = btn.getAttribute('aria-label');
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Trình duyệt chặn lưu trữ: vẫn đổi được, chỉ không nhớ cho lần sau.
  }
  renderThemeButton();
}

// ---------- Thao tác ----------

async function saveManual(uid, decision, note) {
  if (ui.running) return toast('Đang quét, tạm khoá duyệt tay.', true);
  ui.busy.add(uid);
  renderRecords();
  try {
    const res = await api('/api/manual', { uid, decision, note });
    const i = ui.data.records.findIndex((r) => r.uid === uid);
    if (res.record && i >= 0) ui.data.records[i] = res.record;
    else await loadData({ refresh: true, quiet: true });
    recount();
    toast(decision ? `Đã ghi ${decision} lên Google Sheet (dòng ${res.rowNumber}).` : 'Đã lưu lên Google Sheet.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    ui.busy.delete(uid);
    renderKpis();
    renderAlerts();
    renderFilters();
    renderRecords();
  }
}

function setTab(tab) {
  ui.tab = tab;
  for (const el of document.querySelectorAll('.tab')) el.setAttribute('aria-selected', String(el.dataset.tab === tab));
  for (const name of ['records', 'rejected', 'logs', 'visitors']) $(`panel-${name}`).hidden = name !== tab;
  if (tab === 'logs') renderLogs();
  if (tab === 'visitors') renderVisitors();
}

function visitorRows(visitors) {
  if (!visitors.length) return '<tr><td class="empty" colspan="7">Chưa có ai đăng nhập từ xa.</td></tr>';
  return visitors
    .map((v) => {
      const [cls, label] = VISITOR_STATUS[v.status] || ['', v.status];
      const email = esc(v.email);
      const actions = [
        v.status !== 'allowed' ? `<button type="button" class="btn btn-small" data-visitor="allowed" data-email="${email}">Cho phép</button>` : '',
        v.status !== 'blocked' ? `<button type="button" class="btn btn-ghost btn-small" data-visitor="blocked" data-email="${email}">Chặn</button>` : '',
      ].join(' ');
      return `<tr>
        <td><strong>${email}</strong>${v.inConfig ? '<span class="tag" title="Có trong ui.allowedEmails của config.json">config</span>' : ''}</td>
        <td>${esc(v.name) || '<span class="muted">–</span>'}</td>
        <td><span class="badge ${cls}">${esc(label)}</span></td>
        <td>${esc(fmt(v.firstSeen)) || '<span class="muted">chưa vào</span>'}</td>
        <td>${esc(fmt(v.lastSeen)) || '<span class="muted">–</span>'}</td>
        <td class="num">${num(v.count)}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
}

async function renderVisitors() {
  try {
    const { visitors } = await api('/api/visitors');
    $('visitors-body').innerHTML = visitorRows(visitors);
  } catch (err) {
    $('visitors-body').innerHTML = `<tr><td class="empty" colspan="7">${esc(err.message)}</td></tr>`;
  }
}

async function setVisitor(email, status) {
  try {
    const { visitors } = await api('/api/visitors', { email, status });
    $('visitors-body').innerHTML = visitorRows(visitors);
    ui.data.pendingVisitors = visitors.filter((v) => v.status === 'pending' && v.count > 0).length;
    renderHeader();
    renderAlerts();
    toast(status === 'allowed' ? `Đã cho phép ${email}.` : `Đã chặn ${email}.`);
  } catch (err) {
    toast(err.message, true);
  }
}

function setFilter(filter, { scroll = false } = {}) {
  ui.filter = ui.filter === filter && filter !== 'all' && !scroll ? 'all' : filter;
  ui.limit = PAGE;
  setTab('records');
  renderKpis();
  renderFilters();
  renderRecords();
  if (scroll) document.querySelector('.table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindEvents() {
  $('post-url').addEventListener('input', () => (ui.postDirty = true));
  $('post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/config', { postUrl: $('post-url').value.trim() });
      ui.data.config = res.config;
      ui.postDirty = false;
      render();
      toast('Đã lưu link bài viết.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('run-btn').addEventListener('click', async () => {
    if (!confirm('Chạy quét ngay?\n\nMáy chạy tool sẽ mở trình duyệt vào Facebook, mất khoảng 10–30 phút. Trong lúc quét, duyệt tay tạm khoá.')) return;
    try {
      await api('/api/run', {});
      ui.running = true;
      ui.lastLogLine = '';
      await loadData({ quiet: true });
      toast('Đã bắt đầu quét.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('refresh-btn').addEventListener('click', () => loadData({ refresh: true }));
  $('theme-btn').addEventListener('click', toggleTheme);
  $('logout-btn').addEventListener('click', async () => {
    await api('/api/logout', {}).catch(() => {});
    location.reload();
  });
  $('visitors-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-visitor]');
    if (btn) setVisitor(btn.dataset.email, btn.dataset.visitor);
  });
  $('visitor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('visitor-email').value.trim();
    if (!email) return;
    setVisitor(email, 'allowed').then(() => ($('visitor-email').value = ''));
  });

  $('kpis').addEventListener('click', (e) => {
    const card = e.target.closest('[data-filter]');
    if (card) setFilter(card.dataset.filter, { scroll: true });
  });
  $('alerts').addEventListener('click', (e) => {
    const act = e.target.closest('[data-filter]');
    if (!act) return;
    if (act.dataset.filter.startsWith('tab:')) {
      setTab(act.dataset.filter.slice(4));
      document.querySelector('.table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setFilter(act.dataset.filter, { scroll: true });
    }
  });
  $('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (chip) setFilter(chip.dataset.filter);
  });
  $('search').addEventListener('input', (e) => {
    ui.search = e.target.value;
    ui.limit = PAGE;
    renderRecords();
  });
  $('sort').addEventListener('change', (e) => {
    ui.sort = e.target.value;
    renderRecords();
  });
  $('search-rejected').addEventListener('input', (e) => {
    ui.rejectedSearch = e.target.value;
    ui.rejectedLimit = PAGE;
    renderRejected();
  });
  document.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (!more) return;
    if (more.dataset.more === 'records') {
      ui.limit += PAGE;
      renderRecords();
    } else {
      ui.rejectedLimit += PAGE;
      renderRejected();
    }
  });
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setTab(tab.dataset.tab));

  const body = $('records-body');
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-decision]');
    if (!btn || btn.disabled) return;
    const box = btn.closest('.manual');
    const record = ui.data.records.find((r) => r.uid === box.dataset.uid);
    const decision = btn.dataset.decision;
    if (record && decision === (record.manualNormalized || '') && decision !== '') return;
    saveManual(box.dataset.uid, decision, box.querySelector('.note').value);
  });
  body.addEventListener('change', (e) => {
    if (!e.target.classList.contains('note')) return;
    const box = e.target.closest('.manual');
    const record = ui.data.records.find((r) => r.uid === box.dataset.uid);
    saveManual(box.dataset.uid, record?.manualNormalized || '', e.target.value);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('note')) e.target.blur();
  });

  let frame;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawChart);
  }).observe($('chart'));
}

// ---------- Theo dõi trạng thái ----------

function typingInTable() {
  const el = document.activeElement;
  return el && el.classList?.contains('note');
}

async function pollStatus() {
  try {
    const status = await api('/api/status');
    const wasRunning = ui.running;
    ui.running = status.running;
    if (ui.data) {
      ui.data.run = { running: status.running, lock: status.lock, uiRun: status.uiRun };
      ui.data.config.frozen = status.frozen;
    }
    if (ui.running) {
      const { lines } = await api('/api/logs?lines=1');
      ui.lastLogLine = (lines[0] || '').replace(/^\[[^\]]+\]\s*\[\w+\]\s*/, '');
    }
    if (wasRunning && !ui.running) {
      await loadData({ refresh: true, quiet: true });
      toast(ui.data?.lastError && new Date(ui.data.lastError.at) > new Date(ui.data.lastRun || 0) ? 'Lần quét kết thúc với lỗi, xem mục Cảnh báo.' : 'Quét xong, đã cập nhật kết quả.');
    } else if (wasRunning !== ui.running && ui.data) {
      render();
    } else if (ui.running && ui.data) {
      renderControls();
      renderHeader();
    }
    if (ui.tab === 'logs' && ui.running) renderLogs();
  } catch {
    // Máy chủ giao diện vừa tắt hoặc đang bận, thử lại ở lượt sau.
  }
}

renderThemeButton();
bindEvents();
loadData();
setInterval(pollStatus, 3000);
setInterval(() => {
  if (!ui.running && !typingInTable() && document.visibilityState === 'visible') loadData({ quiet: true });
}, 60_000);
setInterval(renderCountdown, 30_000);
