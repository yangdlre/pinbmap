// 옛 아이폰(iOS 16.4 미만)에서 앱 전체가 멈추는 문법이 없는지
import test from 'node:test';
import assert from 'node:assert/strict';
import { SRC } from './harness.mjs';

test('정규식 뒤보기 (?<= (?<! 를 쓰지 않음', () => {
  const hits = SRC.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\(\?<[=!]/.test(l));
  assert.deepEqual(hits.map(([n, l]) => n + ': ' + l.trim().slice(0, 80)), []);
});
