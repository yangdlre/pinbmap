// 말로 찾기: 말 → 검색 경로가 최종적으로 무엇을 찾는지 (검색어 보존 · 이름/종류/시설 · 최종 분류 · 지역·반경) · 말소리 판정
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, has, plain } from './harness.mjs';

// 이름으로 꺼내되, 모자란 선언은 알아서 더 꺼냄 (화면·저장 쪽은 대역)
function loadAuto(names, stubs, probe) {
  names = names.slice();
  for (let i = 0; i < 40; i++) {
    const m = load(names, stubs);
    try { probe(m); return m; } catch (e) {
      const k = String(e && e.message).match(/^([\w$가-힣]+) is not defined/);
      if (!k) throw e;
      if (has(k[1]) && !names.includes(k[1])) names.push(k[1]); else stubs[k[1]] = () => null;
    }
  }
  throw new Error('의존 선언을 다 못 찾음');
}
const R = ['KIND_WORD', 'KIND_END', 'NAME_END', 'FACILITY', 'nameOrKind', 'catOfKind', 'NEAR_HEAD', 'FIND_TAIL', 'nearStrip', 'ambiguousKind'];

test("'찾아줘'·'근처'를 떼도 이름 글자는 그대로 ('이마트'가 '마트'로 되던 것)", () => {
  const { nearStrip } = load(R);
  const want = { '이마트 찾아줘': ['이마트', false], '이디야 찾아줘': ['이디야', false], '에버랜드 찾아줘': ['에버랜드', false],
    '이 근처 카페 찾아줘': ['카페', true], '근처에 약국 찾아줘': ['약국', true], '주변 신평역 찾아줘': ['신평역', true],
    '근처 맛집': ['맛집', true], '여기 국밥 추천해줘': ['국밥', true], '신평역 찾아줘': ['신평역', false] };
  for (const [t, [w, ex]] of Object.entries(want)) { const r = nearStrip(t); assert.equal(r.w, w, t); assert.equal(r.explicit, ex, t); }
  assert.equal(nearStrip('정짓간'), null);
});

test('이름 / 종류 / 시설 / 모름', () => {
  const { nameOrKind } = load(R);
  const want = {
    '신평역': 'name', '연지청구2차아파트': 'name', '스타벅스 서면점': 'name', '시민공원': 'name', '이마트': 'name', '롯데호텔': 'name',
    '카페': 'kind', '서면 커피': 'kind', '정짓간 국밥': 'kind', '제육볶음': 'kind', '흑돼지': 'kind', '공원': 'kind',
    '약국': 'facility', '주차장': 'facility', '편의점': 'facility', '호텔': 'facility', '숙소': 'facility', '화장실': 'facility',
    '투썸플레이스': 'unknown', '이디야': 'unknown', '정짓간': 'unknown',
  };
  for (const [w, k] of Object.entries(want)) assert.equal(nameOrKind(w), k, w);
});

test('종류말은 최종 검색 분류가 맞게 (카페 말이 음식점으로, 시설이 음식점으로 가지 않음)', () => {
  const { catOfKind, KIND_WORD, FACILITY } = load(R);
  const exp = { 카페: 'cafe', 커피: 'cafe', 찻집: 'cafe', 디저트: 'cafe', 빵집: 'cafe', 베이커리: 'cafe',
    관광지: 'tour', 명소: 'tour', 오름: 'tour', 해변: 'tour', 폭포: 'tour', 공원: 'tour', 산책로: 'tour', 박물관: 'tour', 체험: 'tour',
    주유소: 'fuel', 충전소: 'fuel', lpg: 'fuel', 국밥: 'food', 맛집: 'food', 횟집: 'food', 술집: 'food', 치킨: 'food' };
  for (const [w, c] of Object.entries(exp)) { assert.ok(KIND_WORD.test(w), w + ' 종류말'); assert.equal(catOfKind(w), c, w); }
  // 시설은 종류말 목록에 없고 카카오 분류가 따로
  const code = { 약국: 'PM9', 주차장: 'PK6', 편의점: 'CS2', 호텔: 'AD5', 숙소: 'AD5', 마트: 'MT1', 병원: 'HP8' };
  for (const [w, c] of Object.entries(code)) { assert.ok(!KIND_WORD.test(w), w + ' 은 종류말 아님'); assert.equal(FACILITY[w], c, w); }
});

test("'상호 + 종류말'만 애매 ('얼큰한 국밥'·'흑돼지 맛집'은 종류)", () => {
  const { ambiguousKind } = load(R);
  for (const w of ['정짓간 국밥', '스타벅스 커피', '할매 국밥']) assert.ok(ambiguousKind(w), w);
  for (const w of ['국밥', '얼큰한 국밥', '흑돼지 맛집', '제육 맛집', '돼지국밥 집', '근처 카페', '24시 국밥', '정짓간 약국']) assert.ok(!ambiguousKind(w), w);
});

test('LPG·주유: 말한 지역과 반경만, 남은 조사는 지역으로 안 씀', () => {
  const { ruleCmd } = loadAuto(['ruleCmd'], { appMode: () => 'food', fuelKind: () => 'gas', nowKST: () => ({ d: '2026-10-18', m: 600 }) }, m => m.ruleCmd('LPG 제일 싼 데 찾아줘', false));
  const r = t => plain(ruleCmd(t, false));
  assert.deepEqual(r('하단에서 LPG 제일 싼 데 찾아줘'), { act: 'nearby', q: '', cat: 'fuel', cond: { rank: 'cheap', fuel: 'lpg' }, area: '하단' });
  assert.deepEqual(r('하단에서 3km 안에 LPG 제일 싼 데 찾아줘'), { act: 'nearby', q: '', cat: 'fuel', cond: { radius: 3000, rank: 'cheap', fuel: 'lpg' }, area: '하단' });
  assert.deepEqual(r('LPG 제일 싼 데로 찾아줘'), { act: 'cond', cond: { rank: 'cheap', fuel: 'lpg' } });
  assert.deepEqual(r('LPG 충전소 중 싼 곳 찾아줘'), { act: 'cond', cond: { rank: 'cheap', fuel: 'lpg' } });
});

test('오전 12시 = 0시, 자정·정오', () => {
  const { ruleCmd } = loadAuto(['ruleCmd'], { appMode: () => 'food', fuelKind: () => 'gas', nowKST: () => ({ d: '2026-10-18', m: 600 }) }, m => m.ruleCmd('오전 12시에 성산일출봉 넣어줘', false));
  const time = t => ruleCmd(t, false).time;
  assert.equal(time('오전 12시에 성산일출봉 넣어줘'), '0:00');
  assert.equal(time('새벽 12시에 숙소 넣어줘'), '0:00');
  assert.equal(time('오후 12시에 성산일출봉 넣어줘'), '12:00');
  assert.equal(time('자정에 숙소 넣어줘'), '0:00');
  assert.equal(time('정오에 점심 넣어줘'), '12:00');
  assert.equal(time('3시에 카페 넣어줘'), '15:00');   // 오전·오후 없는 1~7시는 오후 (정한 규칙)
});

// 60프레임/초로 흉내: 배경 0.005, 말소리 0.06~0.14(음절마다 오르내림)
function simulate(parts, totalMs = 12000) {
  const { vadNew, vadStep } = load(['VAD_RUN', 'VAD_SUM', 'vadNew', 'vadStep']);
  const v = vadNew(0);
  for (let t = 0; t <= totalMs; t += 16) {
    const p = parts.find(([s, ms]) => t >= s && t < s + ms);
    const rms = p ? (p[2] || (0.1 + 0.04 * Math.sin(t / 37))) : 0.005;
    if (vadStep(v, rms, t) === 'end') return { spoke: v.spoke, endAt: t };
  }
  return { spoke: v.spoke, endAt: null };
}

test('마이크를 켜자마자 말해도 말소리로 봄 (처음 8프레임이 말이어도)', () => {
  const a = simulate([[0, 2000]]);
  assert.equal(a.spoke, true);
  assert.ok(a.endAt > 2000 && a.endAt < 3500, 'end ' + a.endAt);   // 말이 끝나고 1.1초쯤 뒤에 끝
  const b = simulate([[400, 2000]]);
  assert.equal(b.spoke, true);
  assert.ok(b.endAt > 2400 && b.endAt < 3800, 'end ' + b.endAt);
  const yes = simulate([[300, 250]]);   // 짧은 대답 '네'
  assert.equal(yes.spoke, true);
  assert.ok(yes.endAt < 2000, 'end ' + yes.endAt);
});

test('조용하거나 툭 치는 짧은 소리(48ms)만 있으면 말소리 없음', () => {
  for (const parts of [[], [[0, 48, 0.125]], [[900, 48, 0.125]], [[900, 48, 0.125], [1500, 48, 0.125]]]) {
    const c = simulate(parts);
    assert.equal(c.spoke, false, JSON.stringify(parts));
    assert.ok(c.endAt >= 6000 && c.endAt < 6100, 'end ' + c.endAt);
  }
});
