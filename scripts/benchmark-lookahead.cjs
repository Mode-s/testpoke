const fs = require('node:fs');
const assert = require('node:assert/strict');
const { loadLogic, validateTeams, game, percentile, teams } = require('./benchmark-disruption.cjs');

function summarize(games) {
  return [0, 1, 2].map((depth) => {
    const group = games.filter((row) => row.depth === depth); const decisions = group.flatMap((row) => row.decisions);
    const following = { attack: 0, guard: 0, switch: 0, other: 0 };
    for (const row of group) for (let i = 0; i < row.decisions.length - 1; i++) if (row.decisions[i].guard) {
      const next = row.decisions[i + 1];
      following[next.guard ? 'guard' : next.action.startsWith('switch ') ? 'switch' : next.id && !['recover', 'roost', 'slackoff', 'shellsmash', 'swordsdance', 'dragondance', 'calmmind', 'stealthrock', 'spikes', 'toxic', 'thunderwave', 'sleeppowder', 'taunt', 'willowisp', 'destinybond', 'whirlwind'].includes(next.id) ? 'attack' : 'other']++;
    }
    return { depth, games: group.length, wins: group.filter((row) => row.win).length,
      losses: group.filter((row) => row.ended && row.winner === 'Control').length, capped: group.filter((row) => !row.ended).length,
      guards: group.reduce((sum, row) => sum + row.guards, 0), switches: group.reduce((sum, row) => sum + row.switches, 0),
      backtracks: group.reduce((sum, row) => sum + row.backtracks, 0), following,
      heal: decisions.filter((row) => ['recover', 'roost', 'slackoff'].includes(row.id)).length,
      setup: decisions.filter((row) => ['shellsmash', 'swordsdance', 'dragondance', 'calmmind'].includes(row.id)).length,
      missedCertainKOs: group.reduce((sum, row) => sum + row.missedCertainKOs, 0), certainKOs: group.reduce((sum, row) => sum + row.certainKOs, 0),
      medianMs: percentile(decisions.map((row) => row.elapsedMs), 0.5), p95Ms: percentile(decisions.map((row) => row.elapsedMs), 0.95),
      lookaheadOverrides: decisions.filter((row) => row.lookahead?.override).length,
      completeTwoTurn: decisions.filter((row) => row.lookahead?.depth === 2).length,
      oneTurnFallbacks: decisions.filter((row) => row.lookahead?.reason === 'first-turn-fallback').length,
      budgetFallbacks: decisions.filter((row) => row.lookahead?.reason === 'incomplete-first-turn').length,
      errors: decisions.filter((row) => row.lookahead?.reason === 'simulation-error').length,
      maxNodes: Math.max(0, ...decisions.map((row) => row.lookahead?.nodes || 0)) };
  });
}
function save(report, filename) {
  report.summary = summarize(report.games);
  fs.writeFileSync(`${filename}.json`, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(`${filename}.md`, ['# 先読みなし・1ターン・2ターンの同条件比較', '',
    `同じ登録編成・選出・開始乱数・先後で、比較対象側の深さだけを0/1/2へ変更する。相手は従来判断・重大技評価無効・先読みなしへ固定。比較対象側の重大技評価は全モードで有効。${report.openSheets ? '特性・持ち物を公開した条件。4技は未公開。' : '相手の特性・持ち物・4技は通常ログで判明するまで未公開。'}命中・追加効果・通常急所等は実戦エンジンの乱数で処理する。深さで行動が変われば、その後の乱数の消費も変わる。`, '',
    '少数の固定編成による動作比較であり、一般的な勝率改善の証明ではない。先読み自体は公開情報から作った最大3構成・各2乱数サンプルによる近似。未公開重大技の安全条件は期待値と分けて保持する。', '',
    '判断時間は既存の技評価・重大技評価を含む端末上の実測。深さによって到達盤面と判断回数も変わるため、差は先読みだけの追加時間ではない。防御の次の行動は次の自分の判断を分類し、交代には倒れた後の交代も含む。往復は自分の交代履歴で2つ前の種族へ戻った回数。', '',
    '| 深さ | 対戦 | 勝/負/打切り | 防御 | 交代 | 往復 | 防御→攻撃/防御/交代/その他 | 回復 | 積み | 確定KO見送り | 判断中央値ms | 95%点ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.summary.map((row) => `| ${row.depth} | ${row.games} | ${row.wins}/${row.losses}/${row.capped} | ${row.guards} | ${row.switches} | ${row.backtracks} | ${Object.values(row.following).join('/')} | ${row.heal} | ${row.setup} | ${row.missedCertainKOs}/${row.certainKOs} | ${row.medianMs.toFixed(1)} | ${row.p95Ms.toFixed(1)} |`), '',
    '| 深さ | 先読み変更 | 2ターン比較完了 | 1ターンへ戻る | 通常判断へ戻る | 仮計算エラー | 最大ノード |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.summary.map((row) => `| ${row.depth} | ${row.lookaheadOverrides} | ${row.completeTwoTurn} | ${row.oneTurnFallbacks} | ${row.budgetFallbacks} | ${row.errors} | ${row.maxNodes} |`), '',
    '| 編成 | 相手 | 乱数 | 側 | 深さ | 勝敗 | 終局ターン | 防御 | 交代 | 往復 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.games.map((row) => `| ${row.ownTeam} | ${row.foeTeam} | ${row.seed.join(',')} | ${row.subject} | ${row.depth} | ${!row.ended ? '打切り' : row.win ? '勝' : '負'} | ${row.turns} | ${row.guards} | ${row.switches} | ${row.backtracks} |`), '',
  ].join('\n'));
}
if (require.main === module) {
  const api = loadLogic(); validateTeams(api);
  const filename = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) || 'battle-lookahead-benchmark';
  const pairs = [['attack', 'bulky'], ['bulky', 'setup'], ['setup', 'hazard'], ['hazard', 'attack']];
  const report = { openSheets: process.argv.includes('--open-sheets'), teams, games: [] };
  const seeds = process.argv.includes('--two-seeds') ? [[17, 29, 41, 53], [31, 43, 59, 71]] : [[17, 29, 41, 53]];
  for (const [own, foe] of pairs) for (const [i, seed] of seeds.entries()) for (const depth of [0, 1, 2]) {
    const result = game(own, foe, seed, i % 2 ? 'p2' : 'p1', true, depth);
    assert.equal(result.decisions.filter((row) => row.lookahead?.reason === 'simulation-error').length, 0, '先読みの仮計算エラー');
    report.games.push(result); save(report, filename);
    console.log(`${own}/${foe} seed=${seed[0]} depth=${depth} ${result.winner || '打切り'} ${result.turns}T 防御${result.guards} 往復${result.backtracks} 中央値${result.timing.medianMs.toFixed(1)}ms`);
  }
  console.log(JSON.stringify(report.summary));
}
module.exports = { summarize, save };
