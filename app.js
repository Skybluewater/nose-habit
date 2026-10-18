import { FilesetResolver, HandLandmarker, FaceLandmarker } from './vendor/vision_bundle.mjs';

/* ============================================================
   鼻部习惯检测器 —— 完全离线，画面只在内存中处理
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* ---------- 面部点位：勾勒鼻子（鼻尖 + 两侧鼻翼 + 鼻孔下缘） ---------- */
const NOSE_IDS = [1, 2, 4, 5, 6, 98, 102, 129, 327, 331, 358];
const NOSE_FALLBACK = [1, 129, 358];
/* ---------- 指尖：食指 / 中指 ---------- */
const TIP_IDS = [8, 12];

const TIERS = {
  saver:     { label: '省电', handMs: 500, faceMs: 4000, boostDiv: 1.6, minGap: 220 },
  balance:   { label: '平衡', handMs: 200, faceMs: 2500, boostDiv: 2.2, minGap: 90  },
  sensitive: { label: '灵敏', handMs: 100, faceMs: 2000, boostDiv: 1.4, minGap: 60  },
};

const STORE_KEY = 'noseHabit.v1';
const DEFAULTS = {
  tier: 'balance', dwell: 800, exitGap: 5000, longWarn: 10000, expand: 1.2,
  sound: true, preview: true, debug: false, idlePause: true, bgKeep: true,
  toastOn: true, voiceOn: true,
  ciMin: 20, ciMax: 50,
  notify: { on: false, provider: 'serverchan', key: '', url: '', onCount: false, onLong: true, onCheckin: false },
};
const IDLE_MS = 5 * 60 * 1000;   // 键鼠闲置多久自动停摄像头

const db = { settings: { ...DEFAULTS }, episodes: [], checkins: [] };

/* ============================ 存储 ============================ */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    db.settings = { ...DEFAULTS, ...(o.settings || {}) };
    db.settings.notify = { ...DEFAULTS.notify, ...((o.settings && o.settings.notify) || {}) };
    db.episodes = Array.isArray(o.episodes) ? o.episodes : [];
    db.checkins = Array.isArray(o.checkins) ? o.checkins : [];
  } catch (e) { console.warn('读取本地数据失败', e); }
}
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1200);
}
function saveNow() {
  try {
    const cap = 40000;
    if (db.episodes.length > cap) db.episodes = db.episodes.slice(-cap);
    if (db.checkins.length > 8000) db.checkins = db.checkins.slice(-8000);
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) { console.warn('保存失败', e); }
}

/* ============================ 工具 ============================ */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
function fmtClock(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function buildNosePoly(lm, W, H, expand) {
  const ids = lm.length > 400 ? NOSE_IDS : NOSE_FALLBACK;
  const pts = [];
  for (const i of ids) {
    const p = lm[i];
    if (p) pts.push({ x: p.x * W, y: p.y * H });
  }
  if (pts.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  // 按极角排序得到凸多边形（鼻部点位天然接近凸形）
  const sorted = pts.slice().sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const poly = sorted.map((p) => ({ x: cx + (p.x - cx) * expand, y: cy + (p.y - cy) * expand }));
  // 面积下限，避免退化多边形误判
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  if (Math.abs(area / 2) < 60) return null;
  return { poly, cx, cy };
}

function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ============================ 状态 ============================ */
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

let handLM = null, faceLM = null, modelsReady = false, modelPromise = null;
let running = false, stream = null, rafId = 0;
let autoStoppedBy = null;      // 'hidden' | 'idle' | 'pause30'
let pauseUntil = 0;

let nose = null;               // {poly, cx, cy}
let noseAt = 0;
let lastFaceAt = 0, lastHandAt = 0, lastHandSeenAt = 0;
let lastHandRes = null;
let ep = null;                 // 当前"一段"摸鼻

const perf = {
  handMsSum: 0, handRuns: 0, faceMsSum: 0, faceRuns: 0,
  handFrames: 0, boostFrames: 0,
  handEmaFps: 0, handEmaMs: 0, faceEmaMs: 0,
  camOnAcc: 0, camOnSince: 0, runMsAcc: 0, detectSince: 0,
};

function setStatus(text, cls) {
  $('statusText').textContent = text;
  const pill = $('statusPill');
  pill.classList.remove('run', 'pause', 'err');
  if (cls) pill.classList.add(cls);
}

/* ============================ 模型 ============================ */
function mkHand(vision, delegate) {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: './vendor/models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
function mkFace(vision, delegate) {
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: './vendor/models/face_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}
async function ensureModels() {
  if (modelsReady) return;
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    setStatus('加载模型…', 'pause');
    const vision = await FilesetResolver.forVisionTasks('./vendor/wasm');
    handLM = await mkHand(vision, 'GPU').catch((e) => { console.warn('手部 GPU 失败，退回 CPU', e); return mkHand(vision, 'CPU'); });
    faceLM = await mkFace(vision, 'GPU').catch((e) => { console.warn('面部 GPU 失败，退回 CPU', e); return mkFace(vision, 'CPU'); });
    modelsReady = true;
  })();
  try { await modelPromise; }
  catch (e) { modelPromise = null; throw e; }
}

/* ============================ 摄像头 ============================ */
function waitVideoReady() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (video.videoWidth > 0 && video.readyState >= 2) return res();
      if (Date.now() - t0 > 8000) return rej(new Error('摄像头没有画面'));
      setTimeout(tick, 60);
    };
    tick();
  });
}
function showCamError(err) {
  const box = $('camError');
  box.style.display = 'block';
  let msg = String((err && err.message) || err);
  if (/NotAllowed|Permission/i.test(msg)) msg = '摄像头权限被拒绝。点地址栏左侧的锁图标 → 摄像头 → 允许，然后刷新。';
  else if (/NotFound|Requested device not found/i.test(msg)) msg = '没找到摄像头设备。';
  else if (/NotReadable|in use/i.test(msg)) msg = '摄像头被其他程序占用（会议软件 / 相机 App）。关掉后再试。';
  box.textContent = '启动失败：' + msg;
  setStatus('启动失败', 'err');
}

async function warmupModels() {
  // 第一次推理要编译着色器、分配显存，实测可能耗时 0.4–2.5 秒（远大于稳定后的 20ms）。
  // 先在正式循环之前跑一遍，避免第一帧被拖慢；顺便把这些耗时从功耗统计里剔掉。
  if (!video.videoWidth) return;
  const t = Math.round(performance.now());
  try { if (handLM) handLM.detectForVideo(video, t); } catch (e) { console.warn('手部模型预热失败', e); }
  try { if (faceLM) faceLM.detectForVideo(video, t + 1); } catch (e) { console.warn('面部模型预热失败', e); }
  perf.handMsSum = 0; perf.faceMsSum = 0; perf.handRuns = 0; perf.faceRuns = 0;
  perf.handFrames = 0; perf.boostFrames = 0;
  perf.handEmaMs = 0; perf.faceEmaMs = 0; perf.handEmaFps = 0;
  perf.runMsAcc = 0; perf.camOnAcc = 0; perf.detectSince = 0; perf.camOnSince = 0;
}

async function start() {
  if (running) return;
  $('camError').style.display = 'none';
  try {
    await ensureModels();
    setStatus('打开摄像头…', 'pause');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' },
    });
    video.srcObject = stream;
    try { await video.play(); } catch (_) {}
    await waitVideoReady();
    setStatus('预热模型…', 'pause');
    await warmupModels();

    running = true;
    autoStoppedBy = null;
    pauseUntil = 0;
    lastHandAt = 0; lastFaceAt = 0; lastHandSeenAt = 0;
    nose = null; noseAt = 0;
    perf.detectSince = performance.now();
    perf.camOnSince = performance.now();

    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    $('btnPause').disabled = false;
    setStatus('哨兵中', 'run');
    clearTimeout(loopTimer);
    scheduleLoop();
  } catch (err) {
    console.error(err);
    showCamError(err);
    stopTracks();
  }
}

function stopTracks() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  video.srcObject = null;
}

function stop(reason) {
  if (!running && !stream) return;
  finalizeEpisode();
  running = false;
  cancelAnimationFrame(rafId);
  clearTimeout(loopTimer);
  stopTracks();
  const now = performance.now();
  if (perf.camOnSince) { perf.camOnAcc += now - perf.camOnSince; perf.camOnSince = 0; }
  if (perf.detectSince) { perf.runMsAcc += now - perf.detectSince; perf.detectSince = 0; }
  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  $('btnPause').disabled = true;
  setStatus(reason || '已停止', 'pause');
  refreshToday();
  refreshDiag();
}

/* ============================ 检测循环 ============================ */
// 用 setTimeout 而不是 requestAnimationFrame：rAF 在标签页切走/窗口被遮挡时会直接暂停，
// 而用户需要“切到别的页面也继续跑”。隐藏时帧率会被浏览器限到 ~1fps（见 bgWatchdog）。
const LOOP_MS_VISIBLE = 25;
const LOOP_MS_HIDDEN = 200;
let loopTimer = 0;
let tickCount = 0;

function scheduleLoop() {
  clearTimeout(loopTimer);
  loopTimer = setTimeout(loop, document.hidden ? LOOP_MS_HIDDEN : LOOP_MS_VISIBLE);
}

function loop() {
  if (!running) return;
  scheduleLoop();
  tickCount++;
  if (video.readyState < 2 || !video.videoWidth) return;

  const now = performance.now();
  const S = db.settings;
  const T = TIERS[S.tier] || TIERS.balance;

  // 一段结束判定
  if (ep && now - ep.lastSeen > S.exitGap) finalizeEpisode();

  const boosted = now - lastHandSeenAt < 2000;
  const handGap = boosted ? Math.max(T.minGap, T.handMs / T.boostDiv) : T.handMs;

  perf.handFrames++;
  if (boosted && lastHandSeenAt) perf.boostFrames++;

  const faceDue = (now - lastFaceAt >= T.faceMs) || (lastHandSeenAt > lastFaceAt && now - lastFaceAt > 400);
  if (faceDue) runFace(now);
  if (now - lastHandAt >= handGap) runHand(now);

  if (S.debug) drawOverlay();
}

function runFace(now) {
  if (!faceLM) return;
  const t0 = performance.now();
  let res;
  try { res = faceLM.detectForVideo(video, now); }
  catch (e) { console.warn('face detect error', e); return; }
  const dt = performance.now() - t0;
  perf.faceMsSum += dt; perf.faceRuns++;
  perf.faceEmaMs = perf.faceEmaMs ? perf.faceEmaMs * 0.8 + dt * 0.2 : dt;
  lastFaceAt = now;

  const lm = res && res.faceLandmarks && res.faceLandmarks[0];
  if (lm) {
    nose = buildNosePoly(lm, video.videoWidth, video.videoHeight, db.settings.expand);
    noseAt = now;
  } else {
    nose = null;
  }
}

function runHand(now) {
  if (!handLM) return;
  const t0 = performance.now();
  let res;
  try { res = handLM.detectForVideo(video, now); }
  catch (e) { console.warn('hand detect error', e); return; }
  const dt = performance.now() - t0;

  const gap = lastHandAt ? now - lastHandAt : 0;
  perf.handMsSum += dt; perf.handRuns++;
  perf.handEmaMs = perf.handEmaMs ? perf.handEmaMs * 0.8 + dt * 0.2 : dt;
  if (gap > 0) {
    const fps = 1000 / gap;
    perf.handEmaFps = perf.handEmaFps ? perf.handEmaFps * 0.85 + fps * 0.15 : fps;
  }
  lastHandAt = now;

  const W = video.videoWidth, H = video.videoHeight;
  const landmarks = (res && res.landmarks) || [];
  lastHandRes = landmarks;

  let touching = false;
  if (landmarks.length) {
    lastHandSeenAt = now;
    const poly = nose && nose.poly;
    if (poly) {
      outer:
      for (const hand of landmarks) {
        for (const id of TIP_IDS) {
          const p = hand[id];
          if (!p) continue;
          if (pointInPoly(p.x * W, p.y * H, poly)) { touching = true; break outer; }
        }
      }
    }
  }
  handleTouch(touching, now);
}

/* ============================ 一段的判定 ============================ */
function handleTouch(touching, now) {
  const S = db.settings;
  if (!touching) return;

  if (!ep) ep = { start: now, lastSeen: now, counted: false, longWarned: false, rec: null };
  ep.lastSeen = now;

  const dur = now - ep.start;

  if (!ep.counted && dur >= S.dwell) {
    ep.counted = true;
    const startedAt = Date.now() - dur;
    const rec = { t: Math.round(startedAt), d: 0 };
    ep.rec = rec;
    db.episodes.push(rec);
    flash('short'); beep(1);
    if (db.settings.notify.onCount) sendNotify(`摸鼻子 +1（${new Date().toLocaleTimeString('zh-CN')}）`, false);
    saveSoon(); refreshToday();
  }

  if (ep.rec) ep.rec.d = Math.round(((ep.lastSeen - ep.start) / 1000) * 10) / 10;

  if (ep.counted && !ep.longWarned && dur >= S.longWarn) {
    ep.longWarned = true;
    flash('long'); beep(2);
    toast(`已经 ${fmtDur(dur / 1000)} 了 —— 手放下吧`);
    // 系统级提醒：页面在前台时它是 redundant 的，但切走/最小化时只有它能让你看见、听见
    sysToast(`已经 ${fmtDur(dur / 1000)} 了 —— 手放下吧`, { scenario: 'urgent' });
    sysVoice('手放下吧');
    if (db.settings.notify.onLong && Date.now() - notifyLastLong > 30000) {
      notifyLastLong = Date.now();
      sendNotify(`手在鼻子那儿已经 ${fmtDur(dur / 1000)} 了，放下吧`, false);
    }
  }

  // 更久还不放：再催一次（只催一次，避免反复叫人）
  if (ep.counted && !ep.midWarned && dur >= Math.max(30000, S.longWarn * 3)) {
    ep.midWarned = true;
    flash('long');
    sysToast(`还在摸鼻子，已经 ${fmtDur(dur / 1000)}`, { scenario: 'urgent', title: '还在摸鼻子' });
    sysVoice('还在摸鼻子，把手拿开');
  }
}

function finalizeEpisode() {
  if (!ep) return;
  if (ep.rec) {
    ep.rec.d = Math.max(0, Math.round(((ep.lastSeen - ep.start) / 1000) * 10) / 10);
    saveSoon();
  }
  ep = null;
  refreshToday();
}

/* ============================ 微信 / 手机提醒 ============================ */
// 浏览器直连企业微信、Server酱、PushPlus 会被 CORS 拦住，所以统一交给本地服务代发（/api/notify）。
// key 只存在本机 localStorage，也只交给本机服务。
let notifyLastLong = 0;

function notifyCfg() { return (db.settings && db.settings.notify) || DEFAULTS.notify; }

function buildNotifyReq(text) {
  const n = notifyCfg();
  const key = (n.key || '').trim();
  if (!key) return null;
  const title = '鼻部提醒';
  if (n.provider === 'serverchan') {
    const u = /^https?:/i.test(key) ? key : `https://sctapi.ftqq.com/${key}.send`;
    return {
      url: u,
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(text)}`,
    };
  }
  if (n.provider === 'pushplus') {
    return {
      url: 'https://www.pushplus.plus/send',
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ token: key, title, content: text, template: 'txt' }),
    };
  }
  if (n.provider === 'wxwork') {
    const u = /^https?:/i.test(key) ? key : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
    return {
      url: u,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    };
  }
  // custom：直接给一个能接 POST JSON 的 URL
  return {
    url: /^https?:/i.test(key) ? key : `http://${key}`,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ title, text, at: new Date().toISOString() }),
  };
}

async function sendNotify(text, force) {
  const n = notifyCfg();
  if (!n.on && !force) return { ok: false, skipped: true };
  const req = buildNotifyReq(text);
  if (!req) return { ok: false, skipped: true, error: '没填 key' };
  try {
    const r = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const j = await r.json();
    return j;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function bindNotify() {
  const n = notifyCfg();
  const prov = $('notiProv'), key = $('notiKey'), st = $('notiStatus');
  if (!prov) return;
  prov.value = n.provider;
  key.value = n.key || '';
  $('notiOn').checked = !!n.on;
  $('notiCount').checked = !!n.onCount;
  $('notiLong').checked = !!n.onLong;
  $('notiCheckin').checked = !!n.onCheckin;

  const save = () => { db.settings.notify = { ...notifyCfg(), provider: prov.value, key: key.value.trim() }; saveSoon(); };
  prov.addEventListener('change', () => { save(); updateNotiHint(); });
  key.addEventListener('input', save);
  $('notiOn').addEventListener('change', (e) => { db.settings.notify = { ...notifyCfg(), on: e.target.checked }; saveSoon(); });
  $('notiCount').addEventListener('change', (e) => { db.settings.notify = { ...notifyCfg(), onCount: e.target.checked }; saveSoon(); });
  $('notiLong').addEventListener('change', (e) => { db.settings.notify = { ...notifyCfg(), onLong: e.target.checked }; saveSoon(); });
  $('notiCheckin').addEventListener('change', (e) => { db.settings.notify = { ...notifyCfg(), onCheckin: e.target.checked }; saveSoon(); });
  $('notiTest').addEventListener('click', async () => {
    st.textContent = '发送中…';
    st.className = 'hint';
    const r = await sendNotify(`测试消息 · ${new Date().toLocaleString('zh-CN')}`, true);
    if (r && r.ok) {
      st.textContent = `已发出（HTTP ${r.status}）${r.resp ? '：' + String(r.resp).slice(0, 120) : ''}`;
      st.className = 'hint ok';
    } else {
      st.textContent = `失败：${(r && (r.error || r.resp)) || '未知错误'}`;
      st.className = 'hint bad';
    }
  });
  updateNotiHint();
}

function bindSys() {
  const st = $('sysStatus'), t = $('chkToast'), v = $('chkVoice'), b = $('btnTestSys');
  if (!t || !v || !b) return;
  t.checked = !!db.settings.toastOn;
  v.checked = !!db.settings.voiceOn;
  t.addEventListener('change', () => { db.settings.toastOn = t.checked; saveSoon(); });
  v.addEventListener('change', () => { db.settings.voiceOn = v.checked; saveSoon(); });
  b.addEventListener('click', async () => {
    st.textContent = '发送中…';
    st.className = 'hint';
    const r1 = await postLocal('/api/toast', { title: '鼻部提醒', text: '这是一条测试通知，能在通知中心看到就说明通了', scenario: 'default' });
    const r2 = await postLocal('/api/voice', { text: '这是一条测试语音' });
    const parts = [
      r1 && r1.ok ? '通知已发出' : `通知失败：${(r1 && r1.error) || '未知'}`,
      r2 && r2.ok ? '语音已播放' : `语音失败：${(r2 && r2.error) || '未知'}`,
    ];
    st.textContent = parts.join('；');
    st.className = 'hint ' + (r1 && r1.ok && r2 && r2.ok ? 'ok' : 'bad');
  });
}

function updateNotiHint() {
  const el = $('notiKeyHint');
  if (!el) return;
  const p = $('notiProv').value;
  el.textContent = {
    serverchan: 'Server酱 SendKey（去 sct.ftqq.com 用微信扫码登录拿，形如 SCTxxxxx）',
    pushplus: 'PushPlus token（去 pushplus.plus 微信扫码登录拿，形如 32 位字符）',
    wxwork: '企业微信群机器人 webhook 地址，或只填 ?key= 后面那串',
    custom: '任意能收 POST JSON 的地址，如 http://192.168.1.10:8000/notify',
  }[p] || '';
}

/* ============================ 系统提醒（Windows 通知 / 语音） ============================ */
// 为什么不直接用页面内的 new Notification()：本机 Chrome 的通知在 Windows 层是关着的
// （HKCU\...\Notifications\Settings\Chrome 的 Enabled=0），那样会静默失败——代码不报错，人也看不到。
// 所以改成调本机服务（start.ps1 里的 /api/toast、/api/voice），由它调 Windows 通知中心和 SAPI。
// 好处：不需要网页通知授权、不受 Chrome 通知开关影响、切窗口/最小化都看得到。
async function postLocal(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, status: r.status, error: j.error || '' };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}
function sysToast(text, opts = {}) {
  if (!db.settings.toastOn) return Promise.resolve(null);
  return postLocal('/api/toast', {
    title: opts.title || '鼻部提醒',
    text,
    scenario: opts.scenario || 'default',
  });
}
function sysVoice(text, opts = {}) {
  if (!db.settings.voiceOn) return Promise.resolve(null);
  return postLocal('/api/voice', { text, rate: opts.rate || 0, volume: opts.volume || 100 });
}

/* ============================ 反馈 ============================ */
let flashTimer = null;
function flash(kind) {
  const el = $('flash');
  el.classList.remove('on', 'long');
  void el.offsetWidth;
  el.classList.add('on');
  if (kind === 'long') el.classList.add('long');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('on', 'long'), kind === 'long' ? 900 : 650);
}

let actx = null;
function beep(n) {
  if (!db.settings.sound) return;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const mk = (freq, at, dur, gain) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(gain, t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.start(t + at); o.stop(t + at + dur + 0.03);
    };
    if (n === 1) mk(880, 0, 0.15, 0.05);
    else { mk(640, 0, 0.12, 0.06); mk(520, 0.15, 0.18, 0.06); }
  } catch (_) {}
}

/* ============================ 画调试标注 ============================ */
function drawOverlay() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return;
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  octx.clearRect(0, 0, W, H);

  if (nose && nose.poly) {
    octx.beginPath();
    nose.poly.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
    octx.closePath();
    octx.strokeStyle = 'rgba(78,161,255,.95)';
    octx.lineWidth = Math.max(2, W / 320);
    octx.stroke();
    octx.fillStyle = 'rgba(78,161,255,.12)';
    octx.fill();
  }

  const hands = lastHandRes || [];
  for (const hand of hands) {
    for (const id of TIP_IDS) {
      const p = hand[id];
      if (!p) continue;
      const x = p.x * W, y = p.y * H;
      const hit = nose && nose.poly && pointInPoly(x, y, nose.poly);
      octx.beginPath();
      octx.arc(x, y, Math.max(5, W / 90), 0, Math.PI * 2);
      octx.fillStyle = hit ? 'rgba(63,185,80,.95)' : 'rgba(255,92,92,.9)';
      octx.fill();
    }
  }
}

/* ============================ 今日 / 统计 ============================ */
function todayEpisodes() {
  const k = dayKey(Date.now());
  return db.episodes.filter((e) => dayKey(e.t) === k);
}

function refreshToday() {
  const list = todayEpisodes();
  const count = list.length;
  const total = list.reduce((s, e) => s + (e.d || 0), 0);
  $('bigCount').textContent = count;
  $('bigTime').textContent = fmtDur(total);
  document.title = (count ? `(${count}) ` : '') + '鼻部习惯检测器';
  renderStats();
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function longestGapSec() {
  const list = todayEpisodes().slice().sort((a, b) => a.t - b.t);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const marks = [dayStart.getTime(), ...list.flatMap((e) => [e.t, e.t + (e.d || 0) * 1000]), Date.now()];
  let best = 0;
  for (let i = 1; i < marks.length; i += 2) {
    best = Math.max(best, (marks[i] - marks[i - 1]) / 1000);
  }
  return best;
}

function renderStats() {
  const list = todayEpisodes();
  $('sCount').textContent = list.length;
  $('sTotal').textContent = fmtDur(list.reduce((s, e) => s + (e.d || 0), 0));
  const med = median(list.map((e) => e.d || 0));
  $('sMedian').textContent = list.length ? fmtDur(med) : '—';
  const gap = longestGapSec();
  $('sLongest').textContent = list.length ? fmtDur(gap) : '—';

  // 每小时
  const hours = new Array(24).fill(0);
  for (const e of list) hours[new Date(e.t).getHours()]++;
  const hMax = Math.max(1, ...hours);
  const hc = $('hourChart');
  hc.innerHTML = '';
  hours.forEach((v, h) => {
    const d = document.createElement('div');
    d.className = 'b' + (v ? ' has' : '') + (v && v >= hMax * 0.75 && v > 0 ? ' tall' : '');
    d.style.height = Math.max(2, (v / hMax) * 100) + '%';
    d.title = `${h}:00 — ${v} 次`;
    hc.appendChild(d);
  });

  // 最近 7 天
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
    const k = dayKey(d.getTime());
    days.push({ k, n: db.episodes.filter((e) => dayKey(e.t) === k).length, d });
  }
  const wMax = Math.max(1, ...days.map((x) => x.n));
  const wc = $('weekChart');
  wc.innerHTML = '';
  for (const x of days) {
    const d = document.createElement('div');
    d.className = 'b' + (x.n ? ' has' : '');
    d.style.height = Math.max(2, (x.n / wMax) * 100) + '%';
    d.title = `${x.k} — ${x.n} 次`;
    wc.appendChild(d);
  }
  const labels = $('weekLabels');
  labels.innerHTML = '';
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  for (const x of days) {
    const s = document.createElement('span');
    s.textContent = wd[x.d.getDay()] + ' ' + x.n;
    labels.appendChild(s);
  }
}

/* ============================ 打卡 ============================ */
let ciTimer = null, ciNextAt = 0, ciPending = false, ciTick = null;

function scheduleCheckin() {
  clearTimeout(ciTimer);
  const mn = Math.min(db.settings.ciMin, db.settings.ciMax);
  const mx = Math.max(db.settings.ciMin, db.settings.ciMax);
  const mins = mn + Math.random() * Math.max(0.5, mx - mn);
  ciNextAt = Date.now() + mins * 60000;
  ciPending = false;
  renderCi();
  ciTimer = setTimeout(() => { ciPending = true; renderCi(); fireNotify(); }, mins * 60000);
  if (!ciTick) ciTick = setInterval(renderCi, 1000);
}

function fireNotify() {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('手现在在哪？', { body: '点一下记录，别让它悄悄发生', tag: 'nose-checkin' });
    }
  } catch (_) {}
}

function renderCi() {
  const cd = $('ciCard');
  $('ciIdle').innerHTML = ciPending ? '现在就记录一下 ↓' : `下一次提醒：<b>${ciNextAt ? fmtLeft(ciNextAt) : '—'}</b>`;
  cd.style.borderColor = ciPending ? 'rgba(78,161,255,.6)' : 'var(--line)';
  cd.style.boxShadow = ciPending ? '0 0 0 3px rgba(78,161,255,.10)' : 'none';
  renderCiLog();
}
function fmtLeft(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}
function logCheckin(on) {
  db.checkins.push({ t: Date.now(), on: !!on });
  saveSoon();
  if (db.settings.notify.onCheckin) {
    sendNotify(`打卡：${on ? '脸上没摸' : '刚才在摸'}\n今天已记 ${todayEpisodes().length} 次`, false);
  }
  if (ciPending) scheduleCheckin(); else renderCiLog();
}
function renderCiLog() {
  const box = $('ciLog');
  box.innerHTML = '';
  const rows = db.checkins.slice(-25).reverse();
  if (!rows.length) { box.innerHTML = '<div style="border:0;color:var(--dim2)">还没有记录</div>'; return; }
  for (const c of rows) {
    const div = document.createElement('div');
    div.innerHTML = `<span>${dayKey(c.t).slice(5)} ${fmtClock(c.t)}</span><b style="color:${c.on ? 'var(--warn)' : 'var(--ok)'}">${c.on ? '在脸上' : '不在'}</b>`;
    box.appendChild(div);
  }
}

/* ============================ 导出 / 清空 ============================ */
function download(name, text, mime, bom = true) {
  const body = bom ? '\ufeff' + text : text;
  const blob = new Blob([body], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportCsv() {
  const rows = [['type', 'start_iso', 'date', 'hour', 'duration_s']];
  for (const e of db.episodes) {
    const d = new Date(e.t);
    rows.push(['touch', d.toISOString(), dayKey(e.t), d.getHours(), e.d]);
  }
  for (const c of db.checkins) {
    const d = new Date(c.t);
    rows.push([c.on ? 'checkin_on_face' : 'checkin_not_on_face', d.toISOString(), dayKey(c.t), d.getHours(), '']);
  }
  download(`nose-habit-${dayKey(Date.now())}.csv`, rows.map((r) => r.join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}

/* ============================ 诊断 ============================ */
function refreshDiag() {
  const now = performance.now();
  const camMs = perf.camOnAcc + (perf.camOnSince ? now - perf.camOnSince : 0);
  const runMs = perf.runMsAcc + (perf.detectSince ? now - perf.detectSince : 0);
  $('dFps').textContent = perf.handEmaFps ? perf.handEmaFps.toFixed(1) + ' fps' : '—';
  $('dHand').textContent = perf.handEmaMs ? perf.handEmaMs.toFixed(1) + ' ms' : '—';
  $('dFace').textContent = perf.faceEmaMs ? perf.faceEmaMs.toFixed(1) + ' ms' : '—';
  $('dBoost').textContent = perf.handFrames ? Math.round((perf.boostFrames / perf.handFrames) * 100) + '%' : '—';
  $('dCam').textContent = fmtDur(camMs / 1000);
  $('dCpu').textContent = runMs > 2000 ? ((perf.handMsSum + perf.faceMsSum) / runMs * 100).toFixed(1) + '%' : '—';
}

/* ============================ 事件绑定 ============================ */
let lastActivity = Date.now();
function markActivity() { lastActivity = Date.now(); }

function bind() {
  bindNotify();
  bindSys();
  // 标签页
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      const p = btn.dataset.panel;
      document.querySelectorAll('.panel').forEach((s) => s.classList.toggle('active', s.id === 'panel' + p[0].toUpperCase() + p.slice(1)));
      if (p === 'checkin') { if (!ciTick) scheduleCheckin(); renderCi(); }
      if (p === 'stats') renderStats();
    });
  });

  $('btnStart').addEventListener('click', () => { markActivity(); start(); });
  $('btnStop').addEventListener('click', () => { markActivity(); autoStoppedBy = null; stop('已停止'); });
  $('btnPause').addEventListener('click', () => {
    pauseUntil = Date.now() + 30 * 60 * 1000;
    autoStoppedBy = 'pause30';
    stop('已暂停 30 分钟');
    toast('30 分钟内不再启动（再点「启动检测」可提前恢复）');
  });

  // 参数
  const bindNum = (id, key, min, max) => {
    const elx = $(id);
    elx.value = db.settings[key];
    elx.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(elx.value) || DEFAULTS[key]));
      elx.value = v; db.settings[key] = v; saveSoon();
    });
  };
  bindNum('inpDwell', 'dwell', 200, 5000);
  bindNum('inpExit', 'exitGap', 1000, 60000);
  bindNum('inpLong', 'longWarn', 3000, 120000);
  bindNum('inpExpand', 'expand', 0.8, 2);
  bindNum('ciMin', 'ciMin', 1, 240);
  bindNum('ciMax', 'ciMax', 1, 240);

  $('tierSel').value = db.settings.tier;
  $('tierSel').addEventListener('change', () => { db.settings.tier = $('tierSel').value; saveSoon(); });

  const chk = (id, key, after) => {
    const c = $(id);
    c.checked = !!db.settings[key];
    c.addEventListener('change', () => { db.settings[key] = c.checked; saveSoon(); after && after(c.checked); });
  };
  chk('chkSound', 'sound');
  chk('chkPreview', 'preview', (on) => { $('previewWrap').classList.toggle('hidden', !on); });
  chk('chkDebug', 'debug', () => { if (!db.settings.debug) octx.clearRect(0, 0, overlay.width, overlay.height); });
  chk('chkIdle', 'idlePause');
  chk('chkBg', 'bgKeep', () => {
    $('chkBg') && ($('chkBg').checked = db.settings.bgKeep);
    if (!db.settings.bgKeep && running && document.hidden) { autoStoppedBy = 'hidden'; stop('页面切走了'); }
  });

  // 打卡
  $('btnOnFace').addEventListener('click', () => { logCheckin(true); });
  $('btnNotFace').addEventListener('click', () => { logCheckin(false); });
  $('btnCiNow').addEventListener('click', () => { ciPending = true; renderCi(); fireNotify(); });
  $('btnNotify').addEventListener('click', async () => {
    if (!('Notification' in window)) return toast('这个浏览器不支持通知');
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? '已允许，提醒会弹通知' : '没有拿到通知权限');
  });

  // 数据
  $('btnExport').addEventListener('click', exportCsv);
  $('btnExportJson').addEventListener('click', () => download(`nose-habit-${dayKey(Date.now())}.json`, JSON.stringify(db, null, 2), 'application/json;charset=utf-8', false));
  $('btnClear').addEventListener('click', () => {
    if (!confirm('清空全部记录？这是不可撤销的。建议先导出 CSV。')) return;
    db.episodes = []; db.checkins = [];
    saveNow(); refreshToday(); renderCiLog(); toast('已清空');
  });

  // 活动检测 / 自动省电
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'].forEach((ev) =>
    document.addEventListener(ev, () => {
      markActivity();
      if (!running && autoStoppedBy === 'idle' && document.visibilityState === 'visible') {
        autoStoppedBy = null; start();
      }
      if (autoStoppedBy === 'pause30' && Date.now() > pauseUntil) { autoStoppedBy = null; start(); }
    }, { passive: true })
  );

  let bgTickRef = 0, bgTickAt = 0, bgWarnedAt = 0;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (running && !db.settings.bgKeep) {
        autoStoppedBy = 'hidden';
        stop('页面切走了');
      } else if (running) {
        setStatus('后台检测中', 'run');
        bgTickRef = tickCount;
        bgTickAt = Date.now();
      }
    } else {
      markActivity();
      bgWarnedAt = 0;
      if (autoStoppedBy === 'hidden') { autoStoppedBy = null; start(); }
      else if (running) setStatus('哨兵中', 'run');
    }
  });

  // 后台帧率看门狗：Chrome 会把隐藏页的定时器限到 1 次/秒，5 分钟后可能变 1 次/分钟。
  // 实测不行就明确说出来，别让用户以为在检测其实已经死了。
  setInterval(() => {
    if (!running || !document.hidden) return;
    const now = Date.now();
    const dt = now - bgTickAt;
    if (bgTickAt && dt >= 3000) {
      const fps = ((tickCount - bgTickRef) * 1000) / dt;
      bgTickRef = tickCount; bgTickAt = now;
      if (fps < 0.9 && now - bgWarnedAt > 5 * 60 * 1000) {
        bgWarnedAt = now;
        setStatus('后台被限速 ' + fps.toFixed(1) + 'fps', 'pause');
        toast('浏览器把后台页限速到 ' + fps.toFixed(1) + ' 帧/秒，长时间动作能抓，短动作会漏。想要全速后台请用 start.bat 打开的专用窗口。', 6000);
      } else if (fps >= 0.9) {
        setStatus('后台检测中 ' + Math.round(fps) + 'fps', 'run');
      }
    }
  }, 3000);

  setInterval(() => {
    // 本次时长
    if (ep && running) {
      const s = (performance.now() - ep.start) / 1000;
      $('epTimer').textContent = fmtDur(s);
    } else {
      $('epTimer').textContent = '—';
    }
    // 闲置暂停
    if (running && db.settings.idlePause && Date.now() - lastActivity > IDLE_MS) {
      autoStoppedBy = 'idle';
      stop('闲置暂停');
      toast('键鼠 5 分钟没动，摄像头已关闭。动一下鼠标自动恢复。', 3200);
    }
    // 30 分钟暂停到期
    if (!running && autoStoppedBy === 'pause30' && Date.now() > pauseUntil) {
      autoStoppedBy = null;
      if (document.visibilityState === 'visible') start();
    }
    refreshDiag();
    if (ciTick && ciPending) renderCi();
  }, 1000);

  window.addEventListener('beforeunload', () => { finalizeEpisode(); saveNow(); });
}

/* ============================ 启动 ============================ */
loadStore();
bind();
$('previewWrap').classList.toggle('hidden', !db.settings.preview);
refreshToday();
renderCiLog();
if (!ciTick) scheduleCheckin();
setStatus('未启动');
console.log('[nose-habit] ready, tier =', db.settings.tier);

// 供自动化测试/手柄调试用：直接驱动判定状态机，不需要真实摄像头。
// 正常使用不会调用它，也不改变任何行为。
window.__nose = {
  touch: (on) => handleTouch(!!on, performance.now()),
  finalize: () => finalizeEpisode(),
  state: () => ({ running, ticks: tickCount, hidden: document.hidden, handRuns: perf.handRuns, faceRuns: perf.faceRuns, handEmaFps: perf.handEmaFps, videoTime: video.currentTime, readyState: video.readyState, episodes: db.episodes.length, ep: ep ? { dur: ep.lastSeen - ep.start, counted: ep.counted, warned: ep.longWarned } : null, settings: { ...db.settings } }),
  set: (patch) => { Object.assign(db.settings, patch); },
  toast: (t, o) => sysToast(t, o || { scenario: 'urgent' }),
  voice: (t) => sysVoice(t),
  data: () => JSON.parse(JSON.stringify(db)),
};
