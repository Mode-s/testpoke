const fs = require('node:fs');
const assert = require('node:assert/strict');
const { loadLogic, replay, restoreAI } = require('./audit-guard-counterfactual.cjs');
const comparison = JSON.parse(fs.readFileSync('battle-lookahead-benchmark.json', 'utf8'));
const game = comparison.games.find((row) => row.ownTeam === 'setup' && row.depth === 2);
assert.ok(game && game.ended);
const replayed = replay(game);
const frame = replayed.frames.find((row) => row.turn === 6);
const api = loadLogic(); restoreAI(api, frame.ai);
const battle = api.Battle.fromJSON(frame.engine); api.stream.battle = battle;
try {
  api.hiddenDisruptionPolicy.enabled = true; api.lookaheadPolicy.depth = 2;
  const request = battle.sides[0].activeRequest;
  const before = JSON.stringify(battle.toJSON());
  const action = api.chooseAction('p1', request);
  assert.equal(action, frame.actions.find((row) => row.player === 'p1').action);
  assert.equal(JSON.stringify(battle.toJSON()), before);
  const decision = api.lookaheadDecisions.get('p1'); const models = [];
  for (const [index, profile] of decision.profiles.entries()) for (const sample of [0, 1]) {
    const calc = api.createLookaheadBattle('p1', request, profile, sample, index);
    try { models.push({ ...profile, sample, responses: api.lookaheadResponses(calc, 'p2', api.lookaheadPolicy.maxFoeActions) }); }
    finally { calc.destroy(); }
  }
  const report = { team: game.ownTeam, foe: game.foeTeam, seed: game.seed, turn: frame.turn, action,
    decision, models, actualPublicLog: replayed.publicLog.slice(frame.logStart, frame.logEnd) };
  fs.writeFileSync('battle-lookahead-loss.json', JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync('battle-lookahead-loss.md', ['# 積み対設置の敗北分岐の確認', '',
    '保存対戦の全公開ログを再現一致させ、6ターン目の公開記録と自分のrequestから判断を再計算した。実際の相手技や分岐後の結果は予測へ渡していない。判断前後の実戦状態も完全一致。', '',
    `判断: ${action}。以下は勝率ではなく2ターン後の盤面評価。`, '',
    '| 初手 | 予測値 |', '| --- | --- |',
    ...decision.rows.map((row) => `| ${row.action.id || row.action.species} | ${row.value.toFixed(2)} |`), '',
    '| 構成 | サンプル | 初手の相手応答と重み |', '| --- | --- | --- |',
    ...models.map((row) => `| ${row.moves.join(', ')} | ${row.sample} | ${row.responses.map((response) => `${response.id || response.species}: ${(response.weight * 100).toFixed(1)}%`).join(' / ')} |`), '',
    '相手の行動は初手の自分の行動を知る前に選んでいる。候補構成と応答の絞り込みが実際の行動に合うとは限らず、少数サンプルで急所・追加効果を正確に網羅しているわけでもない。この1例に合わせて配点を変更した記録ではない。', '',
    '実際の当該ターンの公開ログ:', '', '```text', ...report.actualPublicLog.filter((line) => !line.startsWith('|t:|')), '```', '',
  ].join('\n'));
  console.log(JSON.stringify({ action, models, winner: game.winner }));
} finally { api.stream.battle = null; battle.destroy(); }
