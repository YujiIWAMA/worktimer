// Cloudflare Pages Functions
//   GET  /api/state   -> { db }              サーバー上の全データを返す
//   PUT  /api/state   -> { ok } | 409 { db } アプリからの全データ保存（新しいほうが勝つ）
//   POST /api/event   -> Watchのショートカット用 { action:'work'|'break'|'stop', label? }
//
// 必要な設定（Cloudflare Pagesのダッシュボード）
//   ・KV namespace のバインド名: WORKLOG
//   ・環境変数（シークレット）: TOKEN

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

const emptyDb = () => ({ sessions: [], current: null, settings: { work: 30, break: 5, notify: false }, updatedAt: 0 });

const t0 = x => x.blockStart || x.start;

/* アプリ側 startWork / startBreak / stopAll と同じ動き */
function apply(db, action, label, now) {
  const s = db.settings || { work: 30, break: 5 };
  const cur = db.current;
  const close = () => {
    const c = db.current;
    if (!c) return;
    if (now - c.start >= 1000) {
      db.sessions.push({
        id: now.toString(36) + Math.random().toString(36).slice(2, 6),
        type: c.type, label: c.label || '', start: c.start, end: now,
        planned: c.planned, note: c.note || ''
      });
    }
    db.current = null;
  };

  if (action === 'work') {
    if (cur && cur.type === 'work' && cur.label === label) return { changed: false, startTimer: false };
    if (cur && cur.type === 'work') {
      // 作業中のラベル切替：区間は分けるがタイマーは続ける
      const keep = { planned: cur.planned, notified: cur.notified, blockStart: t0(cur) };
      close();
      db.current = { type: 'work', label, start: now, note: '', ...keep };
      db.updatedAt = now;
      return { changed: true, startTimer: false };
    }
    close();
    db.current = { type: 'work', label, start: now, blockStart: now, planned: s.work || 30, notified: false, note: '' };
    db.updatedAt = now;
    return { changed: true, startTimer: true };
  }
  if (action === 'break') {
    if (cur && cur.type === 'break') return { changed: false, startTimer: false };
    close();
    db.current = { type: 'break', label: '', start: now, blockStart: now, planned: s.break || 5, notified: false, note: '' };
    db.updatedAt = now;
    return { changed: true, startTimer: true };
  }
  // stop
  if (!cur) return { changed: false, startTimer: false };
  close();
  db.updatedAt = now;
  return { changed: true, startTimer: false };
}

function remainingMin(c, now) {
  if (!c || !c.planned) return 0;
  const rem = t0(c) + c.planned * 60000 - now;
  return rem > 0 ? Math.max(1, Math.ceil(rem / 60000)) : 0;
}

export async function onRequest({ request, env, params }) {
  if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
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
      if (!incoming || !Array.isArray(incoming.sessions) || typeof incoming.updatedAt !== 'number') {
        return json({ error: 'bad shape' }, 400);
      }
      const stored = await env.WORKLOG.get(KEY, 'json');
      if (stored && (stored.updatedAt || 0) > incoming.updatedAt) return json({ db: stored }, 409);
      await env.WORKLOG.put(KEY, JSON.stringify(incoming));
      return json({ ok: true, updatedAt: incoming.updatedAt });
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

    const db = (await env.WORKLOG.get(KEY, 'json')) || emptyDb();
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
