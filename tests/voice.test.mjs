// 말로 찾기: '○○ 찾아줘'의 이름/종류 가르기 · 말소리 판정(마이크 켜자마자 말해도)
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

test('이름은 이름 검색, 종류·메뉴는 별점 검색, 모르면 AI(없으면 이름 검색)', () => {
  const { nameOrKind } = load(['KIND_WORD', 'KIND_END', 'NAME_END', 'nameOrKind']);
  const want = {
    '신평역': 'name', '연지청구2차아파트': 'name', '스타벅스 서면점': 'name', '시민공원': 'name', '부산시립박물관': 'name',
    '카페': 'kind', '서면 커피': 'kind', '정짓간 국밥': 'kind', '제육볶음': 'kind', '흑돼지': 'kind', '공원': 'kind', '고깃집': 'kind',
    '투썸플레이스': 'unknown', '정짓간': 'unknown', '연지동 청구 2차': 'unknown',
  };
  for (const [w, k] of Object.entries(want)) assert.equal(nameOrKind(w), k, w);
});

// 60프레임/초로 흉내: 배경 0.005, 말소리 0.06~0.14(음절마다 오르내림)
function simulate(startMs, speakMs, totalMs = 12000) {
  const { vadNew, vadStep } = load(['vadNew', 'vadStep']);
  const v = vadNew(0);
  for (let t = 0; t <= totalMs; t += 16) {
    const speaking = t >= startMs && t < startMs + speakMs;
    const rms = speaking ? 0.1 + 0.04 * Math.sin(t / 37) : 0.005;
    const r = vadStep(v, rms, t);
    if (r === 'end') return { spoke: v.spoke, endAt: t };
  }
  return { spoke: v.spoke, endAt: null };
}

test('마이크를 켜자마자 말해도 말소리로 봄 (처음 8프레임이 말이어도)', () => {
  const a = simulate(0, 2000);
  assert.equal(a.spoke, true);
  assert.ok(a.endAt > 2000 && a.endAt < 3500, 'end ' + a.endAt);   // 말이 끝나고 1.1초쯤 뒤에 끝
  const b = simulate(400, 2000);
  assert.equal(b.spoke, true);
  assert.ok(b.endAt > 2400 && b.endAt < 3800, 'end ' + b.endAt);
});

test('조용하기만 하면 말소리 없음으로 6초 뒤 끝', () => {
  const c = simulate(99999, 0);
  assert.equal(c.spoke, false);
  assert.ok(c.endAt >= 6000 && c.endAt < 6100, 'end ' + c.endAt);
});
