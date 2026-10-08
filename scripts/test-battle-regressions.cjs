const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// 判断関数だけを読み込み、自動対戦ループは起動しない。
const sourcePath = path.join(__dirname, 'battle-from-json.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const entryPoint = source.indexOf('const stream = new BattleStream();');
assert.ok(entryPoint > 0, '対戦の起動位置が見つかりません');

function loadLogic() {
  const context = vm.createContext({
    require,
    process,
    console: { ...console, log() {} },
  });
  vm.runInContext(source.slice(0, entryPoint) + '\nconst stream = { battle: null };', context, { filename: sourcePath });
  return vm.runInContext(`({
    battleState, battleDex, createEmptyBoosts, updateBattleState,
    guessIncomingDamage, guessedStabDamageCache, knownCombatant,
    measureShowdownDamage, estimateBattleDamage, benchSpeciesNames,
    resistSwitchIn, createDamageBattle, fieldState, evaluateMove,
    evaluateUtilityStatusMove, estimateIncomingDamage, estimatePokemonAttackScore,
    getLearnedDamagingMoveIds, hasRevealedDamagingMove, effectiveMovePriority,
    compareEstimatedMoveOrder,
  })`, context);
}

function combatant(species, ability = '') {
  return {
    details: `${species}, L50`,
    condition: '200/200',
    stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 100 },
    ability,
    item: '',
  };
}

function range(damage) {
  return [damage.minDamagePercent, damage.maxDamagePercent, damage.expectedDamagePercent];
}

// 推定関数の戻り値を期待値にせず、元の技定義でエンジンに直接問い合わせる。
function engineDamage(api, attacker, defender, moveId, roll) {
  const session = api.createDamageBattle(attacker, defender, 'p2');
  try {
    session.calc.randomChance = () => false;
    session.calc.random = (n = 2) => n === 16 ? roll : 0;
    return session.calc.actions.getDamage(session.attacker, session.defender, session.calc.dex.getActiveMove(moveId), true) / session.defender.maxhp * 100;
  } finally {
    session.calc.destroy();
  }
}

function evaluate(api, moveId, ownName, opponentName, ability = '', item = '', condition = '200/200') {
  const pokemon = { ...combatant(ownName, ability), active: true, item, condition };
  api.battleState.p1.species = ownName;
  api.battleState.p2.species = opponentName;
  return api.evaluateMove({ id: moveId }, ownName, opponentName, null, null,
    api.createEmptyBoosts(), api.createEmptyBoosts(), { side: { pokemon: [pokemon] } }, 'p1', 'p2');
}

test('防御・特防ランク変更後の予想は再計算と一致する', () => {
  const api = loadLogic();
  const defender = combatant('Blastoise', 'torrent');
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|200/200\n|switch|p2a: イヌ|Arcanine, L50|200/200');
  const guess = () => api.guessIncomingDamage(defender, 'Arcanine', api.createEmptyBoosts(), 'p1');
  const before = guess();
  api.updateBattleState('|-boost|p1a: カメ|def|2\n|-boost|p1a: カメ|spd|2');
  const cached = guess();
  api.guessedStabDamageCache.clear();
  const fresh = guess();
  assert.deepEqual(range(cached), range(fresh));
  assert.ok(cached.maxDamagePercent < before.maxDamagePercent);
});

test('自分の持ち物変更後の予想は再計算と一致する', () => {
  const api = loadLogic();
  const defender = combatant('Blastoise', 'torrent');
  api.battleState.p1.species = 'Blastoise';
  api.battleState.p2.species = 'Arcanine';
  const guess = () => api.guessIncomingDamage(defender, 'Arcanine', api.createEmptyBoosts(), 'p1');
  const before = guess();
  defender.item = 'assaultvest';
  const cached = guess();
  api.guessedStabDamageCache.clear();
  const fresh = guess();
  assert.deepEqual(range(cached), range(fresh));
  assert.notDeepEqual(range(before), range(fresh));
});

for (const moveId of ['stormthrow', 'frostbreath']) {
  for (const boosted of [false, true]) {
    test(`${moveId}: 確定急所の範囲と評価点はエンジンと一致する（ランク変更${boosted ? 'あり' : 'なし'}）`, () => {
      const api = loadLogic();
      const attackerPokemon = combatant('Machamp', 'guts');
      const defenderPokemon = combatant('Blastoise', 'torrent');
      const attackerBoosts = api.createEmptyBoosts();
      const defenderBoosts = api.createEmptyBoosts();
      if (boosted) {
        attackerBoosts.atk = attackerBoosts.spa = -2;
        defenderBoosts.def = defenderBoosts.spd = 2;
      }
      const move = api.battleDex.moves.get(moveId);
      const attacker = api.knownCombatant(attackerPokemon, attackerBoosts);
      const defender = api.knownCombatant(defenderPokemon, defenderBoosts);
      const low = engineDamage(api, attacker, defender, moveId, 15);
      const high = engineDamage(api, attacker, defender, moveId, 0);
      const result = api.estimateBattleDamage({
        move,
        attackerSpecies: api.battleDex.species.get('Machamp'),
        defenderSpecies: api.battleDex.species.get('Blastoise'),
        attackerPokemon, defenderPokemon, attackerBoosts, defenderBoosts,
        defenderPlayer: 'p2',
      });
      assert.equal(result.minDamagePercent, low);
      assert.equal(result.maxDamagePercent, high);
      const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
      assert.equal(result.score, ((low + high) / 2) * accuracy);
    });
  }
}

test('通常技のダメージ範囲を変えない', () => {
  const api = loadLogic();
  const attackerPokemon = combatant('Blastoise', 'torrent');
  const defenderPokemon = combatant('Arcanine', 'intimidate');
  const boosts = api.createEmptyBoosts();
  const move = api.battleDex.moves.get('surf');
  const low = api.measureShowdownDamage(api.knownCombatant(attackerPokemon, boosts), api.knownCombatant(defenderPokemon, boosts), move, null, 'p2', 15);
  const high = api.measureShowdownDamage(api.knownCombatant(attackerPokemon, boosts), api.knownCombatant(defenderPokemon, boosts), move, null, 'p2', 0);
  const result = api.estimateBattleDamage({
    move, attackerSpecies: api.battleDex.species.get('Blastoise'),
    defenderSpecies: api.battleDex.species.get('Arcanine'),
    attackerPokemon, defenderPokemon, attackerBoosts: boosts, defenderBoosts: boosts,
    defenderPlayer: 'p2',
  });
  assert.equal(result.minDamagePercent, low.percent);
  assert.equal(result.maxDamagePercent, high.percent);
});

for (const player of ['p1', 'p2']) {
  test(`${player}: ニックネームの瀕死ログでも交代読みから除外する`, () => {
    const api = loadLogic();
    api.updateBattleState(`|clearpoke\n|poke|${player}|Blastoise, L50\n|poke|${player}|Charizard, L50\n|poke|${player}|Steelix, L50\n|switch|${player}a: ほのお|Charizard, L50|200/200\n|faint|${player}a: ほのお\n|switch|${player}a: カメ|Blastoise, L50|200/200`);
    assert.deepEqual([...api.benchSpeciesNames(player)], ['Steelix']);
    assert.notEqual(api.resistSwitchIn(player, api.battleDex.moves.get('gigadrain'))?.name, 'Charizard');
    api.updateBattleState('|clearpoke');
    api.battleState[player].previewSpecies = ['Blastoise', 'Charizard'];
    assert.deepEqual([...api.benchSpeciesNames(player)], ['Charizard']);
  });
}

test('メガシンカ後の瀕死でも見せ合いの元の姿を除外する', () => {
  const api = loadLogic();
  api.updateBattleState('|poke|p2|Charizard, L50\n|poke|p2|Blastoise, L50\n|switch|p2a: ほのお|Charizard, L50|200/200\n|-formechange|p2a: ほのお|Charizard-Mega-Y\n|faint|p2a: ほのお\n|switch|p2a: カメ|Blastoise, L50|200/200');
  assert.deepEqual([...api.benchSpeciesNames('p2')], []);
});

for (const [moveId, expectedPercent] of [['nightshade', 25], ['seismictoss', 25], ['dragonrage', 20], ['superfang', 50]]) {
  test(`${moveId}: 固定・割合ダメージを通常の威力なしで計算する`, () => {
    const api = loadLogic();
    const attackerPokemon = combatant('Gengar', 'cursedbody');
    const defenderPokemon = combatant('Arcanine', 'intimidate');
    const move = api.battleDex.moves.get(moveId);
    const result = api.estimateBattleDamage({
      move, attackerSpecies: api.battleDex.species.get('Gengar'),
      defenderSpecies: api.battleDex.species.get('Arcanine'),
      attackerPokemon, defenderPokemon, defenderPlayer: 'p2',
    });
    assert.equal(result.minDamagePercent, expectedPercent);
    assert.equal(result.maxDamagePercent, expectedPercent);
    assert.equal(result.critChance, 0);
    assert.ok(evaluate(api, moveId, 'Gengar', 'Arcanine', 'cursedbody').score > 0);
  });
}

test('固定ダメージ技を控え・公開技・習得技・予想の評価にも使う', () => {
  const api = loadLogic();
  const defender = combatant('Arcanine', 'intimidate');
  api.battleState.p1.species = 'Arcanine';
  api.battleState.p2.species = 'Gengar';
  assert.equal(api.estimateIncomingDamage(defender, 'Gengar', 'nightshade', api.createEmptyBoosts(), 'p1').minDamagePercent, 25);
  assert.equal(api.hasRevealedDamagingMove(['nightshade']), true);
  assert.ok(api.getLearnedDamagingMoveIds('Gengar').includes('nightshade'));
  assert.ok(api.estimatePokemonAttackScore({ ...combatant('Gengar', 'cursedbody'), moves: ['nightshade'] }, 'Arcanine', 'p1') > 0);
  // 他の候補を除外しても、威力0の技が予想候補から落ちないことを確認。
  const exclude = api.getLearnedDamagingMoveIds('Gengar').filter((id) => id !== 'nightshade');
  assert.equal(api.guessIncomingDamage(defender, 'Gengar', api.createEmptyBoosts(), 'p1', exclude)?.moveId, 'nightshade');
});

test('ナイトヘッドはノーマル、ちきゅうなげはゴーストに無効', () => {
  const api = loadLogic();
  for (const [moveId, defenderName] of [['nightshade', 'Snorlax'], ['seismictoss', 'Gengar']]) {
    const result = evaluate(api, moveId, 'Gengar', defenderName, 'cursedbody');
    assert.equal(result.minDamagePercent, 0);
    assert.equal(result.maxDamagePercent, 0);
    assert.equal(result.score, 0);
  }
});

test('やどりぎは非接地の相手に使え、くさタイプには無効', () => {
  const api = loadLogic();
  assert.ok(evaluate(api, 'leechseed', 'Venusaur', 'Charizard', 'overgrow').score > 0);
  assert.equal(evaluate(api, 'leechseed', 'Venusaur', 'Venusaur', 'overgrow').score, -100);
  api.battleState.p2.ability = 'levitate';
  assert.ok(evaluate(api, 'leechseed', 'Venusaur', 'Gengar', 'overgrow').score > 0);
});

test('サイコフィールドでも自分対象・自分側の場への技は使える', () => {
  const api = loadLogic();
  api.fieldState.terrain = 'psychic';
  for (const moveId of ['protect', 'recover', 'reflect']) {
    const result = evaluate(api, moveId, 'Blastoise', 'Arcanine', 'torrent', '', '100/200');
    assert.notEqual(result.reason, 'サイコフィールド');
    assert.ok(result.score >= 0, moveId);
  }
});

test('サイコフィールドは接地した相手への先制攻撃を防ぐ', () => {
  const api = loadLogic();
  api.fieldState.terrain = 'psychic';
  assert.equal(evaluate(api, 'quickattack', 'Arcanine', 'Blastoise', 'intimidate').score, -100);
  assert.ok(evaluate(api, 'quickattack', 'Arcanine', 'Charizard', 'intimidate').score > 0);
  assert.ok(evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent').score > 0);
});

test('いたずらごころでも自分・自分側への技はあくタイプ相手に使える', () => {
  const api = loadLogic();
  for (const moveId of ['reflect', 'calmmind', 'protect']) {
    assert.ok(evaluate(api, moveId, 'Klefki', 'Umbreon', 'prankster').score >= 0, moveId);
  }
  assert.equal(evaluate(api, 'thunderwave', 'Klefki', 'Umbreon', 'prankster').score, -100);
  assert.ok(evaluate(api, 'thunderwave', 'Klefki', 'Blastoise', 'prankster').score > 0);
});

test('いたずらごころはサイコフィールドでも技の対象を区別する', () => {
  const api = loadLogic();
  api.fieldState.terrain = 'psychic';
  assert.ok(evaluate(api, 'reflect', 'Klefki', 'Blastoise', 'prankster').score >= 0);
  assert.equal(evaluate(api, 'thunderwave', 'Klefki', 'Blastoise', 'prankster').score, -100);
});

test('イバンのみは通常技の優先度を上げず、先制技を追い越さない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Arcanine', 'intimidate'), item: 'custapberry', condition: '50/200' };
  api.battleState.p1.species = 'Arcanine';
  api.battleState.p2.species = 'Blastoise';
  const surf = api.battleDex.moves.get('surf');
  const quick = api.battleDex.moves.get('quickattack');
  assert.equal(api.effectiveMovePriority(surf, 'p1', pokemon), 0);
  assert.equal(api.compareEstimatedMoveOrder(surf, quick, 180, 100, 100, 'p1', pokemon), 'opponent');
  assert.equal(api.compareEstimatedMoveOrder(surf, surf, 80, 100, 100, 'p1', pokemon), 'own');
  pokemon.condition = '51/200';
  assert.equal(api.compareEstimatedMoveOrder(surf, surf, 80, 100, 100, 'p1', pokemon), 'opponent');
});

test('相手の公開イバンとトリックルームも同じ優先度内で扱う', () => {
  const api = loadLogic();
  const pokemon = combatant('Arcanine', 'intimidate');
  api.battleState.p2.item = 'custapberry';
  api.battleState.p2.hpPercent = 25;
  api.fieldState.trickRoom = true;
  const surf = api.battleDex.moves.get('surf');
  const quick = api.battleDex.moves.get('quickattack');
  assert.equal(api.compareEstimatedMoveOrder(surf, surf, 80, 100, 100, 'p1', pokemon), 'opponent');
  assert.equal(api.compareEstimatedMoveOrder(quick, surf, 80, 100, 100, 'p1', pokemon), 'own');
});

test('イバンのみの通常技はサイコフィールドで無効にならない', () => {
  const api = loadLogic();
  api.fieldState.terrain = 'psychic';
  assert.ok(evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent', 'custapberry', '50/200').score > 0);
});

test('固定ダメージの交代読みは半減で減点せず、無効の交代先を考慮する', () => {
  const api = loadLogic();
  const move = api.battleDex.moves.get('nightshade');
  api.battleState.p2.species = 'Arcanine';
  api.battleState.p2.previewSpecies = ['Arcanine', 'Umbreon'];
  assert.equal(api.resistSwitchIn('p2', move), null);
  api.battleState.p2.previewSpecies.push('Snorlax');
  assert.equal(api.resistSwitchIn('p2', move)?.name, 'Snorlax');
});

test('固定ダメージは能力ランク・弱点半減・天候で増減しない', () => {
  const api = loadLogic();
  for (const defenderName of ['Alakazam', 'Umbreon']) {
    const attackerBoosts = api.createEmptyBoosts();
    const defenderBoosts = api.createEmptyBoosts();
    attackerBoosts.spa = 6;
    defenderBoosts.spd = 6;
    const result = api.estimateBattleDamage({
      move: api.battleDex.moves.get('nightshade'),
      attackerSpecies: api.battleDex.species.get('Gengar'),
      defenderSpecies: api.battleDex.species.get(defenderName),
      attackerPokemon: combatant('Gengar', 'cursedbody'),
      defenderPokemon: combatant(defenderName),
      attackerBoosts, defenderBoosts, defenderPlayer: 'p2', weather: 'rain',
    });
    assert.equal(result.minDamagePercent, 25);
    assert.equal(result.maxDamagePercent, 25);
    assert.equal(result.score, 25);
  }
});
