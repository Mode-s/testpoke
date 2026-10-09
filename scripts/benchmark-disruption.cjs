const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// 製品の判断関数をそのまま使い、比較用の対戦を別プロセスで実行する。
function loadLogic() {
  const filename = path.join(__dirname, 'battle-from-json.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const context = vm.createContext({ require, process, console: { ...console, log() {} } });
  vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context, { filename });
  return vm.runInContext(`({ Battle, Teams, FORMAT, validator, battleDex, rosterByShowdownId, learnsetByName, moveByChampionsId,
    stream, teamA, latestRequests, updateBattleState, battleState, chooseAction, selectHiddenDisruption,
    hiddenDisruptionPolicy, hiddenDisruptionMetrics, hiddenDisruptionDecisions })`, context);
}
function member(species, ability, item, moves, offense = 'atk', nature = 'Adamant') {
  return { species, ability, item, moves, nature, level: 100, evs: { hp: 32, [offense]: 32, spe: 2 } };
}
const teams = {
  attack: [
    member('Arcanine', 'Intimidate', 'Life Orb', ['Flare Blitz', 'Extreme Speed', 'Wild Charge', 'Close Combat']),
    member('Blastoise', 'Torrent', 'White Herb', ['Surf', 'Ice Beam', 'Dark Pulse', 'Shell Smash'], 'spa', 'Modest'),
    member('Venusaur', 'Overgrow', 'Sitrus Berry', ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Earth Power'], 'spa', 'Modest'),
  ],
  bulky: [
    member('Slowbro', 'Regenerator', 'Leftovers', ['Slack Off', 'Surf', 'Thunder Wave', 'Calm Mind'], 'def', 'Bold'),
    member('Corviknight', 'Pressure', 'Rocky Helmet', ['Roost', 'Iron Defense', 'Body Press', 'Brave Bird'], 'def', 'Impish'),
    member('Toxapex', 'Regenerator', 'Sitrus Berry', ['Recover', 'Surf', 'Toxic', 'Baneful Bunker'], 'def', 'Bold'),
  ],
  setup: [
    member('Scizor', 'Technician', 'Leftovers', ['Swords Dance', 'Bullet Punch', 'X-Scissor', 'Roost']),
    member('Gyarados', 'Intimidate', 'Lum Berry', ['Dragon Dance', 'Waterfall', 'Earthquake', 'Taunt']),
    member('Blastoise', 'Torrent', 'White Herb', ['Shell Smash', 'Surf', 'Ice Beam', 'Protect'], 'spa', 'Modest'),
  ],
  hazard: [
    member('Steelix', 'Sturdy', 'Leftovers', ['Stealth Rock', 'Earthquake', 'Heavy Slam', 'Protect']),
    member('Skarmory', 'Sturdy', 'Rocky Helmet', ['Spikes', 'Roost', 'Whirlwind', 'Brave Bird'], 'def', 'Impish'),
    member('Gengar', 'Cursed Body', 'Focus Sash', ['Shadow Ball', 'Sludge Bomb', 'Will-O-Wisp', 'Destiny Bond'], 'spa', 'Modest'),
  ],
};
function validateTeams(api) {
  for (const [name, team] of Object.entries(teams)) {
    // 6匹登録・3匹選出のルールを守る。後半3匹は選出しない固定控え。
    for (const reserve of api.teamA) {
      if (team.length >= 6) break;
      if (team.some((mon) => api.battleDex.species.get(mon.species).id === api.battleDex.species.get(reserve.species).id)) continue;
      team.push({ ...JSON.parse(JSON.stringify(reserve)), item: '' });
    }
    assert.equal(api.validator.validateTeam(team), null, `${name}: エンジンの合法性`);
    for (const mon of team) {
      const id = api.battleDex.species.get(mon.species).id;
      const master = api.rosterByShowdownId.get(id);
      assert.ok(master, `${mon.species}: Champions対象`);
      const learned = new Set(api.learnsetByName.get(master.name).map((row) => api.moveByChampionsId.get(row.id)?.showdownId));
      for (const move of mon.moves) assert.ok(learned.has(api.battleDex.moves.get(move).id), `${mon.species}: ${move}は習得表にない`);
    }
  }
}
function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] || 0;
}
function game(ownTeam, foeTeam, seed, subject, enabled) {
  const api = loadLogic();
  api.hiddenDisruptionPolicy.optimize = !process.argv.includes('--reference');
  const choices = [];
  const publicLog = [];
  const histories = { p1: [], p2: [] };
  const disclosed = new Set();
  const sheets = { [subject]: teams[ownTeam], [subject === 'p1' ? 'p2' : 'p1']: teams[foeTeam] };
  const battle = new api.Battle({ formatid: api.FORMAT, seed,
    send(type, data) {
      if (type !== 'update') return;
      const lines = Array.isArray(data) ? data : data.split('\n');
      const shared = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('|split|')) { i++; continue; }
        shared.push(lines[i]);
      }
      publicLog.push(...shared);
      api.updateBattleState(shared.join('\n'));
      if (process.argv.includes('--open-sheets')) for (const line of shared) {
        const fields = line.split('|');
        if (!['switch', 'drag'].includes(fields[1])) continue;
        const player = fields[2].slice(0, 2);
        const species = fields[3].split(',')[0];
        const key = `${player}:${species}`;
        if (disclosed.has(key)) continue;
        disclosed.add(key);
        // この比較条件では特性・持ち物だけ事前公開。4技は相手へ公開しない。
        const sheet = sheets[player].find((row) => api.battleDex.species.get(row.species).name === species);
        const disclosure = [`|-ability|${fields[2]}|${sheet.ability}`, ...(sheet.item ? [`|-item|${fields[2]}|${sheet.item}`] : [])];
        publicLog.push(...disclosure);
        api.updateBattleState(disclosure.join('\n'));
      }
    },
  });
  api.stream.battle = battle;
  try {
    battle.setPlayer(subject, { name: 'Subject', team: api.Teams.pack(teams[ownTeam]) });
    battle.setPlayer(subject === 'p1' ? 'p2' : 'p1', { name: 'Control', team: api.Teams.pack(teams[foeTeam]) });
    battle.sendUpdates();
    for (const player of ['p1', 'p2']) assert.equal(battle.choose(player, 'team 123'), true);
    battle.sendUpdates();
    for (let step = 0; step < 220 && !battle.ended && battle.turn <= 100; step++) {
      const pending = battle.sides.map((side) => ({ player: side.id, request: side.activeRequest }));
      for (const { player, request } of pending) {
        if (!request || request.wait) continue;
        api.latestRequests[player] = request;
        api.hiddenDisruptionPolicy.enabled = enabled && player === subject;
        api.hiddenDisruptionPolicy.trace = process.argv.includes('--trace');
        api.hiddenDisruptionDecisions.delete(player);
        const oldMetrics = { ...api.hiddenDisruptionMetrics };
        const recent = Array.from(api.battleState[player].recentSpecies || []);
        const began = process.hrtime.bigint();
        if (process.argv.includes('--trace')) console.error(`判断開始 ${ownTeam}/${foeTeam} ${enabled} turn=${battle.turn} ${player}`);
        const action = api.chooseAction(player, request);
        if (process.argv.includes('--trace')) console.error(`判断終了 ${action}`);
        const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
        const decision = api.hiddenDisruptionDecisions.get(player);
        const slot = Number(action.split(' ')[1]);
        const id = action.startsWith('move ') ? request.active[0].moves[slot - 1]?.id : null;
        const species = action.startsWith('switch ') ? request.side.pokemon[slot - 1].details.split(',')[0] : null;
        const history = histories[player];
        const backtrack = !!species && history.length >= 2 && history.at(-2) === species;
        if (species) history.push(species);
        if (!history.length) history.push(api.battleState[player].species);
        const metrics = Object.fromEntries(Object.entries(api.hiddenDisruptionMetrics).map(([key, value]) => [key, value - oldMetrics[key]]));
        choices.push({ turn: battle.turn, player, action, id, elapsedMs, backtrack, metrics,
          guard: !!id && !!api.battleDex.moves.get(id).stallingMove,
          certainFirstKO: !!decision?.certainFirstKO,
          retainedCertainKO: !decision?.certainFirstKO || action.startsWith(`move ${decision.slot}`),
          override: !!decision?.override && decision.override.slot === slot && action.startsWith(decision.override.kind),
          reason: decision?.reason, rows: decision?.rows ? JSON.parse(JSON.stringify(decision.rows)) : null, recent });
        assert.equal(battle.choose(player, action), true, `${player} ${action}は受理されない`);
      }
      battle.sendUpdates();
    }
    assert.ok(!publicLog.some((line) => /NaN|Invalid choice|\|error\|/.test(line)), '対戦に不正な出力');
    const own = choices.filter((row) => row.player === subject);
    const firstKOs = own.filter((row) => row.certainFirstKO);
    return { ownTeam, foeTeam, seed, subject, enabled, ended: battle.ended, winner: battle.winner || null,
      turns: battle.turn, win: battle.winner === 'Subject', choices: own.length,
      guards: own.filter((row) => row.guard).length, switches: own.filter((row) => row.action.startsWith('switch ')).length,
      backtracks: own.filter((row) => row.backtrack).length, overrides: own.filter((row) => row.override).length,
      certainKOs: firstKOs.length, missedCertainKOs: firstKOs.filter((row) => !row.retainedCertainKO).length,
      timing: { medianMs: percentile(own.map((row) => row.elapsedMs), 0.5), p95Ms: percentile(own.map((row) => row.elapsedMs), 0.95),
        maxMs: Math.max(...own.map((row) => row.elapsedMs)), totalMs: own.reduce((sum, row) => sum + row.elapsedMs, 0) },
      decisions: own, publicLog };
  } finally { api.stream.battle = null; battle.destroy(); }
}
function save(report, filename, api) {
  const sensitivity = [[60, 30], [80, 40], [100, 50]].map(([limit, margin]) => {
    const decisions = report.games.filter((row) => row.enabled).flatMap((row) => row.decisions).filter((row) => row.rows);
    const complete = decisions.filter((row) => limit <= 80 || row.rows.every((choice) => choice.lossComplete !== false));
    return { limit, margin, evaluatedCases: complete.length, excludedCases: decisions.length - complete.length,
      overrides: complete.filter((row) => api.selectHiddenDisruption(row.rows, row.recent, { limit, margin, opportunityWeight: 0.5 }).override).length };
  });
  report.sensitivity = sensitivity;
  fs.writeFileSync(filename + '.json', JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(filename + '.md', ['# 未公開重大技の固定乱数比較', '',
    `4種類の合法6匹登録・3匹固定選出。${report.openSheets ? '特性・持ち物を公開した条件。相手の4技は未公開のまま。' : '特性・持ち物は通常ログで判明するまで未公開。'}対戦相手は従来判断に固定し、比較対象側だけ評価を切り替える。同じ編成・乱数・先後で比較する。100ターン超は打切りとして記録する。確定KOの維持件数は評価有効時の確認可能な場面のみ。少数の固定編成による動作確認であり、一般的な勝率の推定ではない。`, '',
    '| 編成 | 相手 | 乱数 | 側 | 評価 | 勝敗 | ターン | まもる | 交代 | 往復 | 判断変更 | 確定KO見送り | 中央値ms | 95%点ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.games.map((row) => `| ${row.ownTeam} | ${row.foeTeam} | ${row.seed.join(',')} | ${row.subject} | ${row.enabled ? '有効' : '無効'} | ${!row.ended ? '打切り' : row.win ? '勝' : '負'} | ${row.turns} | ${row.guards} | ${row.switches} | ${row.backtracks} | ${row.overrides} | ${row.enabled ? `${row.missedCertainKOs}/${row.certainKOs}` : '対象外'} | ${row.timing.medianMs.toFixed(1)} | ${row.timing.p95Ms.toFixed(1)} |`), '',
    '## 保存した同一場面での基準感度', '',
    ...sensitivity.map((row) => `- 不利${row.limit}・改善${row.margin}: ${row.overrides}件の変更（比較可能${row.evaluatedCases}場面、省略値のため除外${row.excludedCases}場面）。`), '',
    '別基準の勝敗を再対戦した数字ではない。全行動が合法に受理されたこと、往復・まもるの選択数、評価が確認した確定先手KOの維持を比較する。', '',
  ].join('\n'));
}
function compareReports(before, after) {
  return before.games.map((reference) => {
    const optimized = after.games.find((row) => row.ownTeam === reference.ownTeam && row.foeTeam === reference.foeTeam &&
      row.subject === reference.subject && row.enabled === reference.enabled && JSON.stringify(row.seed) === JSON.stringify(reference.seed));
    assert.ok(optimized, `${reference.ownTeam}: 比較相手の対戦がない`);
    assert.deepEqual(optimized.decisions.map((row) => row.action), reference.decisions.map((row) => row.action), '最適化で行動が変わった');
    const normalize = (game) => game.publicLog.filter((line) => !line.startsWith('|t:|'));
    assert.deepEqual(normalize(optimized), normalize(reference), '時刻を除いた対戦経過が変わった');
    const scenarios = (game) => game.decisions.reduce((sum, row) => sum + row.metrics.scenarios, 0);
    return { team: reference.ownTeam, enabled: reference.enabled, actionsIdentical: true, battleIdentical: true,
      referenceMedianMs: reference.timing.medianMs, optimizedMedianMs: optimized.timing.medianMs,
      referenceScenarios: scenarios(reference), optimizedScenarios: scenarios(optimized) };
  });
}
if (require.main === module) {
  if (process.argv.includes('--compare')) {
    const rows = compareReports(JSON.parse(fs.readFileSync('battle-disruption-benchmark-before.json', 'utf8')),
      JSON.parse(fs.readFileSync('battle-disruption-benchmark.json', 'utf8')));
    fs.writeFileSync('battle-disruption-optimization-comparison.json', JSON.stringify(rows, null, 2) + '\n');
    fs.writeFileSync('battle-disruption-optimization-comparison.md', ['# 最適化前後の同一対戦比較', '',
      '同じ編成・乱数・評価設定を比較。自分の全選択と、時刻を除いた両側の全対戦ログを完全一致確認。', '',
      '| 編成 | 評価 | 行動・対戦一致 | 参照中央値ms | 最適化中央値ms | 仮計算数 参照→最適化 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map((row) => `| ${row.team} | ${row.enabled ? '有効' : '無効'} | 一致 | ${row.referenceMedianMs.toFixed(1)} | ${row.optimizedMedianMs.toFixed(1)} | ${row.referenceScenarios}→${row.optimizedScenarios} |`), '',
      '時間は異なる実行時の参考比較で、端末の負荷によって変わる。評価無効時の差は今回の最適化の効果として扱わない。', '',
    ].join('\n'));
    console.log(`${rows.length}対戦の全行動・時刻以外の対戦ログが一致`);
    process.exit(0);
  }
  const api = loadLogic();
  validateTeams(api);
  if (process.argv.includes('--validate')) { console.log('4編成24匹登録・12匹選出の合法性・Champions習得表を確認'); process.exit(0); }
  const filename = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) || 'battle-disruption-benchmark';
  const seeds = process.argv.includes('--two-seeds') ? [[17, 29, 41, 53], [31, 43, 59, 71]] : [[17, 29, 41, 53]];
  const report = { phase: process.argv.includes('--two-seeds') ? 'expanded' : 'initial', openSheets: process.argv.includes('--open-sheets'), teams, games: [] };
  const pairs = [['attack', 'bulky'], ['bulky', 'setup'], ['setup', 'hazard'], ['hazard', 'attack']];
  for (const [own, foe] of pairs) for (let i = 0; i < seeds.length; i++) for (const enabled of [false, true]) {
    const result = game(own, foe, seeds[i], i % 2 ? 'p2' : 'p1', enabled);
    report.games.push(result); save(report, filename, api);
    console.log(`${own}/${foe} ${enabled ? '有効' : '無効'}: ${result.turns}ターン ${result.winner || '打切り'} 変更${result.overrides} 中央値${result.timing.medianMs.toFixed(1)}ms`);
  }
}
module.exports = { loadLogic, validateTeams, teams, game, percentile, compareReports };
