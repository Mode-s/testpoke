const fs = require('node:fs');
const assert = require('node:assert/strict');
const { loadLogic, replay, restoreAI } = require('./audit-guard-counterfactual.cjs');
function save(report) {
  fs.writeFileSync('battle-lookahead-guards.json', JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync('battle-lookahead-guards.md', ['# 導入前に防御した17場面の判断比較', '',
    '前回保存した対戦の同じ公開盤面・自分のrequestから深さ0/1/2で判断する。元の対戦ログの再現一致を確認。実際の相手行動や、前回監査の分岐勝敗は先読みへ渡さない。ここでの予測値は勝率ではない。各場面の採用後の勝敗は、別の同条件対戦比較で確認する。', '',
    '| 編成・乱数 | ターン | 元の防御 | 深さ0 | 深さ1 | 深さ2 | 深さ2の比較状況 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((row) => `| ${row.team} / ${row.seed.join(',')} | ${row.turn} | ${row.original} | ${row.decisions[0].label} | ${row.decisions[1].label} | ${row.decisions[2].label} | 深さ${row.decisions[2].depth}・${row.decisions[2].reason}・${row.decisions[2].nodes}回 |`), '',
  ].join('\n'));
}
const report = { cases: [] };
const original = JSON.parse(fs.readFileSync('battle-disruption-benchmark.json', 'utf8'));
for (const game of original.games.filter((row) => row.enabled && row.guards)) {
  const replayed = replay(game);
  for (const frame of replayed.frames.filter((row) => row.guard)) {
    const row = { team: game.ownTeam, foeTeam: game.foeTeam, seed: game.seed, turn: frame.turn, original: frame.guard.id, decisions: [] };
    for (const depth of [0, 1, 2]) {
      const api = loadLogic(); restoreAI(api, frame.ai);
      const battle = api.Battle.fromJSON(frame.engine); api.stream.battle = battle;
      try {
        api.hiddenDisruptionPolicy.enabled = true; api.lookaheadPolicy.depth = depth;
        const request = battle.sides[game.subject === 'p1' ? 0 : 1].activeRequest;
        const before = JSON.stringify(battle.toJSON()); const start = Date.now();
        const action = api.chooseAction(game.subject, request); const decision = api.lookaheadDecisions.get(game.subject);
        assert.equal(JSON.stringify(battle.toJSON()), before, '判断の仮計算が実戦状態を書き換えた');
        const slot = Number(action.split(' ')[1]);
        const label = action.startsWith('move ') ? request.active[0].moves[slot - 1].id : `switch ${request.side.pokemon[slot - 1].details.split(',')[0]}`;
        row.decisions.push({ depth: decision?.rows[0]?.depth || 0, action, label, elapsedMs: Date.now() - start,
          reason: decision?.reason, nodes: decision?.nodes || 0, override: !!decision?.override,
          rows: decision?.rows.map((row) => ({ action: row.action, value: row.value, depth: row.depth, plans: row.plans })) || [] });
        console.log(`${game.ownTeam} seed=${game.seed[0]} ${frame.turn}T depth=${depth} → ${label} ${decision?.reason}`);
      } finally { api.stream.battle = null; battle.destroy(); }
    }
    report.cases.push(row); save(report);
  }
}
assert.equal(report.cases.length, 17); console.log('全17場面の比較と実戦状態の不変性を確認');
