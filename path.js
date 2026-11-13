// Cloudflare Pages Functions
//   GET  /api/state   -> { db }              サーバー上の全データを返す
//   PUT  /api/state   -> { ok, db }          端末の記録を「足し合わせて」保存し、結果を返す
//   POST /api/event   -> Watch/ショートカット用 { action:'work'|'break'|'stop', label? }
//
// 必要な設定（Cloudflare Pagesのダッシュボード）
//   ・KV namespace のバインド名: WORKLOG
//   ・環境変数（シークレット）: TOKEN
//
// 記録は「上書き」ではなく「統合(merge)」で保存する。
//   ・区間(sessions)はIDごとの和集合。同じIDなら mt（更新時刻）が新しいほうを採用
//   ・削除は deleted にIDを残す（古い端末が消した記録を復活させない）
//   ・進行中の記録(current)は currentMt が新しいほうを採用
// これにより、画面が古いままの端末が保存しても、新しい記録は消えない。

const LABELS = ['研究', '授業準備', 'その他'];
const KEY = 'db';
const MAX_BYTES = 5 * 1024 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authed(request, env) {
  const h = request.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return !!(env.TOKEN && t && safeEqual(t, String(env.TOKEN)));
}

const newId = now => now.toString(36) + Math.random().toString(36).slice(2, 6);
const t0 = x => x.blockStart || x.start;

function normDb(d) {
  d = d || {};
  return {
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    current: d.current || null,
    deleted: d.deleted || {},
    settings: Object.assign({ work: 30, break: 5, notify: false }, d.settings),
    currentMt: d.currentMt || (d.current ? d.current.start : 0),
    updatedAt: d.updatedAt || 0
  };
}

function mergeDb(x, y) {
  const a = normDb(x), b = normDb(y);
  const deleted = {};
  for (const src of [a.deleted, b.deleted]) {
    for (const k of Object.keys(src)) deleted[k] = Math.max(deleted[k] || 0, src[k] || 0);
  }
  const map = new Map();
  for (const s of a.sessions.concat(b.sessions)) {
    if (!s || !s.id || deleted[s.id]) continue;
    const prev = map.get(s.id);
    if (!prev || (s.mt || s.end || 0) > (prev.mt || prev.end || 0)) map.set(s.id, s);
  }
  const sessions = [...map.values()].sort((p, q) => p.start - q.start || String(p.id).localeCompare(String(q.id)));
  let current = (a.currentMt >= b.currentMt ? a : b).current;
  if (current && (deleted[current.id] || map.has(current.id))) current = null;   // 削除済み／すでに閉じた記録
  return {
    sessions, current, deleted,
    settings: Object.assign({}, (a.updatedAt >= b.updatedAt ? a : b).settings),
    currentMt: Math.max(a.currentMt, b.currentMt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt)
  };
}

/* アプリ側 startWork / startBreak / stopAll と同じ動き */
function apply(db, action, label, now) {
  const s = db.settings || { work: 30, break: 5 };
  const cur = db.current;
  const close = () => {
    const c = db.current;
    if (!c) return;
    if (now - c.start >= 1000) {
      db.sessions.push({
        id: c.id || newId(now),
        type: c.type, label: c.label || '', start: c.start, end: now,
        planned: c.planned, note: c.note || '', mt: now
      });
    } else if (c.id) {
      db.deleted[c.id] = now;
    }
    db.current = null;
  };
  const done = (changed, startTimer) => {
    if (changed) { db.currentMt = now; db.updatedAt = now; }
    return { changed, startTimer };
  };

  if (action === 'work') {
    if (cur && cur.type === 'work' && cur.label === label) return done(false, false);
    if (cur && cur.type === 'work') {
      // 作業中のラベル切替：区間は分けるがタイマーは続ける
      const keep = { planned: cur.planned, notified: cur.notified, blockStart: t0(cur) };
      close();
      db.current = { id: newId(now), type: 'work', label, start: now, note: '', ...keep };
      return done(true, false);
    }
    close();
    db.current = { id: newId(now), type: 'work', label, start: now, blockStart: now, planned: s.work || 30, notified: false, note: '' };
    return done(true, true);
  }
  if (action === 'break') {
    if (cur && cur.type === 'break') return done(false, false);
    close();
    db.current = { id: newId(now), type: 'break', label: '', start: now, blockStart: now, planned: s.break || 5, notified: false, note: '' };
    return done(true, true);
  }
  // stop
  if (!cur) return done(false, false);
  close();
  return done(true, false);
}

function remainingMin(c, now) {
  if (!c || !c.planned) return 0;
  const rem = t0(c) + c.planned * 60000 - now;
  return rem > 0 ? Math.max(1, Math.ceil(rem / 60000)) : 0;
}

export async function onRequest({ request, env, params }) {
  if (!authed(request, env)) {
    // 原因の切り分け用：サーバーにTOKENがあるか、クライアントが何文字送ってきたか（秘密の値自体は返さない）
    const h = request.headers.get('Authorization') || '';
    const sent = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    return json({ error: 'unauthorized', tokenConfigured: !!env.TOKEN, sentLength: sent.length }, 401);
  }
  if (!env.WORKLOG) return json({ error: 'KV binding WORKLOG is missing' }, 500);

  const route = (Array.isArray(params.path) ? params.path.join('/') : params.path) || '';

  if (route === 'state') {
    if (request.method === 'GET') {
      const db = await env.WORKLOG.get(KEY, 'json');
      return json({ db: db || null });
    }
    if (request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: 'too large' }, 413);
      let incoming;
      try { incoming = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!incoming || !Array.isArray(incoming.sessions)) return json({ error: 'bad shape' }, 400);
      const stored = await env.WORKLOG.get(KEY, 'json');
      const merged = mergeDb(stored, incoming);
      await env.WORKLOG.put(KEY, JSON.stringify(merged));
      return json({ ok: true, db: merged });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  if (route === 'event') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    let body = {};
    try { body = await request.json(); } catch (e) { /* クエリで指定してもよい */ }
    const q = new URL(request.url).searchParams;
    const action = String(body.action || q.get('action') || '').trim();
    const label = String(body.label || q.get('label') || '').trim();

    if (!['work', 'break', 'stop'].includes(action)) {
      return json({ error: 'action must be work | break | stop' }, 400);
    }
    if (action === 'work' && !LABELS.includes(label)) {
      return json({ error: 'label must be one of: ' + LABELS.join(', ') }, 400);
    }

    const db = normDb(await env.WORKLOG.get(KEY, 'json'));
    const now = Date.now();
    const r = apply(db, action, label, now);
    if (r.changed) await env.WORKLOG.put(KEY, JSON.stringify(db));

    const c = db.current;
    const state = !c ? 'stopped' : c.type;
    const timerMin = r.startTimer ? remainingMin(c, now) : 0;
    const message = !c ? '停止しました'
      : c.type === 'break' ? '休憩' + (r.changed ? 'を開始' : '中')
      : c.label + (r.changed ? 'を開始' : '（変更なし）');
    return json({ ok: true, changed: r.changed, state, label: c ? c.label : '', timerMin, message });
  }

  return json({ error: 'not found' }, 404);
}
