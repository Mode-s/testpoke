const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'battle-from-json.cjs'), 'utf8');
const context = vm.createContext({ require, process, console: { ...console, log() {} } });
vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context);
const api = vm.runInContext('({ moves, rosterByShowdownId, learnsetByName, moveByChampionsId, battleDex, battleState, hiddenDisruptionMoves, hiddenDisruptionKinds, isMoveAllowed })', context);
const candidates = new Set();
for (const entry of api.rosterByShowdownId.values()) {
  api.battleState.p2.species = api.battleDex.species.get(entry.showdownId).name;
  for (const move of api.hiddenDisruptionMoves('p2', api.battleState.p2.species)) candidates.add(move.id);
}
// コールバック依存の効果は技定義とは別の期待一覧で照合する。
const expected = new Map([
  ...['stockpile', 'stuffcheeks', 'acupressure', 'focusenergy', 'laserfocus', 'bellydrum', 'psychup', 'transform', 'tailwind', 'trickroom'].map((id) => [id, '特殊な積み・展開']),
  ...['stoneaxe', 'ceaselessedge', 'courtchange'].map((id) => [id, '特殊な設置']),
  ...['taunt', 'encore', 'disable', 'imprison', 'torment', 'spite', 'trick', 'switcheroo', 'haze', 'clearsmog', 'spectralthief', 'throatchop', 'saltcure', 'spiritshackle', 'jawlock', 'yawn', 'perishsong', 'destinybond', 'fling'].map((id) => [id, '特殊な状態・制限']),
]);
const rows = api.moves.map((entry) => {
  const move = api.battleDex.moves.get(entry.showdownId);
  const kinds = Array.from(api.hiddenDisruptionKinds(move));
  const effects = [move, move.self, ...(move.secondaries || (move.secondary ? [move.secondary] : []))].filter(Boolean);
  const structural = effects.some((effect) => effect.status || effect.volatileStatus || effect.boosts || effect.self?.boosts || effect.self?.volatileStatus || effect.forceSwitch || effect.sideCondition);
  const required = api.isMoveAllowed(move) && !move.stallingMove && !['wideguard', 'quickguard'].includes(move.id) &&
    (move.category !== 'Status' || (structural && (move.target !== 'self' || move.boosts)) || expected.has(move.id));
  return { name: entry.name, id: move.id, allowed: api.isMoveAllowed(move), kinds, learnedCandidate: candidates.has(move.id),
    required, gap: required && !kinds.length, effect: entry.effect, callbackReview: expected.get(move.id) || null };
});
const gaps = rows.filter((row) => row.gap);
const oldSource = path.join(__dirname, '.battle-disruption-before.tmp');
let beforeMissing = [];
if (fs.existsSync(oldSource)) {
  const original = fs.readFileSync(oldSource, 'utf8');
  const old = vm.createContext({ require, process, console: { ...console, log() {} } });
  vm.runInContext(original.slice(0, original.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', old);
  const previous = vm.runInContext('({ rosterByShowdownId, battleState, battleDex, hiddenDisruptionMoves })', old);
  const ids = new Set();
  for (const entry of previous.rosterByShowdownId.values()) {
    previous.battleState.p2.species = previous.battleDex.species.get(entry.showdownId).name;
    for (const move of previous.hiddenDisruptionMoves('p2', previous.battleState.p2.species)) ids.add(move.id);
  }
  beforeMissing = rows.filter((row) => row.learnedCandidate && !ids.has(row.id)).map((row) => ({ name: row.name, id: row.id }));
} else if (fs.existsSync('battle-disruption-coverage.json')) {
  // 一時的な比較元を削除した後も、今回の監査で記録した追加一覧を保持する。
  const previous = JSON.parse(fs.readFileSync('battle-disruption-coverage.json', 'utf8'));
  beforeMissing = (previous.beforeMissing || []).filter((entry) => candidates.has(entry.id));
}
const report = { total: rows.length, classified: rows.filter((row) => row.kinds.length).length,
  learnedCandidates: candidates.size, gaps, beforeMissing, rows };
fs.writeFileSync('battle-disruption-coverage.json', JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync('battle-disruption-coverage.md', [
  '# 未公開重大技の候補抽出監査', '',
  '候補への分類と実際の習得表を照合する監査。成功条件・重大性・選択率の保証ではない。攻撃の追加効果は発動率を付けて評価し、純粋な攻撃は対面ごとのKO上限で絞る。', '',
  `対象${rows.length}技、分類${report.classified}技、習得候補${candidates.size}技、抽出漏れ${gaps.length}技。`, '',
  '## 今回候補に加わった技', '', ...beforeMissing.map((row) => `- ${row.name} (${row.id})`), '',
  '## 全技の分類', '', '| 技 | ID | 種類 | 習得候補 |', '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.id} | ${row.kinds.join(', ') || '対象外'} | ${row.learnedCandidate ? 'あり' : 'なし'} |`), '',
].join('\n'));
console.log(`対象${report.total}技、分類${report.classified}技、候補漏れ${gaps.length}技、追加${beforeMissing.length}技`);
if (gaps.length) { console.log(gaps.map((row) => row.id).join(', ')); process.exitCode = 1; }
