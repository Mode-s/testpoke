const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { teams, validateTeams } = require('./benchmark-disruption.cjs');
const STATE_KEYS = ['battleState', 'fieldState', 'latestRequests', 'publicEffectHistory', 'speedKnowledge', 'speedLearningState'];

// 実際の対戦状態は監査の再現用だけに使う。AIには従来どおり自分のrequestと公開ログだけを渡す。
function loadLogic() {
  const filename = path.join(__dirname, 'battle-from-json.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const context = vm.createContext({ require, process, console: { ...console, log() {} } });
  vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context, { filename });
  // この監査の入力は先読み導入前の保存対戦。旧判断の再現条件を維持する。
  vm.runInContext('lookaheadPolicy.depth = 0;', context);
  return vm.runInContext(`({ Battle, Teams, FORMAT, validator, battleDex, rosterByShowdownId, learnsetByName, moveByChampionsId,
    stream, teamA, updateBattleState, chooseAction, hiddenDisruptionPolicy, hiddenDisruptionDecisions,
    evaluateMove, createEmptyBoosts, lookaheadPolicy, lookaheadDecisions, createLookaheadBattle, lookaheadResponses, ${STATE_KEYS.join(',')} })`, context);
}
function captureAI(api) { return Object.fromEntries(STATE_KEYS.map((key) => [key, structuredClone(api[key])])); }
function restoreAI(api, snapshot) {
  for (const key of STATE_KEYS) {
    for (const prop of Object.keys(api[key])) delete api[key][prop];
    Object.assign(api[key], structuredClone(snapshot[key]));
  }
}
function rememberChoice(api, player, request, action) {
  api.latestRequests[player] = request;
  const state = api.battleState[player];
  if (action.startsWith('move ')) { state.lastChoice = 'move'; state.recentSpecies = []; }
  else if (action.startsWith('switch ')) {
    state.lastChoice = 'switch';
    if (!request.forceSwitch?.some(Boolean)) state.recentSpecies = [...(state.recentSpecies || []), state.species];
  }
}
function publicReceiver(api, game, publicLog, disclosed) {
  const sheets = { [game.subject]: teams[game.ownTeam], [game.subject === 'p1' ? 'p2' : 'p1']: teams[game.foeTeam] };
  return (type, data) => {
    if (type !== 'update') return;
    const lines = Array.isArray(data) ? data : data.split('\n'); const shared = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('|split|')) { i++; continue; }
      shared.push(lines[i]);
    }
    publicLog.push(...shared); api.updateBattleState(shared.join('\n'));
    for (const line of shared) {
      const fields = line.split('|'); if (!['switch', 'drag'].includes(fields[1])) continue;
      const player = fields[2].slice(0, 2); const species = fields[3].split(',')[0]; const key = `${player}:${species}`;
      if (disclosed.has(key)) continue;
      disclosed.add(key);
      const sheet = sheets[player].find((row) => api.battleDex.species.get(row.species).name === species);
      const disclosure = [`|-ability|${fields[2]}|${sheet.ability}`, ...(sheet.item ? [`|-item|${fields[2]}|${sheet.item}`] : [])];
      publicLog.push(...disclosure); api.updateBattleState(disclosure.join('\n'));
    }
  };
}
const normalized = (log) => log.filter((line) => !line.startsWith('|t:|'));
function describeSide(battle, player) {
  const side = battle.sides.find((row) => row.id === player); const active = side.active[0];
  return { species: active.species.name, hp: active.hp, maxhp: active.maxhp, status: active.status,
    boosts: { ...active.boosts }, remaining: side.pokemon.filter((mon) => mon.hp > 0 && !mon.fainted).length };
}
function replay(game) {
  const api = loadLogic(); validateTeams(api);
  const publicLog = []; const disclosed = new Set(); const frames = [];
  const send = publicReceiver(api, game, publicLog, disclosed);
  const battle = new api.Battle({ formatid: api.FORMAT, seed: game.seed, send }); api.stream.battle = battle;
  let cursor = 0;
  try {
    battle.setPlayer(game.subject, { name: 'Subject', team: api.Teams.pack(teams[game.ownTeam]) });
    battle.setPlayer(game.subject === 'p1' ? 'p2' : 'p1', { name: 'Control', team: api.Teams.pack(teams[game.foeTeam]) });
    battle.sendUpdates(); for (const player of ['p1', 'p2']) assert.equal(battle.choose(player, 'team 123'), true); battle.sendUpdates();
    for (let step = 0; step < 220 && !battle.ended; step++) {
      const frame = { turn: battle.turn, engine: JSON.stringify(battle.toJSON()), ai: captureAI(api),
        disclosed: Array.from(disclosed), logStart: publicLog.length, actions: [], guard: null };
      const pending = battle.sides.map((side) => ({ player: side.id, request: side.activeRequest }));
      for (const { player, request } of pending) {
        if (!request || request.wait) continue;
        api.latestRequests[player] = request;
        let action;
        if (player === game.subject) {
          const original = game.decisions[cursor++]; assert.equal(original.turn, battle.turn); action = original.action;
          if (original.guard) frame.guard = { ...original, request: structuredClone(request) };
          rememberChoice(api, player, request, action);
        } else { api.hiddenDisruptionPolicy.enabled = false; action = api.chooseAction(player, request); }
        frame.actions.push({ player, action }); assert.equal(battle.choose(player, action), true, `${player} ${action}`);
      }
      battle.sendUpdates(); frame.logEnd = publicLog.length;
      frame.after = { own: describeSide(battle, game.subject), foe: describeSide(battle, game.subject === 'p1' ? 'p2' : 'p1') };
      frames.push(frame);
    }
    assert.equal(battle.ended, true); assert.equal(cursor, game.decisions.length);
    assert.deepEqual(normalized(publicLog), normalized(game.publicLog), '再現対戦が保存ログと一致しない');
    return { frames, publicLog };
  } finally { api.stream.battle = null; battle.destroy(); }
}
function continueBranch(game, replayed, index, attack = null, verifyPolicy = false) {
  const frame = replayed.frames[index]; const api = loadLogic(); restoreAI(api, frame.ai);
  const log = []; const disclosed = new Set(frame.disclosed);
  const battle = api.Battle.fromJSON(frame.engine); api.stream.battle = battle;
  battle.send = publicReceiver(api, game, log, disclosed);
  let immediate; let rootActions;
  try {
    rootActions = frame.actions.map((row) => ({ ...row, action: row.player === game.subject && attack ? `move ${attack.slot}` : row.action }));
    for (const { player, action } of rootActions) {
      const request = battle.sides.find((side) => side.id === player).activeRequest;
      if (verifyPolicy) {
        api.latestRequests[player] = request; api.hiddenDisruptionPolicy.enabled = player === game.subject;
        assert.equal(api.chooseAction(player, request), action, '保存した公開状態から元の選択を再計算できない');
      } else rememberChoice(api, player, request, action);
      assert.equal(battle.choose(player, action), true, `反実仮想 ${player}: ${action}`);
    }
    battle.sendUpdates();
    immediate = { ended: battle.ended, winner: battle.winner || null, own: describeSide(battle, game.subject),
      foe: describeSide(battle, game.subject === 'p1' ? 'p2' : 'p1'), log: log.slice() };
    if (process.argv.includes('--immediate-only') && attack) return { immediate, ended: battle.ended, winner: battle.winner || null, turns: battle.turn, log, rootActions };
    let continuationChoices = 0;
    for (let step = 0; step < 220 && !battle.ended && battle.turn <= frame.turn + 100; step++) {
      const pending = battle.sides.map((side) => ({ player: side.id, request: side.activeRequest }));
      for (const { player, request } of pending) {
        if (!request || request.wait) continue;
        api.latestRequests[player] = request;
        let action;
        if (!attack) {
          // 元の分岐は保存した双方の行動で再生し、完全一致を確認する。
          const nextFrame = replayed.frames[index + 1 + step];
          assert.ok(nextFrame); action = nextFrame.actions.find((row) => row.player === player)?.action;
          if (verifyPolicy) {
            api.hiddenDisruptionPolicy.enabled = player === game.subject;
            assert.equal(api.chooseAction(player, request), action, '元の継続判断が再計算と一致しない');
          } else rememberChoice(api, player, request, action);
        } else {
          api.hiddenDisruptionPolicy.enabled = player === game.subject;
          action = api.chooseAction(player, request);
        }
        assert.equal(battle.choose(player, action), true, `継続 ${player} ${action}`); continuationChoices++;
      }
      battle.sendUpdates();
    }
    if (!attack) assert.deepEqual(normalized(log), normalized(replayed.publicLog.slice(frame.logStart)), '元のまもる分岐が完全に再現できない');
    return { immediate, ended: battle.ended, winner: battle.winner || null, turns: battle.turn, log, rootActions, continuationChoices };
  } finally { api.stream.battle = null; battle.destroy(); }
}
function save(report) {
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'battle-guard-counterfactual';
  report.summary = { games: report.games, guards: report.cases.length, branches: report.cases.reduce((sum, row) => sum + row.alternatives.length, 0),
    guardOverrides: report.cases.filter((row) => row.guardOverride).length,
    attackStillWins: report.cases.filter((row) => row.alternatives.some((alt) => alt.result.ended && alt.result.winner === 'Subject')).length,
    fasterAttackWins: report.cases.filter((row) => row.baseline.winner === 'Subject' && row.alternatives.some((alt) => alt.result.ended && alt.result.winner === 'Subject' && alt.result.turns < row.baseline.turns)).length,
    attackTurnsLossIntoWin: report.cases.filter((row) => row.baseline.winner !== 'Subject' && row.alternatives.some((alt) => alt.result.ended && alt.result.winner === 'Subject')).length,
    immediateAttackWins: report.cases.filter((row) => row.alternatives.some((alt) => alt.result.immediate.ended && alt.result.immediate.winner === 'Subject')).length,
    attackWinsWithoutImmediateOwnFaint: report.cases.filter((row) => row.alternatives.some((alt) => alt.result.ended && alt.result.winner === 'Subject' && alt.result.immediate.own.remaining === row.own.remaining)).length,
    attackWinsWithImmediateOwnFaint: report.cases.filter((row) => row.alternatives.some((alt) => alt.result.ended && alt.result.winner === 'Subject' && alt.result.immediate.own.remaining < row.own.remaining)).length,
    cappedBranches: report.cases.flatMap((row) => row.alternatives).filter((alt) => !alt.result.ended).length };
  fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(`${output}.md`, ['# 守らず攻撃した場合の再現監査', '',
    '保存された評価有効8対戦の防御17場面を対象とする。元対戦の全公開ログを再現確認した後、同じエンジン状態・乱数状態から分岐する。そのターンの相手の選択は固定し、自分の防御だけを合法な攻撃に置き換える。以後は元と同じAI・評価設定で双方が改めて判断する。元の防御分岐は双方の元の行動を再生し、時刻以外の全ログが一致することを確認する。', '',
    'これは実際に採用された構成・相手行動・乱数での事後検証。開始時の乱数状態を揃え、分岐後は各経路で自然に乱数を消費する。攻撃で勝ったことは、当時の公開情報であらゆる相手行動に勝てたことや、防御が最善でなかったことの証明ではない。AIには相手の実際の技・能力値・未公開情報を渡さない。複数場面の件数は同じ対戦中の重複を含み、独立の対戦数ではない。', '',
    ...(report.mode === 'immediate' ? ['この出力は当該ターン直後だけの検査。未終局は継続未検査であり、引き分けや敗北を意味しない。', ''] : []),
    `監査済み${report.summary.games}対戦、防御${report.summary.guards}場面、攻撃${report.summary.branches}分岐。攻撃でも勝利${report.summary.attackStillWins}場面、攻撃で早く勝利${report.summary.fasterAttackWins}場面、攻撃したそのターンに勝利${report.summary.immediateAttackWins}場面。未終局${report.summary.cappedBranches}分岐。`, '',
    `攻撃を選んだ直後に自分の生存数を減らさず最終勝利${report.summary.attackWinsWithoutImmediateOwnFaint}場面。そのターンに自分が倒れても最終勝利${report.summary.attackWinsWithImmediateOwnFaint}場面。`, '',
    `元の防御分岐では敗北し、攻撃分岐では勝利した場面は${report.summary.attackTurnsLossIntoWin}件。早い勝利の集計は、元の防御分岐でも勝利した場面だけを比べる。`, '',
    '| 編成・乱数 | ターン | 対面・開始HP | 防御の由来 | 元の終局 | 攻撃へ置換した結果・直後の自分HP |', '| --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((row) => `| ${row.team} / ${row.seed.join(',')} | ${row.turn} | ${row.own.species} ${row.own.hp}/${row.own.maxhp} → ${row.foe.species} ${row.foe.hp}/${row.foe.maxhp} | ${row.guardOverride ? '重大技評価' : '通常評価'} | ${row.baseline.winner === 'Subject' ? '勝' : '負'} ${row.baseline.turns}T | ${row.alternatives.map((alt) => `${alt.name}: ${!alt.result.ended ? '未終局' : alt.result.winner === 'Subject' ? '勝' : '負'} ${alt.result.turns}T・HP${alt.result.immediate.own.hp}${alt.result.immediate.ended && alt.result.immediate.winner === 'Subject' ? '（即時勝利）' : ''}`).join(' / ')} |`), '',
  ].join('\n'));
}
if (require.main === module) {
  const original = JSON.parse(fs.readFileSync('battle-disruption-benchmark.json', 'utf8'));
  assert.equal(original.openSheets, true);
  const report = { mode: process.argv.includes('--immediate-only') ? 'immediate' : 'full', games: 0, cases: [] };
  for (const game of original.games.filter((row) => row.enabled && row.guards)) {
    const replayed = replay(game); report.games++;
    console.log(`元対戦一致 ${game.ownTeam}/${game.foeTeam} ${game.seed.join(',')}`);
    for (let index = 0; index < replayed.frames.length; index++) {
      const frame = replayed.frames[index]; if (!frame.guard) continue;
      const api = loadLogic(); const engine = api.Battle.fromJSON(frame.engine);
      const own = describeSide(engine, game.subject); const foe = describeSide(engine, game.subject === 'p1' ? 'p2' : 'p1'); engine.destroy();
      const alternatives = frame.guard.request.active[0].moves.map((move, i) => ({ ...move, slot: i + 1, name: api.battleDex.moves.get(move.id).name }))
        .filter((move) => !move.disabled && move.pp > 0 && api.battleDex.moves.get(move.id).category !== 'Status');
      const baseline = continueBranch(game, replayed, index);
      const row = { team: game.ownTeam, foeTeam: game.foeTeam, seed: game.seed, subject: game.subject, turn: frame.turn, own, foe,
        guardId: frame.guard.id, guardOverride: frame.guard.override, reason: frame.guard.reason, threat: frame.guard.rows?.[0]?.threat,
        publicBefore: frame.ai.battleState, baseline, alternatives: [] };
      for (const attack of alternatives) {
        const result = continueBranch(game, replayed, index, attack);
        row.alternatives.push({ id: attack.id, slot: attack.slot, name: attack.name, result });
        console.log(`  ${frame.turn}T ${own.species}/${foe.species} ${attack.name} → ${result.winner || '未終局'} ${result.turns}T`);
      }
      report.cases.push(row); save(report);
    }
  }
  save(report); console.log(JSON.stringify(report.summary));
}
module.exports = { loadLogic, captureAI, restoreAI, replay, continueBranch, save };
