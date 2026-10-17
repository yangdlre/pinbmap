// 검사용 장치: index.html 안의 <script>에서 이름으로 함수·상수를 꺼내 node에서 돌린다.
// 앱 코드를 고치지 않고 계산·판정 함수만 따로 시험하기 위한 것 (화면·지도·서버는 안 씀).
//
//   const { parseSms } = load(['parseSms', 'guessCat', ...], { nowKST: () => ({ d: '2026-10-16', m: 600 }) });
//
// - names : 꺼낼 선언 이름 (function 선언 또는 const/let/var 선언). 안쪽 함수도 이름으로 찾음.
// - stubs : 꺼내지 않은 것 대신 쓸 값 (lsGet·nowKST 같은 화면/저장 쪽 함수, trip 같은 전역 값)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as acorn from 'acorn';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(ROOT + 'index.html', 'utf8');

// 이름 없는 인라인 <script> 중 가장 긴 것이 앱 본체
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) throw new Error('index.html에서 <script>를 찾지 못함');
export const SRC = scripts.sort((a, b) => b.length - a.length)[0];

let ast;
try {
  ast = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script' });
} catch (e) {
  throw new Error('index.html 스크립트 문법 오류: ' + e.message);
}

// 이름 → 선언 원문 (같은 이름이 여럿이면 바깥쪽·앞쪽 것을 씀)
const decl = new Map();
(function walk(node) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'FunctionDeclaration' && node.id && !decl.has(node.id.name)) {
    decl.set(node.id.name, SRC.slice(node.start, node.end));
  } else if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier' && !decl.has(d.id.name)) {
        decl.set(d.id.name, `${node.kind} ${SRC.slice(d.start, d.end)};`);
      }
    }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v.type === 'string') walk(v);
  }
})(ast);

export function has(name) {
  return decl.has(name);
}

export function load(names, stubs = {}) {
  const missing = names.filter(n => !decl.has(n));
  if (missing.length) throw new Error('index.html에 없음: ' + missing.join(', '));
  const code = names.map(n => decl.get(n)).join('\n') + `\n;({${names.join(',')}})`;
  const ctx = vm.createContext({ ...stubs });
  return vm.runInContext(code, ctx, { filename: 'index.html(발췌)' });
}

// 여러 검사에서 같이 쓰는 기본 대역
export const fixedNow = (d = '2026-10-16', m = 600) => () => ({ d, m });
export const lsDefault = (_k, def) => def; // 저장된 값 없음 = 기본값
// vm 안에서 만든 객체는 프로토타입이 달라 deepStrictEqual이 실패하므로 평범한 객체로 바꿔 비교
export const plain = x => JSON.parse(JSON.stringify(x));
