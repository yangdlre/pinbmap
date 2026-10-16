// 💳 여행 경비 정산 (settleCalc) · 📒 가계부에 들어가는 '여행 N빵 내 몫' (myShares)
// 이름·금액은 모두 지어낸 것
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, plain } from './harness.mjs';

const { settleCalc } = load(['settleCalc']);
const ex = (payer, amt, split, extra = {}) => ({ uid: 'e' + Math.random().toString(36).slice(2, 8), title: '경비', payer, amt, split, day: 0, ...extra });
const PS = ['나', '민수', '지영'];

test('한 사람이 셋 몫을 내면 나머지 둘이 그 사람에게 보냄', () => {
  const r = plain(settleCalc([ex('나', 30000, PS)], PS));
  assert.equal(r.total, 30000);
  assert.deepEqual(r.paid, { 나: 30000 });
  assert.deepEqual(r.owe, { 나: 10000, 민수: 10000, 지영: 10000 });
  assert.deepEqual(r.tr, [{ f: '민수', t: '나', v: 10000 }, { f: '지영', t: '나', v: 10000 }]);
});

test('1원 자투리는 낸 사람 몫으로 (나눌 사람 순서와 상관없이)', () => {
  const r = plain(settleCalc([ex('민수', 10000, ['나', '지영', '민수'])], PS));
  assert.deepEqual(r.owe, { 민수: 3334, 나: 3333, 지영: 3333 });
  assert.deepEqual(r.tr, [{ f: '나', t: '민수', v: 3333 }, { f: '지영', t: '민수', v: 3333 }]);
});

test('낸 사람이 나눌 사람에 없으면 낸 사람 몫은 0', () => {
  const r = plain(settleCalc([ex('나', 20000, ['민수', '지영'])], PS));
  assert.equal(r.owe['나'] ?? 0, 0);
  assert.deepEqual(r.tr, [{ f: '민수', t: '나', v: 10000 }, { f: '지영', t: '나', v: 10000 }]);
});

test('나눌 사람이 비어 있으면 낸 사람 혼자 쓴 것 (주고받을 돈 없음)', () => {
  const r = plain(settleCalc([ex('지영', 7000, [])], PS));
  assert.equal(r.total, 7000);
  assert.deepEqual(r.owe, { 지영: 7000 });
  assert.deepEqual(r.tr, []);
});

test('여러 건이 섞이면 서로 상쇄한 뒤 보낼 돈만', () => {
  // 나 30,000 (셋) + 민수 12,000 (셋) → 나 +16,000 / 민수 -2,000 / 지영 -14,000
  const r = plain(settleCalc([ex('나', 30000, PS), ex('민수', 12000, PS)], PS));
  assert.deepEqual(r.tr, [{ f: '지영', t: '나', v: 14000 }, { f: '민수', t: '나', v: 2000 }]);
  assert.deepEqual(r.names, PS); // 표의 사람 순서 = 사람 목록 순서
});

test('아무렇게나 만든 경비 200묶음: 몫의 합 = 총 지출, 정산대로 보내면 모두 0원', () => {
  let seed = 7;
  const rnd = n => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const people = ['나', '민수', '지영', '현우', '수아'];
  for (let round = 0; round < 200; round++) {
    const list = Array.from({ length: 1 + rnd(8) }, () => {
      const payer = people[rnd(people.length)];
      const split = people.filter(() => rnd(3) > 0);
      return ex(payer, 100 + rnd(200000), split);
    });
    const r = plain(settleCalc(list, people));
    const oweSum = Object.values(r.owe).reduce((s, v) => s + v, 0);
    assert.equal(oweSum, r.total, `몫 합계가 다름 (묶음 ${round})`);
    const bal = { ...r.bal };
    r.tr.forEach(({ f, t, v }) => { bal[f] += v; bal[t] -= v; });
    for (const [n, v] of Object.entries(bal)) assert.equal(v, 0, `${n} 정산 뒤 ${v}원 남음 (묶음 ${round})`);
  }
});

// ----- 가계부의 '여행 N빵 내 몫' -----
const SHARE_FNS = ['myShares', 'live', 'cleanTrip', 'cleanArr', 'cleanExp', 'cleanBase', 'isUid', 'num', 'str', 'cleanEnds', 'cleanEndPt', 'todayPlus', 'dayDateT'];
const shares = ({ nick = '', trip, exps, archive = {} }) => {
  const { myShares } = load(SHARE_FNS, { trip, exps, archive, myNick: () => nick });
  return plain(myShares());
};
const TRIP = { start: '2026-10-20', days: 3, from: 7, to: 23, name: '제주', people: [] };
const EXPS = [
  { uid: 'e1', upd: 1, title: '흑돼지', amt: 60000, payer: '민수', split: ['나', '민수', '지영'], day: 1 },
  { uid: 'e2', upd: 1, title: '렌터카', amt: 10000, payer: '나', split: ['민수', '나', '지영'], day: 0 },
  { uid: 'e3', upd: 1, title: '민수 커피', amt: 5000, payer: '민수', split: ['민수'], day: 0 },
  { uid: 'e4', upd: 1, title: '지운 것', amt: 99000, payer: '나', split: ['나'], day: 0, del: true },
];

test('가계부에는 낸 돈이 아니라 내 몫만, 날짜는 그 일차 날짜로', () => {
  const r = shares({ trip: TRIP, exps: EXPS });
  assert.deepEqual(r.map(x => [x.uid, x.d, x.amt, x.cat, x.virtual, x.pay]), [
    ['te1', '2026-10-21', 20000, 'trip', true, '민수 냄'],
    ['te2', '2026-10-20', 3334, 'trip', true, '나 냄'], // 10,000원을 냈어도 내 몫 3,334원만 (자투리는 낸 사람)
  ]);
  assert.equal(r[0].title, '흑돼지 (3명 N빵)');
  assert.equal(r[0].trip, '제주');
});

test('내가 안 낀 경비·지운 경비는 안 들어감', () => {
  const r = shares({ trip: TRIP, exps: EXPS });
  assert.ok(!r.some(x => x.uid === 'te3' || x.uid === 'te4'));
});

test('보관함 여행도 포함하고, 같은 경비(같은 uid)는 한 번만', () => {
  const archive = {
    a1: { data: { trip: { start: '2026-09-01', days: 2, name: '부산' }, exps: [
      { uid: 'x1', upd: 1, title: '회', amt: 50000, payer: '나', split: ['나', '친구'], day: 1 },
      { uid: 'e1', upd: 1, title: '흑돼지', amt: 60000, payer: '민수', split: ['나', '민수', '지영'], day: 1 },
    ] } },
    a2: { del: true, data: { trip: { start: '2026-08-01', days: 1 }, exps: [{ uid: 'z1', upd: 1, amt: 1000, payer: '나', split: ['나'], day: 0 }] } },
  };
  const r = shares({ trip: TRIP, exps: EXPS, archive });
  assert.deepEqual(r.map(x => [x.uid, x.d, x.amt, x.trip]), [
    ['te1', '2026-10-21', 20000, '제주'],
    ['te2', '2026-10-20', 3334, '제주'],
    ['tx1', '2026-09-02', 25000, '부산'],
  ]);
});

test('별명으로 기록된 경비도 내 것으로 (별명 · "나" 둘 다)', () => {
  const r = shares({ nick: '정길', trip: TRIP, exps: [
    { uid: 'n1', upd: 1, title: '점심', amt: 30000, payer: '정길', split: ['정길', '민수'], day: 0 },
    { uid: 'n2', upd: 1, title: '예전 기록', amt: 8000, payer: '민수', split: ['나', '민수'], day: 0 },
  ] });
  assert.deepEqual(r.map(x => [x.uid, x.amt]), [['tn1', 15000], ['tn2', 4000]]);
});

test('가계부의 내 몫 합계 = 경비 화면 정산표의 내 몫', () => {
  const r = shares({ trip: TRIP, exps: EXPS });
  const live = EXPS.filter(e => !e.del);
  const s = plain(settleCalc(live, PS));
  assert.equal(r.reduce((sum, x) => sum + x.amt, 0), s.owe['나']);
});
