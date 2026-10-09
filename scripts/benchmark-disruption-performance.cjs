const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { percentile } = require('./benchmark-disruption.cjs');

const sourcePath = path.join(__dirname, 'battle-from-json.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const context = vm.createContext({ require, process, console: { ...console, log() {} } });
vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context, { filename: sourcePath });
const api = vm.runInContext(`({ battleDex, battleState, hiddenDisruptionOutcome, evaluateHiddenDisruption, hiddenDisruptionPolicy, hiddenDisruptionMetrics, hiddenDisruptionCache,
  rosterByShowdownId, learnsetByName, moveByChampionsId })`, context);
const mon = { details: 'Blastoise, L50', condition: '200/200', active: true, stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 100 },
  ability: 'torrent', item: '', moves: ['surf', 'icebeam', 'darkpulse', 'protect'] };
const request = { side: { pokemon: [mon] }, active: [{ moves: mon.moves.map((id) => ({ id, move: id, pp: 10, maxpp: 10, disabled: false })) }] };
api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Arcanine';
api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
const profile = { role: 'physical', ability: 'flashfire', item: 'leftovers', moves: ['flamethrower', 'wildcharge', 'protect', 'roar'], weight: 1 };
const workloads = [
  ['追加効果同士', 'icebeam', 'triattack'],
  ['連続攻撃と追加効果', 'darkpulse', 'bulletseed'],
  ['ランダム能力上昇', 'surf', 'acupressure'],
];
const results = [];
for (const [name, own, foe] of workloads) {
  const modes = [];
  for (const optimized of [false, true]) {
    api.hiddenDisruptionPolicy.optimize = optimized;
    const timings = [];
    let output;
    const startBranches = api.hiddenDisruptionMetrics.branches;
    for (let i = 0; i < 21; i++) {
      const start = process.hrtime.bigint();
      const result = api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: own, slot: 1 }, 'Arcanine', profile, api.battleDex.moves.get(foe));
      timings.push(Number(process.hrtime.bigint() - start) / 1e6);
      const serialized = JSON.stringify(result);
      if (output) assert.equal(serialized, output, `${name}: 同じ状態の再評価`);
      output = serialized;
    }
    modes.push({ optimized, medianMs: percentile(timings.slice(3), 0.5), branches: api.hiddenDisruptionMetrics.branches - startBranches, output });
  }
  assert.equal(modes[0].output, modes[1].output, `${name}: 再利用で全分岐の結果が変わらない`);
  results.push({ name, referenceMs: modes[0].medianMs, optimizedMs: modes[1].medianMs,
    referenceBranches: modes[0].branches, optimizedBranches: modes[1].branches,
    improvementPercent: (1 - modes[1].medianMs / modes[0].medianMs) * 100, exact: true });
}
const fullDecision = [];
mon.condition = '15/200'; mon.moves = ['surf', 'icebeam', 'darkpulse', 'hydropump'];
request.active[0].moves = mon.moves.map((id) => ({ id, move: id, pp: 10, maxpp: 10, disabled: false }));
api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'protect', 'roar']);
const scored = mon.moves.map((id, i) => ({ move: api.battleDex.moves.get(id), slot: i + 1, score: 100 - i * 10, minDamagePercent: 0, hitChance: 1 }));
for (const optimized of [false, true]) {
  api.hiddenDisruptionPolicy.optimize = optimized;
  const timings = []; let output;
  const before = { ...api.hiddenDisruptionMetrics };
  for (let i = 0; i < 4; i++) {
    api.hiddenDisruptionCache.clear();
    const start = process.hrtime.bigint();
    const result = api.evaluateHiddenDisruption('p1', request, scored, false);
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
    const serialized = JSON.stringify([result.override?.kind, result.override?.slot, result.reason, result.rows[0].loss]);
    if (output) assert.equal(serialized, output);
    output = serialized;
  }
  fullDecision.push({ optimized, medianMs: percentile(timings.slice(1), 0.5), scenarios: api.hiddenDisruptionMetrics.scenarios - before.scenarios,
    branches: api.hiddenDisruptionMetrics.branches - before.branches, skipped: api.hiddenDisruptionMetrics.skippedUnsafe - before.skippedUnsafe, output });
}
assert.equal(fullDecision[0].output, fullDecision[1].output);
fs.writeFileSync('battle-disruption-performance.json', JSON.stringify({ repetitions: 21, warmup: 3, results, fullDecision }, null, 2) + '\n');
fs.writeFileSync('battle-disruption-performance.md', ['# 同一分岐の再利用による性能比較', '',
  '同じプロセスで各分岐条件21回、初めの3回を時間集計から除外。最適化無効・有効でloss・行動順・確率・各分岐のHP/状態を完全一致確認。最終判断キャッシュを使わない計算なので、同一requestの最終判断キャッシュとは独立。', '',
  '| 場面 | 参照ms | 最適化ms | 改善率 | 実行分岐数 参照→最適化 | 結果一致 |', '| --- | --- | --- | --- | --- | --- |',
  ...results.map((row) => `| ${row.name} | ${row.referenceMs.toFixed(2)} | ${row.optimizedMs.toFixed(2)} | ${row.improvementPercent.toFixed(1)}% | ${row.referenceBranches}→${row.optimizedBranches} | 完全一致 |`), '',
  '## 破綻済み候補の省略を含む判断全体', '',
  '各4回、初回を時間集計から除外。毎回判断キャッシュを消去し、選択と最良攻撃の最悪値の一致を確認する。代替の省略後の不利は最悪値の下限であり、完全計算した値とは区別する。', '',
  ...fullDecision.map((row) => `- ${row.optimized ? '最適化' : '参照'}: 中央値${row.medianMs.toFixed(1)}ms、仮計算${row.scenarios}、実行分岐${row.branches}、安全でない代替の省略${row.skipped}。`), '',
  '時間は端末負荷・実行順序の影響を受ける。この局所比較から、全対戦の同率の高速化は主張しない。', '',
].join('\n'));
console.log(JSON.stringify({ results, fullDecision }, null, 2));
