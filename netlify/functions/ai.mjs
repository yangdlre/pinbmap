// 핀볼 지도 — 🎤 말로 찾기 AI 연결
// 운영자 공용 키는 없음. 각자 자기 AI 키를 "내 계정"에 묶어 서버에 암호화 저장하고, 키는 다시 내려보내지 않음.
// POST {email, token, action, model?, ...}
//   status                         → {keys:{gemini:{tail,at}|null, groq:…}, today, cap}
//   setkey {prov, key}             → 공급자에 키 확인(모델 목록 조회 — 사용량 안 씀) 뒤 저장
//   delkey {prov}
//   ask  {text, ctx}               → {cmd, model, ms}            ② 브라우저 받아쓰기 + AI 해석
//   hear {audio(base64), mime, ctx, stt?} → {heard, cmd, model, ms}   ③ AI가 녹음을 직접 듣고 해석 (stt:1 = 받아쓰기만, 실험실 비교용)
//   vision {image(base64 jpeg), today} → {doc}   📷 영수증·예약 사진 읽기 (Groq Qwen 3.8 / Gemini Flash-Lite)
//   agent {messages} → {msg}   🔎 깊게 찾기: AI가 앱의 도구(장소 검색·상세·날씨·내 여행)를 직접 불러 여러 번 확인 — 도구 실행은 앱(폰)이, 키는 서버가
// AI에는 문장(또는 녹음)과 화면의 장소 "이름"만 보냄 — 좌표·주소·개인 일정 세부는 안 보냄.
// 무료 모델만 부름. 하루 상한(CAP, 앱 요청 기준)을 넘거나 공급자가 한도(429)를 알리면 멈추고, 앱은 기본 방식으로 돌아감.
// 키는 공급자별 칸(k:계정:공급자)에 '가입 세대'(계정 created)와 같이 저장 → 탈퇴 후 같은 이메일로 새로 가입해도 예전 키는 못 씀.
// 사용 횟수는 조건부 저장으로 먼저 1회를 확보한 뒤에만 공급자를 부름(동시 요청·저장 실패 때 상한 우회 방지).
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const sha = (x) => createHash('sha256').update(String(x)).digest('hex');
const CAP = 500;                       // 계정당 하루 AI 요청 상한(앱 요청 1번 = 1회, 그 안의 받아쓰기·해석·대체 호출 포함) — 결제를 켠 키라도 과하게 쓰지 않게
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

const SYS = `너는 한국 여행 지도 앱 '핀볼'의 음성 명령 해석기다. 사용자의 말을 앱 명령 하나로 바꿔 JSON 객체 하나만 출력한다(설명 없이).
받아쓰기 오류가 있을 수 있다. 소리 나는 대로 적혀 받침이 바뀌기도 한다(신평역→심평역, 한강→항강, 종로→종노). 장소 이름은 [화면]의 후보·고른곳·오늘일정·가고싶은곳·최근본곳·근처역에 비슷한 이름이 있으면 그 이름을 그대로 쓴다. 좌표·주소·영업·날씨는 지어내지 않는다(앱이 확인한다).
형식: {"heard":"받아쓰기를 고친 문장","act":"…", 그 밖의 칸}
[장소]
find: 가게·장소 고유 이름 찾기/가기. q, go(가자·안내해·데려다줘면 true). 음식·메뉴·종류는 find가 아니다.
nearby: 음식·메뉴·종류로 근처 찾기(제육볶음·국밥·흑돼지·카페·오름·주유소, 배고파, 뭐 먹지, ○○ 먹고 싶어). q, cat(food|cafe|tour|fuel). 조건이 같이 오면 cond 칸도 넣는다. 지역·동네·역 이름이 있으면 area에 넣고 q에는 넣지 않는다(예: "부산 하단동 술집 추천" → area "부산 하단동", q "술집").
choose: 보이는 후보 고르기. n(1부터, 마지막 -1), go
navi: 고른 곳(거기·그 집)으로 길안내
fuel: 가는 길에 주유·충전. q=목적지(숙소·장소, 없으면 "")
next / today: 다음 일정 / 오늘 일정
saved / recent: 가고 싶은 곳 / 아까 본 곳 목록. q=걸러볼 말
save / plan: 가고 싶은 곳에 저장 / 일정 후보에 담기. q=대상(고른 곳이면 "")
[검색 조건] cond: 바꿀 칸만: radius(미터, 넓혀=up, 좁혀=down), cnt(5|10|20), fran(true=프랜차이즈 빼기), open(true=영업 중인 곳만), rank(recommend 평판|score2 종합점수|rating 평점|near 가까운|local 현지인|cheap 최저가), mode(food|cafe|tour|fuel), fuel(gas|lpg|ev)
[기록] exp: 지출. amt(원, 3만 2천=32000), title, who(with 공동·같이·N빵 | me 내 지출·가계부 | ""), bcat(food|cafe|drink|move|stay|shop|gift|souv|tour|life|etc)
todo: 할 일 추가. text
sched: 일정에 넣기. q(장소, 고른 곳이면 ""), rel(today|tomorrow|dayafter|""), day(N일차면 N, 아니면 0), time("HH:MM" 24시간, 오전·오후 없이 1~7시면 오후)
visit: 다녀옴 표시. q(여기면 "")
memo: 일정에 메모. q(장소, 없으면 ""), text
[물어보기] info: what(weather|rain|sunset|hours|dist|visited|spent|settle|todos), when(today|tomorrow), q(hours·dist 장소, 고른 곳이면 "")
indoor: 비 올 때 실내 관광지 / open: 화면 열기 what(sat 위성|map 일반 지도|visited|sched|exp|todo|book|saved|photo|hub)
두 가지를 이어서 하라는 말(흑돼지 먹고 근처 카페)은 첫 명령에 "then":{두 번째 명령}.
후보 고르기·비교(어디가 나아, 주차 편한 쪽, 평점 높은 데로)는 [화면] 후보에 적힌 점수·후기·거리·영업·주차 안내·내 메모만 근거로 choose(n)+say(한 줄 이유). 적혀 있지 않은 조건은 "정보 없음"이라고 말한다. 고르라는 말이 없는 비교 질문은 none+say.
none: 위에 없음(인사·잡담). say=짧은 한국어 답. 날씨·영업시간·지출처럼 앱이 아는 것은 none이 아니라 info로.`;

const VISION = (today) => `사진을 보고 JSON 객체 하나만 출력한다. 오늘은 ${today}이다(연도가 없으면 오늘 기준으로 가까운 날).
kind: receipt(영수증·카드 전표·계산서) | reservation(예약 확인 화면·예약 문자·티켓) | other
receipt: store(가게 이름), date("YYYY-MM-DD" 또는 ""), time("HH:MM" 또는 ""), total(최종 결제 금액, 원 단위 숫자), items([{name, amt}] 최대 8개), pay("카드"|"현금"|""), cat(food|cafe|drink|move|stay|shop|gift|souv|tour|life|etc)
reservation: place(가게·장소 이름), date, time, people(인원 숫자, 모르면 0), note(예약번호·주차·준비물 등 60자 이내)
other: say(무슨 사진인지 한 줄)
글자가 흐리거나 없으면 그 칸은 비운다. 카드번호·전화번호 전체는 적지 않는다. 지어내지 않는다.`;
const SYS_AGENT = `너는 한국 여행 지도 앱 '핀볼'의 검색 비서다. 도구로 사실을 확인한 뒤 답한다.
장소는 find_places, 점수·영업·주차는 place_info, 날씨는 weather, 내 일정·숙소·가고 싶은 곳은 my_trip. [화면] 후보 id도 쓸 수 있다.
사용자가 지역(동네·역)을 말하면 find_places의 near에 그 지역을 넣고 q에는 넣지 않는다. 지역을 못 찾았다는 결과가 오면 지어내지 말고 answer로 어느 동네인지 묻는다.
[말]은 받아쓴 것이라 소리 나는 대로 틀릴 수 있다(신평역→심평역). 지역 이름이 [화면] 근처역과 비슷하면 그 역 이름으로 찾는다.
도구는 필요한 만큼만(보통 1~3번). 끝낼 때는 반드시 answer: say=한두 문장 한국어(근거 포함. 도구 결과가 null인 칸은 말하지 않고, 물어본 것을 확인 못 했으면 "확인하지 못했어요"처럼 문장으로 쓴다), ids=보여 줄 장소 id(도구 결과·[화면]에 나온 것만, 최대 5), go=가자·안내해 같은 말이면 true.
사용자가 특정 이름(가게·아파트·건물)을 찾으면 그 이름이 들어간 장소만 ids에 넣는다. 못 찾았으면 다른 곳(근처 식당 등)을 대신 보여 주지 말고 못 찾았다고 answer한다.
장소·점수·영업시간을 지어내지 않는다.`;
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TOOLS = [
  fn('find_places', '카카오 장소 검색. 결과: id·이름·분류·거리(m)', { q: { type: 'string' }, near: { type: 'string', description: "here(지도 가운데)|selected(고른 곳)|lodging(숙소)|내 목록 장소 이름|지역·동네·역 이름(예: '부산 하단동', '서면역')" }, radius: { type: 'integer', description: '미터, 기본 3000' }, cat: { type: 'string', enum: ['food', 'cafe', 'tour', 'fuel', 'any'] } }, ['q']),
  fn('place_info', '장소 상세: 평점·후기 수·영업 상태·주차장 안내·내 메모', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
  fn('weather', '지금 위치 날씨(시간별 비 포함)', { when: { type: 'string', enum: ['today', 'tomorrow'] } }),
  fn('my_trip', '오늘 일정·숙소·가고 싶은 곳', {}),
  fn('answer', '최종 답', { say: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, go: { type: 'boolean' } }, ['say']),
];
const s2 = (x, n) => String(x == null ? '' : x).slice(0, n);
function cleanMsgs(a) {
  if (!Array.isArray(a) || !a.length || a.length > 20) return null;
  const out = [];
  for (const m of a) {
    if (!m || typeof m !== 'object') return null;
    if (m.role === 'user') out.push({ role: 'user', content: s2(m.content, 3000) });
    else if (m.role === 'assistant') {
      const tc = Array.isArray(m.tool_calls) ? m.tool_calls.slice(0, 1).map(t => ({ id: s2(t && t.id, 64), type: 'function', function: { name: s2(t && t.function && t.function.name, 32), arguments: s2(t && t.function && t.function.arguments || '{}', 1000) } })) : [];
      out.push(tc.length ? { role: 'assistant', content: s2(m.content, 1500) || null, tool_calls: tc } : { role: 'assistant', content: s2(m.content, 1500) });
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: s2(m.tool_call_id, 64), name: s2(m.name, 32), content: s2(m.content, 3000) });
    else return null;
  }
  return JSON.stringify(out).length > 40000 ? null : out;
}
async function groqAgent(key, msgs) {
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: SYS_AGENT }, ...msgs], tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 900, reasoning_effort: 'low' }),
      signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new AiErr(e && e.name === 'TimeoutError' ? 'timeout' : 'net'); }
  if (r.status === 429) { const e = new AiErr('quota'); e.wait = Math.ceil(+r.headers.get('retry-after') || 0); throw e; }
  if (r.status === 401 || r.status === 403) throw new AiErr('badkey');
  if (!r.ok) throw new AiErr('fail', r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  const j = await r.json(), m = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const tc = (m.tool_calls || []).slice(0, 1).map(t => ({ id: t.id, type: 'function', function: { name: t.function && t.function.name, arguments: (t.function && t.function.arguments) || '{}' } }));
  return { role: 'assistant', content: String(m.content || ''), tool_calls: tc, tokens: j.usage && j.usage.total_tokens };
}
async function readPhoto(prov, key, img, mime, today) {
  const prompt = VISION(today);
  let out;
  if (prov === 'groq') {
    const body = { model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${img}` } }] }], temperature: 0.1, max_tokens: 1500, response_format: { type: 'json_object' } };
    const go = b => call('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(b) }, 25000);
    let j; try { j = await go(body); } catch (e) { if (e.code !== 'fail') throw e; delete body.response_format; j = await go(body); }
    out = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  } else out = await geminiGen(key, 'gemini-3.5-flash-lite', [{ inline_data: { mime_type: mime, data: img } }, { text: prompt }], { sys: null, ms: 25000 });
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = out.match(/\{[\s\S]*\}/);
  let o; try { o = JSON.parse(m ? m[0] : out); } catch { throw new AiErr('fail', 'bad json'); }
  return cleanPhoto(o);
}
const num = v => Math.round(+String(v == null ? '' : v).replace(/[^\d.]/g, '') || 0);
function cleanPhoto(o) {
  if (!o || typeof o !== 'object') return { kind: 'other', say: '' };
  const kind = ['receipt', 'reservation', 'other'].includes(o.kind) ? o.kind : 'other';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : '', tm = String(o.time || '').match(/^(\d{1,2}):(\d{2})/), time = tm && +tm[1] < 24 ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '';
  if (kind === 'receipt') { const total = num(o.total); return { kind, store: s(o.store, 40), date, time, total: total > 0 && total <= 1e8 ? total : 0, items: Array.isArray(o.items) ? o.items.slice(0, 8).map(x => ({ name: s(x && x.name, 30), amt: num(x && x.amt) })).filter(x => x.name) : [], pay: s(o.pay, 10), cat: s(o.cat, 10) }; }
  if (kind === 'reservation') return { kind, place: s(o.place, 40), date, time, people: Math.max(0, Math.min(99, Math.round(+o.people || 0))), note: s(o.note, 80) };
  return { kind, say: s(o.say, 120) };
}

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
    후보: Array.isArray(c.cands) ? c.cands.slice(0, 8).map((x, i) => { x = x || {};
      const f = [x.cat ? '(' + s(x.cat, 20) + ')' : '', s(x.dist, 10), +x.r > 0 ? `★${(+x.r).toFixed(1)}${+x.n > 0 ? `(후기 ${Math.round(+x.n)})` : ''}` : '', +x.s2 > 0 ? `종합 ${Math.round(+x.s2)}점` : '',
        +x.price > 0 ? `${Math.round(+x.price)}원` : '', s(x.open, 12), x.park === true ? '주차 안내 있음' : '', x.mine ? '내 ' + s(x.mine, 8) : '', x.memo ? '내 메모: ' + s(x.memo, 40) : ''].filter(Boolean);
      return `${i + 1}. ${s(x.name)} ${f.join(' · ')}`.trim(); }) : [],
    고른곳: s(c.sel), 오늘일정: arr(c.plan, 15), 가고싶은곳: arr(c.saved, 30), 최근본곳: arr(c.recent, 10), 근처역: arr(c.near, 12), 지금: s(c.time, 10), 여행: s(c.trip, 20),
  };
}
function vocabOf(c) {
  c = c && typeof c === 'object' ? c : {};
  const A = a => Array.isArray(a) ? a.slice(0, 40) : [];
  const v = [...A(c.cands).map(x => x && x.name), c.sel, ...A(c.plan), ...A(c.saved), ...A(c.recent), ...A(c.near)].map(x => s(x)).filter(x => x.length > 1);
  return [...new Set(v)].slice(0, 100);
}
// 위스퍼 참고 문장: 화면·내 목록 이름 + 근처 역(위스퍼는 참고 문장의 끝부분을 더 보므로 역 이름을 뒤에)
function hintOf(c, vocab) {
  const st = arr(c && c.near, 12), a = vocab.filter(x => !st.includes(x));
  let h = a.length ? ('장소 이름: ' + a.join(', ')).slice(0, 110) : '';
  if (st.length) h = (h ? h + '. ' : '') + '근처 역: ' + st.join(', ');
  return h.slice(0, 190);
}
const ACTS = new Set(['find', 'nearby', 'choose', 'navi', 'fuel', 'next', 'today', 'saved', 'recent', 'save', 'plan', 'cond', 'exp', 'todo', 'sched', 'visit', 'memo', 'info', 'indoor', 'open', 'none']);
const pickIn = (v, list) => list.includes(v) ? v : '';
const bool = v => v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
function condOf(o) {
  const c = {};
  const r = o.radius === 'up' || o.radius === 'down' ? o.radius : Math.round(+o.radius || 0);
  if (r === 'up' || r === 'down' || (r >= 100 && r <= 20000)) c.radius = r;
  if ([5, 10, 20].includes(+o.cnt)) c.cnt = +o.cnt;
  if (bool(o.fran) !== null) c.fran = bool(o.fran);
  if (bool(o.open) !== null) c.open = bool(o.open);
  const rk = pickIn(o.rank, ['recommend', 'score2', 'rating', 'near', 'local', 'cheap', 'avail']); if (rk) c.rank = rk;
  const md = pickIn(o.mode, ['food', 'cafe', 'tour', 'fuel']); if (md) c.mode = md;
  const fu = pickIn(o.fuel, ['gas', 'lpg', 'ev']); if (fu) c.fuel = fu;
  const src = o.cond && typeof o.cond === 'object' && o !== o.cond ? condOf(o.cond) : {};
  return { ...src, ...c };
}
function cleanCmd(o, depth = 0) {
  if (!o || typeof o !== 'object') return null;
  const act = ACTS.has(o.act) ? o.act : 'none';
  const c = { act, q: s(o.q, 60), n: Math.max(-1, Math.min(10, Math.round(+o.n || 0))), go: bool(o.go) === true, cat: pickIn(o.cat, ['food', 'cafe', 'tour', 'fuel']) || 'food', say: s(o.say, 200), heard: s(o.heard, 200) };
  if (act === 'nearby' || act === 'cond') { const cd = condOf(o); if (Object.keys(cd).length) c.cond = cd; }
  if (act === 'nearby') { const ar = s(o.area, 30); if (ar) c.area = ar; }
  if (act === 'exp') { const a = Math.round(+String(o.amt ?? '').replace(/[^\d.]/g, '') || 0); c.amt = a > 0 && a <= 1e8 ? a : 0; c.title = s(o.title, 40); c.who = pickIn(o.who, ['with', 'me']); c.bcat = s(o.bcat, 12); }
  if (act === 'todo' || act === 'memo') c.text = s(o.text, 120);
  if (act === 'sched') { c.rel = pickIn(o.rel, ['today', 'tomorrow', 'dayafter']); const d = Math.round(+o.day || 0); c.day = d >= 1 && d <= 30 ? d : 0; const tm = String(o.time || '').match(/^(\d{1,2}):(\d{2})$/); c.time = tm && +tm[1] < 25 && +tm[2] < 60 ? `${+tm[1]}:${tm[2]}` : ''; }
  if (act === 'info') { c.what = pickIn(o.what, ['weather', 'rain', 'sunset', 'hours', 'dist', 'visited', 'spent', 'settle', 'todos', 'next']) || 'weather'; c.when = pickIn(o.when, ['today', 'tomorrow']) || 'today'; }
  if (act === 'open') c.what = pickIn(o.what, ['sat', 'map', 'visited', 'sched', 'exp', 'todo', 'book', 'saved', 'photo', 'hub']);
  if (depth === 0 && o.then && typeof o.then === 'object') { const t = cleanCmd(o.then, 1); if (t && t.act !== 'none') c.then = t; }
  return c;
}
function parseCmd(t) {
  t = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = t.match(/\{[\s\S]*\}/);
  let o; try { o = JSON.parse(m ? m[0] : t); } catch { return null; }
  return cleanCmd(o);
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
async function hearWith(id, key, b64, mime, ctx, sttOnly, strict, vocab, hint = '') {
  const m = MODELS[id];
  const used = { stt: m.hear, think: sttOnly ? null : m.think };
  let heard = '', fb = false;
  if (m.p === 'groq') {
    heard = await groqSTT(key, m.hear, Buffer.from(b64, 'base64'), mime, hint);
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
  if (!['ask', 'hear', 'vision', 'agent'].includes(act)) return ok({ err: 'bad action' }, 400);

  const sk = await secretKey(st), plain = {};
  for (const p of PROVS) if (keys[p]) { const k = dec(sk, keys[p]); if (k) plain[p] = k; }
  const want = String(body.model || 'auto'), strict = !!body.strict;
  const list = act === 'ask' || act === 'hear' ? (want === 'auto' && !strict ? AUTO[act] : [want]).filter(id => MODELS[id] && plain[MODELS[id].p]) : [];
  let msgs = null, img = '', imgMime = 'image/jpeg';
  if (act === 'agent') { if (!plain.groq) return ok({ err: 'nokey' }, 400); msgs = cleanMsgs(body.messages); if (!msgs) return ok({ err: 'bad msgs' }, 400); }
  else if (act === 'vision') {
    if (!plain.groq && !plain.gemini) return ok({ err: 'nokey' }, 400);
    img = String(body.image || ''); imgMime = /^image\/(jpeg|png|webp)$/.test(body.mime) ? body.mime : 'image/jpeg';
    if (!/^[A-Za-z0-9+/=]{1000,5600000}$/.test(img)) return ok({ err: 'bad image' }, 400);
  } else if (!list.length) return ok({ err: 'nokey' }, 400);
  const ctx = cleanCtx(body.ctx);
  let audio = '', mime = '';
  if (act === 'hear') {
    audio = String(body.audio || '');
    mime = String(body.mime || 'audio/webm').split(';')[0].toLowerCase();
    if (mime === 'audio/mp4' || mime === 'audio/x-m4a') mime = 'audio/m4a';
    if (!/^[A-Za-z0-9+/=]{100,2800000}$/.test(audio)) return ok({ err: 'bad audio' }, 400);
  } else if (act === 'ask' && !s(body.text, 200)) return ok({ err: 'no text' }, 400);

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
  if (act === 'agent') {
    try { const msg = await groqAgent(plain.groq, msgs); return ok({ msg, model: 'groq-oss', used: { think: 'openai/gpt-oss-120b' }, ms: Date.now() - t0, today: n, cap: CAP }); }
    catch (e) { return ok({ err: e.code || 'fail', wait: e.wait || 0, detail: e.detail, today: n, cap: CAP }, e.code === 'quota' ? 429 : 502); }
  }
  if (act === 'vision') {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : day();
    const order = plain.groq ? ['groq', 'gemini'] : ['gemini'];
    for (const pv of order) {
      if (!plain[pv]) continue;
      try { const doc = await readPhoto(pv, plain[pv], img, imgMime, today); return ok({ doc, model: pv === 'groq' ? 'groq-vision' : 'gemini-vision', ms: Date.now() - t0, today: n, cap: CAP }); }
      catch (e) { last = e; }
    }
    const code = (last && last.code) || 'fail';
    return ok({ err: code, detail: last && last.detail, today: n, cap: CAP }, code === 'quota' ? 429 : 502);
  }
  for (const id of list) {
    try {
      const key = plain[MODELS[id].p], fbAuto = tried.length > 0;
      if (act === 'ask') return ok({ cmd: await thinkWith(id, key, s(body.text, 200), ctx), model: id, want, used: { stt: null, think: MODELS[id].think }, fb: fbAuto, tried, ms: Date.now() - t0, today: n, cap: CAP });
      const vocab = vocabOf(body.ctx);
      const r = await hearWith(id, key, audio, mime, ctx, !!body.stt, strict, vocab, hintOf(body.ctx, vocab));
      return ok({ ...r, fb: r.fb || fbAuto, model: id, want, tried, ms: Date.now() - t0, today: n, cap: CAP });
    } catch (e) {
      last = e; tried.push({ id, err: e.code || 'fail' });
      if (Date.now() - t0 > 14000) break;   // 함수 시간 안에 끝내기
    }
  }
  const code = last && last.code || 'fail';
  return ok({ err: code, detail: last && last.detail, tried, today: n, cap: CAP }, code === 'quota' ? 429 : 502);
}
