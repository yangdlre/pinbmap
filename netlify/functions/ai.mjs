// 핀볼 지도 — 🎤 말로 찾기 AI 연결
// 운영자 공용 키는 없음. 각자 자기 AI 키를 "내 계정"에 묶어 서버에 암호화 저장하고, 키는 다시 내려보내지 않음.
// POST {email, token, action, model?, ...}
//   status                         → {keys:{gemini:{tail,at}|null, groq:…}, today, cap}
//   setkey {prov, key}             → 공급자에 키 확인(모델 목록 조회 — 사용량 안 씀) 뒤 저장
//   delkey {prov}
//   ask  {text, ctx}               → {cmd, model, ms}            ② 브라우저 받아쓰기 + AI 해석
//   hear {audio(base64), mime, ctx, stt?} → {heard, cmd, model, ms}   ③ AI가 녹음을 직접 듣고 해석 (stt:1 = 받아쓰기만, 실험실 비교용)
// AI에는 문장(또는 녹음)과 화면의 장소 "이름"만 보냄 — 좌표·주소·개인 일정 세부는 안 보냄.
// 무료 모델만 부름. 하루 상한(CAP, 앱 요청 기준)을 넘거나 공급자가 한도(429)를 알리면 멈추고, 앱은 기본 방식으로 돌아감.
// 키는 공급자별 칸(k:계정:공급자)에 '가입 세대'(계정 created)와 같이 저장 → 탈퇴 후 같은 이메일로 새로 가입해도 예전 키는 못 씀.
// 사용 횟수는 조건부 저장으로 먼저 1회를 확보한 뒤에만 공급자를 부름(동시 요청·저장 실패 때 상한 우회 방지).
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const sha = (x) => createHash('sha256').update(String(x)).digest('hex');
const CAP = 200;                       // 계정당 하루 AI 요청 상한(앱 요청 1번 = 1회, 그 안의 받아쓰기·해석·대체 호출 포함) — 결제를 켠 키라도 과하게 쓰지 않게
const day = () => new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);   // 한국 날짜

// 모델 묶음: hear = 듣는 모델, think = 말뜻 해석 모델 (같으면 한 번에 처리)
const MODELS = {
  'gemini-lite':  { p: 'gemini', hear: 'gemini-3.5-flash-lite', think: 'gemini-3.5-flash-lite' },
  'gemini-flash': { p: 'gemini', hear: 'gemini-3.8-flash',      think: 'gemini-3.8-flash' },
  'gemini-trans': { p: 'gemini', hear: 'gemini-3.5-transcribe', think: 'gemini-3.5-flash-lite' },
  'groq-oss':     { p: 'groq',   hear: 'whisper-large-v3',       think: 'openai/gpt-oss-120b' },
  'groq-qwen':    { p: 'groq',   hear: 'whisper-large-v3-turbo', think: 'qwen/qwen3.8-27b' },
};
// 자동: 듣기는 공개 한국어 평가가 나은 Gemini Flash부터, 해석은 가볍고 한도 넉넉한 Flash-Lite부터. 막히면 다음 것
const AUTO = { hear: ['gemini-flash', 'gemini-lite', 'groq-oss'], ask: ['gemini-lite', 'groq-oss', 'gemini-flash'] };
const PROVS = ['gemini', 'groq'];

const SYS = `너는 한국 여행 지도 앱 '핀볼'의 음성 명령 해석기다. 사용자의 말을 앱이 실행할 명령 하나로 바꿔 JSON 객체 하나만 출력한다. 설명은 쓰지 않는다.
받아쓰기 오류가 있을 수 있다. 장소 이름은 [화면]의 후보·고른곳·오늘일정·가고싶은곳·최근본곳에 비슷한 이름(발음·띄어쓰기·받침이 조금 달라도)이 있으면 그 이름을 그대로 쓴다. 없으면 한국에서 쓰는 올바른 가게·장소 이름으로 고친다. 좌표·주소·영업 정보는 지어내지 않는다.
형식: {"heard":"사용자가 한 말(받아쓰기 오류를 고친 문장)","act":"…", 그 밖의 칸}
act 종류:
- "find": 특정 장소를 찾거나 가려 함. "q":장소 이름, "go":가자·안내해·데려다줘 같은 말이면 true
- "nearby": 근처에서 음식·종류로 찾기. "q":찾을 말(예: 흑돼지, 국밥, 카페, 오름), "cat":"food"|"cafe"|"tour"|"fuel"
- "choose": 보이는 후보 중 고르기. "n":번호(1부터, 마지막은 -1), "go"
- "navi": 지금 고른 곳(거기·그 집)으로 길안내
- "fuel": 가는 길에 주유·충전하고 가기
- "next": 다음 일정 / "today": 오늘 일정
- "saved": 가고 싶은 곳(저장한 곳) 보기, "q":걸러볼 말 또는 ""
- "recent": 아까·최근 본 곳, "q":걸러볼 말 또는 ""
- "save": 가고 싶은 곳에 저장 / "plan": 일정에 담기. "q":대상 장소 이름(고른곳·거기·아까 선택한 곳이면 "")
- "none": 위에 없음(인사·잡담·일반 질문). "say":한두 문장의 짧은 한국어 답
"배고파", "뭐 먹지"는 nearby(cat food, q "맛집")로 본다. "거기", "그 집", "아까 고른 곳"은 고른곳을 뜻한다.`;

// ---------- 키 보관 (서버 안에서만 풀 수 있게 암호화) ----------
const store = (name) => (globalThis.__pinbStores && globalThis.__pinbStores[name]) || getStore({ name, consistency: 'strong' });   // 시험할 땐 가짜 저장소
function aiStore() { return store('pinb-ai'); }
async function secretKey(st) {
  let s = await st.get('secret');
  if (!s) { await st.set('secret', randomBytes(32).toString('hex'), { onlyIfNew: true }); s = await st.get('secret'); }
  return createHash('sha256').update('pinb-ai|' + s).digest();
}
function enc(k, text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function dec(k, o) {
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// 저장 결과 확인 (sync 함수와 같은 방식: 조건이 안 맞으면 conflict, etag 없으면 실패)
async function put(st, key, val, cond) {
  const w = await st.set(key, JSON.stringify(val), cond);
  if (w && w.modified === false) return 'conflict';
  if (!w || !w.etag) return 'fail';
  return 'ok';
}

// ---------- 계정 확인 (sync 함수와 같은 계정 자료를 읽기만 함) ----------
async function auth(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return null;
  const h = sha('pinb|' + email).slice(0, 40);
  const rec = await store('pinb-rooms').get('acct:' + h, { type: 'json' }).catch(() => null);
  if (!rec || !Array.isArray(rec.tokens)) return null;
  const th = Buffer.from(sha(String(body.token || '')), 'hex');
  const good = rec.tokens.some(x => { try { const b = Buffer.from(String(x && x.t || ''), 'hex'); return b.length === th.length && timingSafeEqual(b, th); } catch { return false; } });
  return good ? { h, gen: String(rec.created || 0) } : null;   // gen: 가입 세대 (재가입하면 바뀜)
}

// ---------- 공급자 호출 ----------
class AiErr extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
async function call(url, opt, ms) {
  let r;
  try { r = await fetch(url, { ...opt, signal: AbortSignal.timeout(ms) }); }
  catch (e) { throw new AiErr(e && e.name === 'TimeoutError' ? 'timeout' : 'net'); }
  if (r.status === 429) throw new AiErr('quota');
  if (r.status === 401 || r.status === 403) throw new AiErr('badkey');
  if (!r.ok) throw new AiErr('fail', r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
  return r.json();
}
const GURL = 'https://generativelanguage.googleapis.com/v1beta';
async function geminiGen(key, model, parts, { json = true, ms = 9000, sys = SYS } = {}) {
  const j = await call(`${GURL}/models/${model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  }, ms);
  const c = j && j.candidates && j.candidates[0];
  return ((c && c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
}
async function geminiTranscribe(key, b64, mime, vocab, ms = 8000) {
  const j = await call(`${GURL}/interactions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', data: b64, mime_type: mime }],
      generation_config: { transcription_config: { language_codes: ['ko-KR'], ...(vocab.length ? { custom_vocabulary: vocab.slice(0, 100) } : {}) } },
    }),
  }, ms);
  if (j && typeof j.output_text === 'string') return j.output_text.trim();
  return ((j && j.steps) || []).flatMap(s => s.content || []).map(c => c.text || '').join(' ').trim();
}
async function groqChat(key, model, user, ms = 8000) {
  const body = { model, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], temperature: 0.1, max_tokens: 700, response_format: { type: 'json_object' } };
  if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
  const go = b => call('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(b) }, ms);
  let j;
  try { j = await go(body); }
  catch (e) { if (e.code !== 'fail') throw e; delete body.response_format; delete body.reasoning_effort; j = await go(body); }   // JSON 모드를 못 쓰는 모델이면 한 번 더
  return String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}
async function groqSTT(key, model, buf, mime, hint, ms = 8000) {
  const fd = new FormData();
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  fd.append('file', new Blob([buf], { type: mime }), 'voice.' + ext);
  fd.append('model', model); fd.append('language', 'ko'); fd.append('response_format', 'json'); fd.append('temperature', '0');
  if (hint) fd.append('prompt', hint);
  const j = await call('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd }, ms);
  return String((j && j.text) || '').trim();
}
async function testKey(prov, key) {
  if (prov === 'gemini') await call(`${GURL}/models?pageSize=1`, { headers: { 'x-goog-api-key': key } }, 8000);
  else await call('https://api.groq.com/openai/v1/models', { headers: { authorization: 'Bearer ' + key } }, 8000);
}

// ---------- 화면 상태 → AI에 줄 짧은 글 ----------
const s = (x, n = 40) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, n);
const arr = (a, m) => Array.isArray(a) ? a.slice(0, m).map(x => s(x)).filter(Boolean) : [];
function cleanCtx(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    후보: Array.isArray(c.cands) ? c.cands.slice(0, 8).map((x, i) => `${i + 1}. ${s(x && x.name)}${x && x.cat ? ' (' + s(x.cat, 20) + ')' : ''}`) : [],
    고른곳: s(c.sel), 오늘일정: arr(c.plan, 15), 가고싶은곳: arr(c.saved, 30), 최근본곳: arr(c.recent, 10), 지금: s(c.time, 10),
  };
}
function vocabOf(c) {
  const v = [...(c.cands || []).map(x => x && x.name), c.sel, ...(c.plan || []), ...(c.saved || []), ...(c.recent || [])].map(x => s(x)).filter(x => x.length > 1);
  return [...new Set(v)].slice(0, 100);
}
const ACTS = new Set(['find', 'nearby', 'choose', 'navi', 'fuel', 'next', 'today', 'saved', 'recent', 'save', 'plan', 'none']);
function parseCmd(t) {
  t = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = t.match(/\{[\s\S]*\}/);
  let o; try { o = JSON.parse(m ? m[0] : t); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const act = ACTS.has(o.act) ? o.act : 'none';
  const n = Math.max(-1, Math.min(10, Math.round(+o.n || 0)));
  return { act, q: s(o.q, 60), n, go: o.go === true || o.go === 'true', cat: ['food', 'cafe', 'tour', 'fuel'].includes(o.cat) ? o.cat : 'food', say: s(o.say, 200), heard: s(o.heard, 200) };
}
// 받아쓰기만 시켰는데 JSON으로 답하면 heard만 꺼냄
function plainHeard(t) { const c = /^\s*[{`]/.test(t) ? parseCmd(t.replace(/```(json)?/g, '')) : null; const h = s(c && c.heard ? c.heard : t.replace(/^["'“]|["'”]$/g, ''), 200); return GHOST.test(h) ? '' : h; }
// 위스퍼가 조용한 소리에서 지어내는 흔한 문장
const GHOST = /^(시청해\s*주셔서\s*감사합니다|구독과\s*좋아요|MBC\s*뉴스|자막\s*(제공|by)|감사합니다)[.!\s]*$/;

async function thinkWith(id, key, text, ctx) {
  const m = MODELS[id], user = `[화면] ${JSON.stringify(ctx)}\n[사용자의 말] ${text}`;
  const out = m.p === 'gemini' ? await geminiGen(key, m.think, [{ text: user }]) : await groqChat(key, m.think, user);
  const cmd = parseCmd(out);
  if (!cmd) throw new AiErr('fail', 'bad json');
  if (!cmd.heard) cmd.heard = s(text, 200);
  return cmd;
}
async function hearWith(id, key, b64, mime, ctx, sttOnly, strict) {
  const m = MODELS[id], vocab = vocabOf({ cands: (ctx.후보 || []).map(x => ({ name: x.replace(/^\d+\.\s*/, '').replace(/\s*\(.*\)$/, '') })), sel: ctx.고른곳, plan: ctx.오늘일정, saved: ctx.가고싶은곳, recent: ctx.최근본곳 });
  const used = { stt: m.hear, think: sttOnly ? null : m.think };
  let heard = '', fb = false;
  if (m.p === 'groq') {
    heard = await groqSTT(key, m.hear, Buffer.from(b64, 'base64'), mime, vocab.length ? ('장소 이름: ' + vocab.join(', ')).slice(0, 150) : '');
  } else if (m.hear === 'gemini-3.5-transcribe') {
    try { heard = await geminiTranscribe(key, b64, mime, vocab); }
    catch (e) {
      if (strict || e.code === 'quota' || e.code === 'badkey') throw e;   // 실험실 비교는 대체하지 않고 실패를 그대로
      used.stt = 'gemini-3.5-flash-lite'; fb = true;
      heard = await geminiGen(key, 'gemini-3.5-flash-lite', [{ inline_data: { mime_type: mime, data: b64 } }, { text: '이 음성을 한국어로 들리는 그대로 받아써라. 받아쓴 문장만 출력한다.' }], { json: false, sys: null });
    }
  } else {
    // Gemini Flash류: 한 번에 듣고 해석 (장소 이름 목록을 같이 줘서 비슷한 소리를 그 이름으로)
    const parts = [{ inline_data: { mime_type: mime, data: b64 } }];
    if (sttOnly) {
      parts.push({ text: `이 음성을 한국어로 들리는 그대로 받아써라. 참고할 장소 이름: ${vocab.join(', ') || '없음'}. 받아쓴 문장만 출력한다(JSON 아님).` });
      return { heard: plainHeard(await geminiGen(key, m.hear, parts, { json: false, sys: null })), used, fb };
    }
    used.think = m.hear;
    parts.push({ text: `[화면] ${JSON.stringify(ctx)}\n위 음성이 사용자의 말이다. 명령 JSON을 출력해라. heard에는 들은 문장을 쓴다.` });
    const cmd = parseCmd(await geminiGen(key, m.hear, parts));
    if (!cmd) throw new AiErr('fail', 'bad json');
    if (!cmd.heard || GHOST.test(cmd.heard)) return { heard: '', cmd: null, used, fb };
    return { heard: cmd.heard, cmd, used, fb };
  }
  heard = s(heard, 200);
  if (!heard || GHOST.test(heard)) return { heard: '', cmd: null, used, fb };
  if (sttOnly) return { heard, used, fb };
  return { heard, cmd: await thinkWith(id, key, heard, ctx), used, fb };
}

const PATH = (h, p) => 'k:' + h + ':' + p;
export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return ok({ err: 'bad json' }, 400);
  try { return await handle(body); }
  catch (e) { return ok({ err: 'store', detail: String(e && e.message || e).slice(0, 120) }, 503); }   // 저장소를 못 읽으면 AI를 부르지 않음
};

async function handle(body) {
  const a = await auth(body);
  if (!a) return ok({ err: 'bad token' }, 401);
  const { h, gen } = a, st = aiStore(), uKey = 'u:' + h + ':' + day();
  // 키: 공급자별 칸. 세대가 다르면(탈퇴 후 재가입) 지우고 없는 것으로
  const keys = {};
  for (const p of PROVS) {
    const v = await st.get(PATH(h, p), { type: 'json' });
    if (!v) continue;
    if (v.gen === gen) keys[p] = v; else await st.delete(PATH(h, p)).catch(() => {});
  }
  if (await st.get('k:' + h)) await st.delete('k:' + h).catch(() => {});   // 첫 dev판(한 칸에 같이 저장)의 키는 세대 정보가 없어 지움 → 다시 연결
  const used = async () => ((await st.get(uKey, { type: 'json' })) || {}).n || 0;
  const pub = () => Object.fromEntries(PROVS.map(p => [p, keys[p] ? { tail: keys[p].tail, at: keys[p].at } : null]));
  const act = body.action;

  if (act === 'status') return ok({ keys: pub(), today: await used(), cap: CAP });
  if (act === 'setkey' || act === 'delkey') {
    const prov = String(body.prov || '');
    if (!PROVS.includes(prov)) return ok({ err: 'bad prov' }, 400);
    if (act === 'delkey') { await st.delete(PATH(h, prov)); delete keys[prov]; }
    else {
      const key = String(body.key || '').trim();
      if (!/^[\x21-\x7e]{20,200}$/.test(key)) return ok({ err: 'bad key' }, 400);
      try { await testKey(prov, key); }
      catch (e) { return ok({ err: e.code === 'badkey' ? 'badkey' : e.code === 'quota' ? 'quota' : 'keytest', detail: e.detail }, 400); }
      const v = { ...enc(await secretKey(st), key), tail: key.slice(-4), at: Date.now(), gen };
      if (await put(st, PATH(h, prov), v) !== 'ok') return ok({ err: 'save failed' }, 503);
      keys[prov] = v;
    }
    return ok({ keys: pub(), today: await used(), cap: CAP });
  }
  if (act !== 'ask' && act !== 'hear') return ok({ err: 'bad action' }, 400);

  const sk = await secretKey(st), plain = {};
  for (const p of PROVS) if (keys[p]) { const k = dec(sk, keys[p]); if (k) plain[p] = k; }
  const want = String(body.model || 'auto'), strict = !!body.strict;
  const list = (want === 'auto' && !strict ? AUTO[act] : [want]).filter(id => MODELS[id] && plain[MODELS[id].p]);
  if (!list.length) return ok({ err: 'nokey' }, 400);
  const ctx = cleanCtx(body.ctx);
  let audio = '', mime = '';
  if (act === 'hear') {
    audio = String(body.audio || '');
    mime = String(body.mime || 'audio/webm').split(';')[0].toLowerCase();
    if (mime === 'audio/mp4' || mime === 'audio/x-m4a') mime = 'audio/m4a';
    if (!/^[A-Za-z0-9+/=]{100,2800000}$/.test(audio)) return ok({ err: 'bad audio' }, 400);
  } else if (!s(body.text, 200)) return ok({ err: 'no text' }, 400);

  // 사용 1회를 먼저 확보 (동시에 여러 요청이 와도 상한을 넘지 않게, 저장 실패면 부르지 않음)
  let n = 0, got = false;
  for (let i = 0; i < 8 && !got; i++) {
    const cur = await st.getWithMetadata(uKey, { type: 'json' });
    n = (cur && cur.data && cur.data.n) || 0;
    if (n >= CAP) return ok({ err: 'cap', today: n, cap: CAP }, 429);
    const w = await put(st, uKey, { n: n + 1 }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w === 'ok') { n++; got = true; } else if (w === 'fail') break;
  }
  if (!got) return ok({ err: 'busy' }, 503);

  const t0 = Date.now(), tried = [];
  let last = null;
  for (const id of list) {
    try {
      const key = plain[MODELS[id].p], fbAuto = tried.length > 0;
      if (act === 'ask') return ok({ cmd: await thinkWith(id, key, s(body.text, 200), ctx), model: id, want, used: { stt: null, think: MODELS[id].think }, fb: fbAuto, tried, ms: Date.now() - t0, today: n, cap: CAP });
      const r = await hearWith(id, key, audio, mime, ctx, !!body.stt, strict);
      return ok({ ...r, fb: r.fb || fbAuto, model: id, want, tried, ms: Date.now() - t0, today: n, cap: CAP });
    } catch (e) {
      last = e; tried.push({ id, err: e.code || 'fail' });
      if (Date.now() - t0 > 14000) break;   // 함수 시간 안에 끝내기
    }
  }
  const code = last && last.code || 'fail';
  return ok({ err: code, detail: last && last.detail, tried, today: n, cap: CAP }, code === 'quota' ? 429 : 502);
}
