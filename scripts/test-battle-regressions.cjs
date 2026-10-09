const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const battleRules = require('./battle-rules.cjs');

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
  // 既存の各評価器の回帰試験は先読みを無効にして単独で検証する。
  vm.runInContext('lookaheadPolicy.depth = 0;', context);
  return vm.runInContext(`({
    battleState, battleDex, createEmptyBoosts, updateBattleState,
    guessIncomingDamage, guessedStabDamageCache, knownCombatant,
    measureShowdownDamage, estimateBattleDamage, benchSpeciesNames,
    resistSwitchIn, createDamageBattle, fieldState, evaluateMove,
    evaluateUtilityStatusMove, estimateIncomingDamage, estimatePokemonAttackScore,
    getLearnedDamagingMoveIds, hasRevealedDamagingMove, effectiveMovePriority,
    compareEstimatedMoveOrder, chooseAction, projectMegaRequest, teamA, teamB,
    revealedItemFor, getPublicSpeedModifiers, usesFixedDamage, isDamagingMove,
    prepareDamageMove, stream, Teams, Battle, FORMAT, latestRequests, validator,
    readMoveHitChance, hitSpread, applyPublicCalcState,
    addedEffectScore, sleepWakeChance, cantMoveFactor, evaluatePainSplit, createPublicMoveSession,
    publicActionModel, publicMoveOrder, evaluatePreMoveThreat, evaluateIncomingRisk, chooseActionInternal,
    predictOpponentSets, estimateInferredBattleDamage, hiddenIncomingThreat,
    rangedCombatant, evaluateYawnRisk, predictYawnSleepChance, getOpponentSpeedRange,
    evaluateProjectedStateEffect, projectedEffectPosition, projectedEffectDamage, hasProjectedStateEffect, getIntimidateSwitch,
    publicEffectHistory, seedPublicEffectState, moveEffectEvaluationKind, hasHandledAdditionalEffect,
    convertTeam, getRevealedMoves, moves,
    getSpeedEstimate, effectProfileGroups, hiddenDisruptionMoves, hiddenDisruptionProfile,
    hiddenDisruptionOutcome, evaluateHiddenDisruption,
    learnsetByName, rosterByShowdownId,
    hiddenDisruptionKinds, hiddenDisruptionEffectBranches,
    selectHiddenDisruption, hiddenDisruptionPolicy, hiddenDisruptionMetrics, hiddenDisruptionDecisions,
    lookaheadPolicy, lookaheadDecisions, createLookaheadBattle, advanceLookaheadTurn,
    lookaheadActions, computeLookahead, lookaheadNextPlan, lookaheadActionKey, lookaheadPosition,
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

function disruptionFixture(own = 'Blastoise', foe = 'Arcanine', ids = ['surf', 'protect']) {
  const api = loadLogic();
  api.battleState.p1.species = own; api.battleState.p2.species = foe;
  const request = moveRequest(combatant(own), ids);
  const profile = { role: 'physical', ability: '', item: '', moves: ['flamethrower', 'wildcharge', 'swordsdance', 'roar'], weight: 1 };
  const loss = (move, action = { kind: 'move', id: ids[0], slot: 1 }, override = {}) =>
    api.hiddenDisruptionOutcome('p1', request, action, foe, { ...profile, ...override }, api.battleDex.moves.get(move)).loss;
  return { api, request, profile, loss };
}

test('未公開重大技は合法な習得技だけを含み、公開4技・ちょうはつ・PP・固定技を尊重する', () => {
  const { api } = disruptionFixture();
  const ids = () => api.hiddenDisruptionMoves('p2', 'Arcanine').map((move) => move.id);
  assert.ok(ids().includes('roar'));
  assert.ok(ids().includes('wildcharge'));
  assert.ok(!ids().includes('spore'));
  api.battleState.p2.volatiles.taunt = true;
  assert.ok(!ids().includes('roar'));
  api.battleState.p2.volatiles.taunt = false;
  api.battleState.p2.ppUsed.Arcanine = { roar: 32 };
  assert.ok(!ids().includes('roar'));
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'wildcharge', 'roar', 'protect']);
  assert.equal(ids().length, 0);
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower']);
  api.battleState.p2.item = 'choicespecs'; api.battleState.p2.lastMove = 'flamethrower';
  assert.equal(ids().length, 0);
});

test('重大技の仮説は公開技を残す4技のコピーで、既存の構成を書き換えない', () => {
  const { api } = disruptionFixture();
  const profile = api.predictOpponentSets('p2', 'Arcanine')[0];
  const before = JSON.stringify(profile);
  const hypothesis = api.hiddenDisruptionProfile(profile, api.battleDex.moves.get('roar'), ['flamethrower', 'wildcharge', 'protect']);
  assert.equal(hypothesis.moves.length, 4);
  assert.deepEqual(Array.from(hypothesis.moves), ['flamethrower', 'wildcharge', 'protect', 'roar']);
  assert.equal(JSON.stringify(profile), before);
  assert.equal(api.hiddenDisruptionProfile({ ...profile, item: 'assaultvest' }, api.battleDex.moves.get('roar'), []), null);
});

test('未公開の致命傷は独立した破綻として検出し、まもるで軽減する', () => {
  const { request, loss } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  const attack = loss('wildcharge');
  const protect = loss('wildcharge', { kind: 'move', id: 'protect', slot: 2 });
  assert.ok(attack >= 80, `攻撃時の不利 ${attack}`);
  assert.equal(protect, 0);
});

test('まもるは相手の積み技を止めず、攻撃して削る利益も比較する', () => {
  const { loss } = disruptionFixture('Blastoise', 'Scizor');
  const profile = { role: 'physical', moves: ['bulletpunch', 'xscissor', 'swordsdance', 'roost'] };
  const attack = loss('swordsdance', { kind: 'move', id: 'surf', slot: 1 }, profile);
  const guard = loss('swordsdance', { kind: 'move', id: 'protect', slot: 2 }, profile);
  assert.ok(attack > 0);
  assert.ok(guard > 0, `まもるでも積みを受ける ${guard}`);
});

test('効果のない状態異常と即時解除された状態異常は重大技に数えない', () => {
  const ground = disruptionFixture('Garchomp', 'Slowbro', ['dragonclaw', 'protect']);
  assert.equal(ground.loss('thunderwave', undefined, { moves: ['surf', 'thunderwave', 'icebeam', 'recover'], role: 'special' }), 0);
  const herb = disruptionFixture('Blastoise', 'Venusaur');
  herb.request.side.pokemon[0].item = 'lumberry';
  assert.equal(herb.loss('sleeppowder', undefined, { moves: ['energyball', 'sludgebomb', 'sleeppowder', 'growth'], role: 'special' }), 0);
});

test('先手の眠りはこのターンの攻撃を止め、遅い眠りでも直後の状態を残す', () => {
  const { api, request } = disruptionFixture('Blastoise', 'Venusaur');
  const profile = { role: 'special', moves: ['energyball', 'sludgebomb', 'sleeppowder', 'growth'] };
  request.side.pokemon[0].stats.spe = 1;
  const outcome = () => api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: 'surf', slot: 1 }, 'Venusaur', profile, api.battleDex.moves.get('sleeppowder'));
  const slow = outcome();
  request.side.pokemon[0].stats.spe = 1000;
  const fast = outcome();
  assert.ok(slow.loss > 0 && fast.loss > 0);
  assert.ok(slow.outcomes[0].foeHpPercent > fast.outcomes[0].foeHpPercent, '先手の眠りで攻撃が止まる');
});

test('設置はまもるを越え、低HPの控えが入場できなくなる不利を検出する', () => {
  const { request, loss } = disruptionFixture('Blastoise', 'Steelix');
  request.side.pokemon.push({ ...combatant('Charizard'), active: false, condition: '10/200', moves: ['flamethrower'] });
  const profile = { moves: ['earthquake', 'stealthrock', 'roar', 'heavy slam'] };
  const attack = loss('stealthrock', undefined, profile);
  const guard = loss('stealthrock', { kind: 'move', id: 'protect', slot: 2 }, profile);
  assert.ok(attack >= 80 && guard >= 80, `${attack} / ${guard}`);
  request.side.pokemon[1].item = 'heavydutyboots';
  const bootLoss = loss('stealthrock', undefined, profile);
  assert.ok(bootLoss < attack - 80, `${attack} → ${bootLoss}`);
});

test('ほえるは控えのない相手・きゅうばんへは効かず、まもるでも止められない', () => {
  const { request, loss } = disruptionFixture('Octillery', 'Arcanine', ['surf', 'protect']);
  assert.equal(loss('roar'), 0);
  request.side.pokemon.push({ ...combatant('Charizard'), active: false, condition: '10/200', moves: ['flamethrower'] });
  request.side.pokemon[0].ability = 'suctioncups';
  assert.equal(loss('roar'), 0);
  request.side.pokemon[0].ability = '';
  assert.ok(loss('roar', { kind: 'move', id: 'protect', slot: 2 }) > 0);
});

test('自主交代はこのターンの攻撃と入場ダメージを受け、無効特性の有効な逃げ先を区別する', () => {
  const { api, request, loss } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  request.side.pokemon.push({ ...combatant('Quagsire', 'waterabsorb'), active: false, moves: ['earthquake'] });
  assert.equal(loss('wildcharge', { kind: 'switch', slot: 2 }), 0);
  request.side.pokemon[1] = { ...combatant('Charizard'), active: false, condition: '10/200', moves: ['flamethrower'] };
  api.fieldState.sides.p1.stealthRock = true;
  assert.ok(loss('wildcharge', { kind: 'switch', slot: 2 }) >= 240, '入場で倒れる交代先は安全な逃げ先にならない');
});

test('重大技の評価は公開状態・構成・requestを変更せず、私有相手情報も読まない', () => {
  const { api, request, loss } = disruptionFixture();
  const state = JSON.stringify(api.battleState);
  const input = JSON.stringify(request);
  const profiles = JSON.stringify(api.predictOpponentSets('p2', 'Arcanine'));
  const first = loss('wildcharge');
  Object.defineProperty(api.stream, 'battle', { get() { throw new Error('私有バトルを読んだ'); } });
  Object.defineProperty(api.latestRequests, 'p2', { get() { throw new Error('相手のrequestを読んだ'); } });
  assert.equal(loss('wildcharge'), first);
  assert.equal(JSON.stringify(api.battleState), state);
  assert.equal(JSON.stringify(request), input);
  assert.equal(JSON.stringify(api.predictOpponentSets('p2', 'Arcanine')), profiles);
});

function disruptionScored(api, request, attackScore = 60, guardScore = 0) {
  return request.active[0].moves.map((slot, i) => ({ move: api.battleDex.moves.get(slot.id), slot: i + 1,
    score: i ? guardScore : attackScore, minDamagePercent: 0, hitChance: 1 }));
}

test('平均とは別の重大な未公開攻撃だけで、明確に安全なまもるへ変更する', () => {
  const { api, request } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'roar', 'protect']);
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  const before = api.hiddenIncomingThreat(request.side.pokemon[0], 'Arcanine', api.createEmptyBoosts(), 'p1', ['flamethrower', 'roar', 'protect']);
  const result = api.evaluateHiddenDisruption('p1', request, disruptionScored(api, request), false);
  assert.equal(result.override?.id, 'protect', JSON.stringify(result));
  assert.ok(result.rows[0].loss >= 80 && result.override.loss < result.rows[0].loss - 40);
  const after = api.hiddenIncomingThreat(request.side.pokemon[0], 'Arcanine', api.createEmptyBoosts(), 'p1', ['flamethrower', 'roar', 'protect']);
  assert.deepEqual(after, before, '平均推定への加算や候補の変更をしない');
});

test('小さな不利と通常スコアの大きな利益は、未公開技だけで攻撃を捨てない', () => {
  const { api, request } = disruptionFixture();
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'roar', 'protect']);
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  const small = api.evaluateHiddenDisruption('p1', request, disruptionScored(api, request), false);
  assert.equal(small.override, null);
  request.side.pokemon[0].condition = '15/200';
  const profitable = api.evaluateHiddenDisruption('p1', request, disruptionScored(api, request, 2000), false);
  assert.equal(profitable.override, null);
});

test('先手・必中・確定KOの攻撃は重大技の評価で捨てず、最小ダメージ不足・命中不足は確定扱いしない', () => {
  const { api, request } = disruptionFixture('Arcanine', 'Blastoise', ['extremespeed', 'protect']);
  request.side.pokemon[0].stats.atk = 2000; request.side.pokemon[0].stats.spe = 1000;
  api.battleState.p2.ability = 'torrent'; api.battleState.p2.item = 'leftovers';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'protect']);
  api.battleState.p2.activeMoveActions = 1;
  const scored = disruptionScored(api, request);
  const damage = api.evaluateMove({ id: 'extremespeed' }, 'Arcanine', 'Blastoise', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, 'p1', 'p2', false, true);
  scored[0].minDamagePercent = damage.minDamagePercent;
  assert.ok(scored[0].minDamagePercent >= 100, JSON.stringify(damage));
  assert.equal(api.evaluateHiddenDisruption('p1', request, scored, false).certainFirstKO, true);
  scored[0].minDamagePercent = 99;
  assert.ok(!api.evaluateHiddenDisruption('p1', request, scored, false).certainFirstKO);
  scored[0].minDamagePercent = 100; scored[0].hitChance = 0.99;
  assert.ok(!api.evaluateHiddenDisruption('p1', request, scored, false).certainFirstKO);
});

test('連続まもるの失敗率とチャンピオンズのふかしのこぶしを別枠の比較でも反映する', () => {
  const { api, request, loss } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  api.updateBattleState('|turn|2');
  api.battleState.p1.protectionChain = { count: 1, turn: 1 };
  const guard = { kind: 'move', id: 'protect', slot: 2 };
  assert.ok(loss('wildcharge', guard) > 0);
  const fist = disruptionFixture('Blastoise', 'Urshifu');
  const profile = { ability: 'unseenfist', moves: ['wickedblow', 'closecombat', 'suckerpunch', 'bulkup'] };
  const attack = fist.loss('wickedblow', undefined, profile);
  const protectedLoss = fist.loss('wickedblow', guard, profile);
  assert.ok(protectedLoss > 0 && protectedLoss < attack);
});

test('未公開候補の習得数を増やしても、重大な一手の不利は薄まらない', () => {
  const { api, request } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'roar', 'protect']);
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  const name = api.rosterByShowdownId.get('arcanine').name;
  const original = api.learnsetByName.get(name);
  const hazardous = api.moves.find((move) => move.showdownId === 'wildcharge').id;
  try {
    api.learnsetByName.set(name, original.filter((row) => row.id === hazardous));
    const scored = disruptionScored(api, request);
    const few = api.evaluateHiddenDisruption('p1', request, scored, false);
    api.learnsetByName.set(name, original);
    const many = api.evaluateHiddenDisruption('p1', request, scored, false);
    assert.ok(many.rows[0].loss >= few.rows[0].loss - 1e-9);
    assert.equal(few.override?.id, 'protect');
    assert.equal(many.override?.id, 'protect');
  } finally { api.learnsetByName.set(name, original); }
});

test('重大な一手の直後評価はp1・p2で対称になり、連続攻撃の分岐でも公開状態を保存する', () => {
  const left = disruptionFixture();
  left.request.side.pokemon[0].condition = '15/200';
  const right = disruptionFixture();
  right.request.side.pokemon[0].condition = '15/200';
  right.api.battleState.p2.species = 'Blastoise'; right.api.battleState.p1.species = 'Arcanine';
  const outcome = (fixture, player, move) => fixture.api.hiddenDisruptionOutcome(player, fixture.request,
    { kind: 'move', id: 'surf', slot: 1 }, 'Arcanine', { ...fixture.profile, moves: ['wildcharge', 'doubleedge', 'flamethrower', 'protect'] }, fixture.api.battleDex.moves.get(move));
  assert.equal(outcome(left, 'p1', 'wildcharge').loss, outcome(right, 'p2', 'wildcharge').loss);
  const before = JSON.stringify(left.api.battleState);
  const multi = outcome(left, 'p1', 'bulletseed');
  assert.ok(multi.outcomes.length >= 4, '2〜5回の分岐を比較する');
  assert.equal(JSON.stringify(left.api.battleState), before);
  assert.equal(outcome(left, 'p1', 'bulletseed').loss, multi.loss, '同じ公開状態は同じ評価になる');
});

test('未公開のふいうちは攻撃を選んだ時に成功し、まもる・変化技へは失敗する', () => {
  const { request, loss } = disruptionFixture('Blastoise', 'Kingambit', ['surf', 'protect', 'recover']);
  request.side.pokemon[0].condition = '15/200'; request.side.pokemon[0].stats.spe = 1000;
  const profile = { moves: ['suckerpunch', 'kowtowcleave', 'ironhead', 'swordsdance'] };
  assert.ok(loss('suckerpunch', undefined, profile) >= 80);
  assert.equal(loss('suckerpunch', { kind: 'move', id: 'protect', slot: 2 }, profile), 0);
  assert.equal(loss('suckerpunch', { kind: 'move', id: 'recover', slot: 3 }, profile), 0);
});

test('候補点検: 特殊な積み・行動制限・攻撃の追加効果を分類し、通常防御を重大技にしない', () => {
  const api = loadLogic();
  const groups = { setup: ['stockpile', 'stuffcheeks', 'acupressure', 'focusenergy', 'laserfocus', 'psychup'],
    hazard: ['stoneaxe', 'ceaselessedge'], control: ['imprison', 'torment', 'haze', 'spectralthief'],
    status: ['confuseray', 'thunderbolt', 'flamethrower'] };
  for (const [kind, ids] of Object.entries(groups)) for (const id of ids) assert.ok(api.hiddenDisruptionKinds(api.battleDex.moves.get(id)).includes(kind), id);
  for (const id of ['protect', 'detect', 'wideguard', 'quickguard', 'followme']) assert.equal(api.hiddenDisruptionKinds(api.battleDex.moves.get(id)).length, 0, id);
  assert.ok(api.hiddenDisruptionKinds(api.battleDex.moves.get('fling')).includes('attack'));
  for (const [species, id] of [['Snorlax', 'stockpile'], ['Machamp', 'focusenergy'], ['Gengar', 'confuseray']]) {
    api.battleState.p2.species = species;
    assert.ok(api.hiddenDisruptionMoves('p2', species).some((move) => move.id === id), `${species}: ${id}`);
  }
});

test('候補点検: 追加効果の枝は実際の発動率を一度だけ掛ける', () => {
  const { api, request, profile } = disruptionFixture('Blastoise', 'Arcanine');
  const chance = (ability = 'flashfire', ownAbility = 'torrent') => {
    request.side.pokemon[0].ability = ownAbility;
    const result = api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: 'surf', slot: 1 }, 'Arcanine', { ...profile, ability }, api.battleDex.moves.get('thunderbolt'));
    return result.outcomes.filter((row) => row.ownStatus === 'par').reduce((sum, row) => sum + row.weight, 0);
  };
  assert.ok(Math.abs(chance() - 0.1) < 1e-8);
  assert.ok(Math.abs(chance('serenegrace') - 0.2) < 1e-8);
  assert.equal(chance('flashfire', 'limber'), 0);
});

test('全攻撃比較: 最良技では倒される対面で、低順位の先制攻撃を選び、無駄にまもるへ逃げない', () => {
  const { api, request } = disruptionFixture('Arcanine', 'Venusaur', ['flamethrower', 'extremespeed', 'protect']);
  request.side.pokemon[0].condition = '15/200'; request.side.pokemon[0].stats.atk = 300; request.side.pokemon[0].stats.spe = 1;
  api.battleState.p2.hpPercent = 10; api.battleState.p2.ability = 'overgrow'; api.battleState.p2.item = 'leftovers';
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'sludgebomb', 'synthesis']);
  const scored = request.active[0].moves.map((slot, i) => ({ move: api.battleDex.moves.get(slot.id), slot: i + 1,
    score: [120, 90, 0][i], minDamagePercent: i === 2 ? 0 : 10, hitChance: 1 }));
  const result = api.evaluateHiddenDisruption('p1', request, scored, false);
  assert.ok(result.rows.some((row) => row.id === 'extremespeed'));
  assert.equal(result.override?.id, 'extremespeed', JSON.stringify(result));
  assert.equal(result.override.slot, 2);
});

test('追加効果の再現: てんのめぐみの発動率と、せいしんりょくのひるみ防止を直後に反映する', () => {
  const { api, request, profile } = disruptionFixture('Blastoise', 'Arcanine');
  request.side.pokemon[0].stats.spe = 1;
  const move = api.battleDex.moves.get('waterfall');
  const evaluate = (ability = 'flashfire', ownAbility = 'torrent') => {
    request.side.pokemon[0].ability = ownAbility;
    return api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: 'surf', slot: 1 }, 'Arcanine', { ...profile, ability }, move);
  };
  const stopped = (result) => result.outcomes.filter((row) => row.remainingActionChance === 0).reduce((sum, row) => sum + row.weight, 0);
  const normal = evaluate(); const doubled = evaluate('serenegrace'); const immune = evaluate('flashfire', 'innerfocus');
  assert.ok(Math.abs(stopped(normal) - 0.2) < 1e-8);
  assert.ok(Math.abs(stopped(doubled) - 0.4) < 1e-8);
  assert.equal(stopped(immune), 0);
  assert.ok(doubled.loss > normal.loss);
  assert.ok(api.hiddenDisruptionEffectBranches({ secondaries: [{ chance: 200 }] }, { boosts: {} }).every((row) => row.weight >= 0));
});

test('全攻撃比較: 失敗する攻撃を代替に入れず、元の技スロットを維持する', () => {
  const { api, request } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'protect', 'roar']);
  const scored = disruptionScored(api, request);
  scored[1].slot = 4;
  scored.push({ move: api.battleDex.moves.get('suckerpunch'), slot: 2, score: -100, failed: true });
  const result = api.evaluateHiddenDisruption('p1', request, scored, false);
  assert.ok(!result.rows.some((row) => row.id === 'suckerpunch'));
  assert.equal(result.override?.slot, 4);
});

test('比較対戦の再現: 重力・回復封じ・じごくづきで使用中止になる攻撃の予想は0になり、再計算で落ちない', () => {
  const api = loadLogic();
  const own = combatant('Venusaur', 'overgrow');
  api.battleState.p1.species = 'Venusaur'; api.battleState.p2.species = 'Slowbro';
  const session = api.createPublicMoveSession(own, 'Slowbro', api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'max', null, true);
  try {
    session.attacker.addVolatile('healblock', session.defender);
    assert.equal(api.projectedEffectDamage(session, session.attacker, session.defender, api.battleDex.moves.get('gigadrain')), 0);
    session.attacker.removeVolatile('healblock');
    assert.ok(api.projectedEffectDamage(session, session.attacker, session.defender, api.battleDex.moves.get('gigadrain')) > 0);
    session.attacker.addVolatile('throatchop', session.defender);
    assert.equal(api.projectedEffectDamage(session, session.attacker, session.defender, api.battleDex.moves.get('hypervoice')), 0);
    session.attacker.removeVolatile('throatchop');
    session.calc.field.addPseudoWeather('gravity', session.defender);
    assert.equal(api.projectedEffectDamage(session, session.attacker, session.defender, api.battleDex.moves.get('fly')), 0);
  } finally { session.calc.destroy(); }
});

test('基準検証: 大きな不利・改善幅・通常の利益・逃げ先の破綻を独立して判定する', () => {
  const api = loadLogic();
  const choose = (loss, alternative, currentScore = 100, alternateScore = 100, kind = 'move', recent = []) =>
    api.selectHiddenDisruption([{ kind: 'move', slot: 1, id: 'surf', loss, score: currentScore },
      { kind, slot: 2, id: 'protect', species: 'Blastoise', loss: alternative, score: alternateScore }], recent);
  assert.equal(choose(79, 0).override, null, '重大性に満たない差で攻撃を捨てない');
  assert.equal(choose(80, 40).override?.slot, 2, '重大性と実質改善を両方満たす');
  assert.equal(choose(80, 41).override, null, '改善39は不十分');
  assert.equal(choose(200, 80).override, null, '逃げ先も重大な破綻なら変更しない');
  assert.equal(choose(160, 20, 320, 100).override, null, '通常評価の利益を捨てる損失を考慮');
  assert.equal(choose(160, 20, 100, 100, 'switch', ['Blastoise']).override, null, '往復交代へ大きな差を要求');
  const result = choose(160, 20);
  assert.equal(result.reason, 'material-improvement');
  assert.equal(result.rows[1].improvement, 140);
});

test('基準検証: 設定変更はキャッシュを分け、評価無効時には通常判断へ戻る', () => {
  const { api, request } = disruptionFixture();
  request.side.pokemon[0].condition = '15/200';
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'roar', 'protect']);
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  const scored = disruptionScored(api, request);
  const normal = api.evaluateHiddenDisruption('p1', request, scored, false);
  assert.equal(normal.override?.id, 'protect');
  api.hiddenDisruptionPolicy.limit = 10000;
  assert.equal(api.evaluateHiddenDisruption('p1', request, scored, false).override, null);
  api.hiddenDisruptionPolicy.enabled = false;
  assert.equal(api.evaluateHiddenDisruption('p1', request, scored, false), null);
  assert.equal(api.hiddenDisruptionDecisions.has('p1'), false);
});

test('性能改善: 再利用の前後で追加効果・連続攻撃・ランダム能力の全分岐が一致する', () => {
  const { api, request, profile } = disruptionFixture();
  request.side.pokemon[0].moves = ['surf', 'icebeam', 'darkpulse', 'protect'];
  for (const [own, foe] of [['icebeam', 'triattack'], ['darkpulse', 'bulletseed'], ['surf', 'acupressure'], ['protect', 'suckerpunch']]) {
    api.hiddenDisruptionPolicy.optimize = false;
    const reference = api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: own, slot: 1 }, 'Arcanine', profile, api.battleDex.moves.get(foe));
    api.hiddenDisruptionPolicy.optimize = true;
    const optimized = api.hiddenDisruptionOutcome('p1', request, { kind: 'move', id: own, slot: 1 }, 'Arcanine', profile, api.battleDex.moves.get(foe));
    assert.equal(JSON.stringify(optimized), JSON.stringify(reference), `${own}/${foe}`);
  }
  assert.ok(api.hiddenDisruptionMetrics.baselineCacheHits > 0);
});

test('性能改善: 破綻済みの代替だけを省略しても、最良攻撃の最悪値と選択は全計算と一致する', () => {
  const { api, request } = disruptionFixture('Blastoise', 'Arcanine', ['surf', 'icebeam', 'darkpulse', 'hydropump']);
  request.side.pokemon[0].condition = '15/200';
  request.side.pokemon[0].moves = ['surf', 'icebeam', 'darkpulse', 'hydropump'];
  api.battleState.p2.ability = 'flashfire'; api.battleState.p2.item = 'leftovers';
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower', 'protect', 'roar']);
  const scored = request.active[0].moves.map((row, i) => ({ move: api.battleDex.moves.get(row.id), slot: i + 1, score: 100 - i * 10, minDamagePercent: 0, hitChance: 1 }));
  const stateBefore = JSON.stringify(api.battleState);
  api.hiddenDisruptionPolicy.optimize = false;
  const reference = api.evaluateHiddenDisruption('p1', request, scored, false);
  const fullCount = api.hiddenDisruptionMetrics.scenarios;
  api.hiddenDisruptionPolicy.optimize = true;
  const optimized = api.evaluateHiddenDisruption('p1', request, scored, false);
  const reducedCount = api.hiddenDisruptionMetrics.scenarios - fullCount;
  assert.equal(optimized.rows[0].loss, reference.rows[0].loss);
  assert.equal(optimized.override?.slot, reference.override?.slot);
  assert.equal(optimized.reason, reference.reason);
  assert.ok(reducedCount < fullCount, `${fullCount}/${reducedCount}`);
  assert.ok(optimized.rows.some((row) => row.lossComplete === false));
  for (const row of optimized.rows.filter((row) => !row.lossComplete)) {
    assert.ok(row.loss >= api.hiddenDisruptionPolicy.limit);
    assert.ok(row.loss <= reference.rows.find((full) => full.slot === row.slot).loss);
  }
  assert.equal(JSON.stringify(api.battleState), stateBefore);
});

function range(damage) {
  return [damage.minDamagePercent, damage.maxDamagePercent, damage.expectedDamagePercent];
}

// 特殊攻撃だけを使う相手のやけど利益は、固定点ではなく実エンジンの継続ダメージ。
function engineBurnChip(api, speciesName) {
  const defender = api.rangedCombatant(api.battleDex.species.get(speciesName), 'def', 'max', {}, 'p2');
  const session = api.createDamageBattle(api.knownCombatant(combatant('Arcanine')), defender, 'p2');
  try {
    session.defender.setStatus('brn', session.attacker);
    const hp = session.defender.hp;
    session.calc.fieldEvent('Residual');
    return (hp - session.defender.hp) / session.defender.maxhp * 100;
  } finally { session.calc.destroy(); }
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

function damageFor(api, moveId, attacker, defender, extra = {}) {
  return api.estimateBattleDamage({
    move: api.battleDex.moves.get(moveId),
    attackerSpecies: api.battleDex.species.get(attacker.details.split(',')[0]),
    defenderSpecies: api.battleDex.species.get(defender.details.split(',')[0]),
    attackerPokemon: attacker, defenderPokemon: defender,
    defenderPlayer: 'p2', ...extra,
  });
}

function stateEffect(api, id, pokemon, opponent = 'Blastoise', ownBoosts = {}, foeBoosts = {}, bench = []) {
  api.battleState.p1.species = pokemon.details.split(',')[0];
  api.battleState.p2.species = opponent;
  const request = moveRequest(pokemon, pokemon.moves);
  request.side.pokemon.push(...bench);
  return api.evaluateProjectedStateEffect(api.battleDex.moves.get(id), request.side.pokemon[0], opponent,
    ownBoosts, foeBoosts, request, 'p1', 'p2');
}

function effectReviewFixture(ownSpecies = 'Clefable', foeSpecies = 'Blastoise', ownMoves = ['moonblast','encore','disable','trick']) {
  const api = loadLogic();
  api.battleState.p1.species = ownSpecies; api.battleState.p2.species = foeSpecies;
  api.battleState.p2.revealedMoves[foeSpecies] = new Set(['surf','icebeam','recover','protect']);
  const pokemon = { ...combatant(ownSpecies), active: true, moves: ownMoves, stats: { ...combatant(ownSpecies).stats, spe: 300 } };
  const request = moveRequest(pokemon, ownMoves);
  const score = (id, infer = false, ownBoosts = {}, assumption = null) => api.evaluateMove({ id }, ownSpecies, foeSpecies, api.battleState.p2.status, null,
    { ...api.createEmptyBoosts(), ...ownBoosts }, api.battleState.p2.boosts, request, 'p1','p2',false,infer,assumption);
  return { api, pokemon: request.side.pokemon[0], request, score };
}

function contextReviewFixture(ownName = 'Slowbro', foeName = 'Blastoise', ownMoves = ['surf'], foeMoves = ['surf', 'icebeam', 'recover', 'protect'], player = 'p1') {
  const api = loadLogic();
  const foe = player === 'p1' ? 'p2' : 'p1';
  api.battleState[player].species = ownName; api.battleState[foe].species = foeName;
  api.battleState[foe].revealedMoves[foeName] = new Set(foeMoves);
  const request = moveRequest(combatant(ownName), ownMoves);
  const pokemon = request.side.pokemon[0];
  const score = (id, called = false, infer = false) => api.evaluateMove({ id }, ownName, foeName, api.battleState[foe].status,
    api.battleState[player].lastMove, api.battleState[player].boosts, api.battleState[foe].boosts, request, player, foe, called, infer);
  return { api, pokemon, request, score, player, foe };
}

for (const player of ['p1', 'p2']) {
  test(`局面修正 ${player}: ちょうはつ・やどりぎ・あくびの公開済み状態への再使用は失敗する`, () => {
    const { api, pokemon, score, foe } = contextReviewFixture('Venusaur', 'Blastoise', ['leechseed','taunt','yawn'], undefined, player);
    for (const id of ['taunt','leechseed','yawn']) {
      assert.ok(score(id).score > 0);
      api.updateBattleState(`|-start|${foe}a: カメ|move: ${api.battleDex.moves.get(id).name}`);
      assert.equal(score(id).failed, true); assert.equal(score(id).score, -100);
      const session = api.createPublicMoveSession(pokemon, 'Blastoise', {}, {}, player, foe);
      try {
        assert.ok(session.defender.volatiles[id]);
        assert.equal(session.calc.actions.useMove(id, session.attacker, {target:session.defender}), false);
      } finally { session.calc.destroy(); }
      api.updateBattleState(`|-end|${foe}a: カメ|move: ${api.battleDex.moves.get(id).name}`);
      assert.ok(score(id).score > 0);
    }
  });

  test(`局面修正 ${player}: こんじょうのやけどは主効果・追加効果とも不利益を計算する`, () => {
    const { api, pokemon, score, foe } = contextReviewFixture('Slowbro','Ursaluna',['surf','willowisp'], ['facade','headlongrush','firepunch','swordsdance'], player);
    api.battleState[foe].ability = 'guts';
    assert.ok(score('willowisp').score < 0);
    const secondary = api.addedEffectScore(api.battleDex.moves.get('flamethrower'),pokemon,null,{}, {},player,foe,'Ursaluna',pokemon.moves);
    assert.ok(secondary.score < 0);
    const session = api.createPublicMoveSession(pokemon,'Ursaluna',{}, {},player,foe);
    try {
      session.calc.randomChance=()=>false; session.calc.random=n=>n===16?15:0;
      const damage=()=>session.calc.actions.getDamage(session.defender,session.attacker,session.calc.dex.getActiveMove('headlongrush'),true);
      const before=damage();session.defender.setStatus('brn',session.attacker);
      assert.ok(damage()>before,'実エンジンでも相手の物理ダメージが増える');
    } finally {session.calc.destroy();}
    assert.equal(api.battleState[foe].status,null);
  });

  test(`局面修正 ${player}: ねごとは失敗を0とし、成功する有害な持ち物交換は平均から減点する`, () => {
    const {api,pokemon,score,foe}=contextReviewFixture('Slowbro','Blastoise',['sleeptalk','trick','surf','slackoff'],undefined,player);
    pokemon.item='leftovers';pokemon.condition='200/200 slp';
    api.battleState[player].status='slp';api.battleState[player].sleepSource='rest';api.battleState[foe].item='blacksludge';
    const trick=score('trick',true);const surf=score('surf',true);const heal=score('slackoff',true);
    assert.equal(trick.failed,false);assert.ok(trick.score<0);assert.equal(heal.failed,true);
    assert.ok(Math.abs(score('sleeptalk').score-(trick.score+surf.score)/3)<1e-9);
    assert.ok(score('sleeptalk').score<0);
    api.battleState[player].statusAge=2;assert.equal(score('sleeptalk').score,0,'起床する行動はねごとも使えない');
  });
}

test('局面修正: メンタルハーブで即解除されるちょうはつには利益を付けない', () => {
  const {api,score}=contextReviewFixture('Slowbro','Blastoise',['taunt']);
  api.battleState.p2.item='mentalherb';
  assert.equal(score('taunt').score,0);assert.equal(api.battleState.p2.item,'mentalherb');
});

test('局面修正: やけどは物理型・特殊型・回復特性・治癒きのみを区別する', () => {
  const physical=contextReviewFixture('Slowbro','Blastoise',['willowisp'],['tackle','bodyslam','icepunch','earthquake']);
  const special=contextReviewFixture('Slowbro','Blastoise',['willowisp'],['surf','icebeam','darkpulse','aurasphere']);
  assert.ok(physical.score('willowisp').score>special.score('willowisp').score);
  assert.ok(special.score('willowisp').score>0);
  special.api.battleState.p2.item='lumberry';assert.equal(special.score('willowisp').score,0);
  const poison=contextReviewFixture('Slowbro','Breloom',['surf','toxic'],['machpunch','bulletseed','rocktomb','spore']);
  poison.api.battleState.p2.ability='poisonheal';assert.ok(poison.score('toxic').score<0);
});

test('局面修正: まひは相手の速度・攻撃の機会と、はやあしを反映する', () => {
  const {api,pokemon,score}=contextReviewFixture('Slowbro','Blastoise',['surf','thunderwave'],['surf','icebeam','darkpulse','aurasphere']);
  pokemon.stats.spe=60;const ordinary=score('thunderwave').score;
  api.battleState.p2.ability='quickfeet';assert.ok(score('thunderwave').score<ordinary);
  api.battleState.p2.status='par';assert.equal(score('thunderwave').failed,true);
});

test('局面修正: 氷のいない対面の雪は0、相手だけの氷防御上昇は不利益になる', () => {
  const neutral=contextReviewFixture('Slowbro','Blastoise',['tackle','snowscape']);
  assert.equal(neutral.score('snowscape').score,0);
  const foeIce=contextReviewFixture('Slowbro','Glaceon',['tackle','snowscape']);
  assert.ok(foeIce.score('snowscape').score<0);
  const ownIce=contextReviewFixture('Glaceon','Blastoise',['icebeam','snowscape'],['tackle','bodyslam','icepunch','earthquake']);
  assert.ok(ownIce.score('snowscape').score>0);
});

test('局面修正: 相手だけが砂無効かつ岩の特防上昇を得ると砂嵐を減点する', () => {
  const {api,score}=contextReviewFixture('Slowbro','Tyranitar',['surf','sandstorm']);
  assert.ok(score('sandstorm').score<0);
  api.fieldState.weather='sand';assert.equal(score('sandstorm').failed,true);
});

test('局面修正: 砂の無効化・すなかき・控えの氷タイプも天候評価に入る', () => {
  const immune=contextReviewFixture('Steelix','Arcanine',['tackle','sandstorm']);
  const weak=contextReviewFixture('Slowbro','Arcanine',['tackle','sandstorm']);
  assert.ok(immune.score('sandstorm').score>weak.score('sandstorm').score);
  const {api,pokemon,score}=contextReviewFixture('Excadrill','Blastoise',['tackle','sandstorm']);
  pokemon.stats.spe=60;const before=score('sandstorm').score;pokemon.ability='sandrush';
  assert.ok(score('sandstorm').score>before);
  const withBench=contextReviewFixture('Slowbro','Blastoise',['surf','snowscape'],['tackle','bodyslam','icepunch','earthquake']);
  assert.equal(withBench.score('snowscape').score,0);
  withBench.request.side.pokemon.push({...combatant('Glaceon'),active:false,moves:['icebeam']});
  assert.ok(withBench.score('snowscape').score>0);
  assert.equal(api.fieldState.weather,null);
});

function engineProtection(api, id, pokemon, speciesName, attack='tackle', ability='') {
  const session=api.createDamageBattle(api.knownCombatant(pokemon),api.knownCombatant(combatant(speciesName,ability)),'p2');
  try {
    session.calc.randomChance=()=>true;session.calc.queue.push({choice:'move',pokemon:session.defender,move:session.calc.dex.getActiveMove(attack)});
    assert.ok(session.calc.actions.useMove(id,session.attacker,{target:session.attacker}));
    const hp=session.defender.hp;const ownHp=session.attacker.hp;
    session.calc.randomChance=(n,d)=>d===100||n>=d;session.calc.random=n=>n===16?15:0;
    session.calc.actions.useMove(attack,session.defender,{target:session.attacker});
    return {chip:(hp-session.defender.hp)/session.defender.maxhp*100,status:session.defender.status,
      ownDamage:(ownHp-session.attacker.hp)/session.attacker.maxhp*100};
  } finally {session.calc.destroy();}
}

test('局面修正: ニードルガードの接触ダメージ・トーチカのどくをまもると区別する', () => {
  const {api,pokemon,score}=contextReviewFixture('Toxapex','Arcanine',['protect','spikyshield','banefulbunker'],['tackle','flareblitz','crunch','extremespeed']);
  assert.ok(score('spikyshield').score>score('protect').score);
  assert.ok(score('banefulbunker').score>score('protect').score);
  assert.equal(engineProtection(api,'protect',pokemon,'Arcanine').chip,0);
  assert.ok(engineProtection(api,'spikyshield',pokemon,'Arcanine').chip>0);
  assert.equal(engineProtection(api,'banefulbunker',pokemon,'Arcanine').status,'psn');
  const special=contextReviewFixture('Toxapex','Blastoise',['protect','spikyshield','banefulbunker'],['surf','icebeam','darkpulse','aurasphere']);
  assert.equal(special.score('spikyshield').score,special.score('protect').score);
  assert.equal(special.score('banefulbunker').score,special.score('protect').score);
});

for (const player of ['p1','p2']) {
  test(`局面修正 ${player}: 連続成功で1/3・1/9、失敗・別技・交代でまもる成功率が戻る`,()=>{
    const {api,score}=contextReviewFixture('Toxapex','Arcanine',['protect'],['tackle','flareblitz','crunch','extremespeed'],player);
    const log=(text)=>api.updateBattleState(text.replaceAll('PLAYER',player));
    log('|turn|1');const first=score('protect');assert.equal(first.successChance,1);
    log('|move|PLAYERa: 毒|Protect|PLAYERa: 毒\n|-singleturn|PLAYERa: 毒|Protect\n|turn|2');
    assert.equal(score('protect').successChance,1/3);assert.ok(Math.abs(score('protect').score-first.score/3)<1e-8);
    log('|move|PLAYERa: 毒|Baneful Bunker|PLAYERa: 毒\n|-singleturn|PLAYERa: 毒|move: Baneful Bunker\n|turn|3');
    assert.equal(score('protect').successChance,1/9);
    log('|move|PLAYERa: 毒|Protect|PLAYERa: 毒\n|-fail|PLAYERa: 毒\n|turn|4');assert.equal(score('protect').successChance,1);
    log('|move|PLAYERa: 毒|Protect|PLAYERa: 毒\n|-singleturn|PLAYERa: 毒|Protect\n|turn|5\n|cant|PLAYERa: 毒|par\n|turn|6');
    assert.equal(score('protect').successChance,1);
    log('|move|PLAYERa: 毒|Protect|PLAYERa: 毒\n|-singleturn|PLAYERa: 毒|Protect\n|turn|7\n|move|PLAYERa: 毒|Surf|p2a: 犬\n|turn|8');
    assert.equal(score('protect').successChance,1);
    log('|move|PLAYERa: 毒|Protect|PLAYERa: 毒\n|-singleturn|PLAYERa: 毒|Protect\n|turn|9\n|switch|PLAYERa: 毒|Toxapex, L50|200/200');
    assert.equal(score('protect').successChance,1);
  });
}

test('局面修正: ふかしのこぶしはChampionsの貫通後の軽減を評価し、フェイントには回避利益を付けない',()=>{
  const contact=contextReviewFixture('Toxapex','Urshifu-Rapid-Strike',['protect','spikyshield'],['surgingstrikes','closecombat','uturn','aquajet']);
  const normal=contact.score('protect').score;
  contact.api.battleState.p2.ability='unseenfist';
  assert.ok(contact.score('protect').score>0 && contact.score('protect').score<normal);
  assert.equal(contact.score('spikyshield').score,contact.score('protect').score,'貫通する接触にはニードルガードの追加損傷がない');
  const protectedDamage=engineProtection(contact.api,'protect',contact.pokemon,'Urshifu-Rapid-Strike','tackle','unseenfist').ownDamage;
  const unprotected=engineDamage(contact.api,contact.api.knownCombatant(combatant('Urshifu-Rapid-Strike','unseenfist')),contact.api.knownCombatant(contact.pokemon),'tackle',15);
  assert.ok(protectedDamage>0 && protectedDamage<unprotected,'同梱Championsエンジンでも貫通後のダメージが軽減される');
  const feint=contextReviewFixture('Toxapex','Scizor',['protect'],['feint','bulletpunch','uturn','closecombat']);
  feint.api.battleState.p2.item='choiceband';feint.api.battleState.p2.lastMove='feint';
  assert.equal(feint.score('protect').score,0);
});

test('局面修正: トーチカでポイズンヒールを与える不利益・優先度・相手の行動不能を反映する',()=>{
  const {api,pokemon,score}=contextReviewFixture('Toxapex','Breloom',['protect','banefulbunker'],['tackle','machpunch','bulletseed','rocktomb']);
  api.battleState.p2.ability='poisonheal';api.battleState.p2.hpPercent=50;assert.ok(score('banefulbunker').score<score('protect').score);
  pokemon.stats.spe=1;assert.ok(score('protect').score>0,'まもるの優先度で先に動く');
  api.battleState.p2.status='slp';api.battleState.p2.statusAge=0;assert.equal(score('protect').score,0);
});

test('局面修正: 新しい評価は公開状態・自分の要求を変えず、相手の非公開情報にも依存しない',()=>{
  const {api,pokemon,request,score}=contextReviewFixture('Slowbro','Blastoise',['sleeptalk','trick','surf','protect']);
  pokemon.item='leftovers';pokemon.condition='200/200 slp';
  api.battleState.p1.status='slp';api.battleState.p1.sleepSource='rest';
  api.battleState.p2.item='blacksludge';api.battleState.p2.volatiles.taunt=true;
  const ownBefore=JSON.stringify(request);const publicBefore=JSON.stringify(api.battleState);
  const session=api.createDamageBattle(api.knownCombatant(pokemon),api.knownCombatant(combatant('Blastoise')),'p2');
  const values=()=>['taunt','leechseed','yawn','willowisp','toxic','sleeptalk','sandstorm','snowscape','protect','spikyshield','banefulbunker'].map(id=>score(id).score);
  try {
    api.stream.battle=session.calc;const before=values();
    session.defender.ability='guts';session.defender.item='lumberry';session.defender.hp=1;session.defender.storedStats.atk=9999;
    session.defender.moveSlots=[{id:'explosion',pp:1,maxpp:5}];
    api.latestRequests.p2=moveRequest({...combatant('Blastoise','guts'),item:'lumberry',condition:'1/200'},['explosion']);
    assert.deepEqual(values(),before);
    assert.equal(JSON.stringify(request),ownBefore);assert.equal(JSON.stringify(api.battleState),publicBefore);
  } finally {api.stream.battle=null;session.calc.destroy();}
});

test('評価修正: アンコール・かなしばりは直前技なし・PP切れ・禁止技・重複で失敗する', () => {
  const {api, score} = effectReviewFixture();
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf','icebeam','darkpulse','aurasphere']);
  for (const id of ['encore','disable']) {
    assert.equal(score(id).failed, true, id); assert.equal(score(id).score, -100, id);
    api.battleState.p2.lastMove = 'surf'; api.battleState.p2.ppUsed.Blastoise = { surf: 24 };
    assert.equal(score(id).failed, true, 'PP切れ');
    api.battleState.p2.ppUsed.Blastoise = {};
    api.battleState.p2.lastMove = 'struggle'; assert.equal(score(id).failed, true, '禁止技');
    api.battleState.p2.lastMove = 'surf'; api.battleState.p2.volatiles[id] = true; api.battleState.p2.volatiles[`${id}Move`] = 'surf';
    assert.equal(score(id).failed, true, '既に同じ状態');
    delete api.battleState.p2.volatiles[id]; delete api.battleState.p2.volatiles[`${id}Move`]; api.battleState.p2.lastMove = null;
  }
});

test('評価修正: アンコール・かなしばりは相手が先に使う技とPP消費を反映する', () => {
  const {api,pokemon,score} = effectReviewFixture();
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf','icebeam','darkpulse','aurasphere']);
  pokemon.stats.spe = 1;
  for (const id of ['encore','disable']) {
    assert.equal(score(id).failed, false, id); assert.equal(score(id).successChance, 1, id);
    api.battleState.p2.ppUsed.Blastoise = { surf: 23, icebeam: 15, darkpulse: 23, aurasphere: 31 };
    assert.equal(score(id).failed, true, '最後の1PPを先に消費すると制限できない');
    api.battleState.p2.ppUsed.Blastoise = {};
  }
});

test('評価修正: 技制限の価値は封じる攻撃に応じ、効果を防ぐ特性は実エンジンと一致する', () => {
  const {api,pokemon,score} = effectReviewFixture();
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf','protect','rest','irondefense']);
  api.battleState.p2.lastMove = 'surf';
  const strong = score('disable'); assert.ok(strong.score > 0);
  api.battleState.p2.lastMove = 'protect'; assert.ok(score('disable').score < strong.score);
  api.battleState.p2.lastMove = 'surf'; api.battleState.p2.ability = 'aromaveil';
  assert.equal(score('encore').failed, true); assert.equal(score('disable').failed, true);
  const s = api.createPublicMoveSession(pokemon,'Blastoise',{}, {},'p1','p2');
  try { assert.equal(s.calc.actions.useMove('encore',s.attacker,{target:s.defender}), false); }
  finally { s.calc.destroy(); }
});

test('評価修正: トリック・すりかえは火力・回復・技構成による交換の利益と不利益を区別する', () => {
  const {api,pokemon,score} = effectReviewFixture('Slowbro','Blastoise',['surf','recover','trick','switcheroo']);
  for (const id of ['trick','switcheroo']) {
    pokemon.item = 'leftovers'; api.battleState.p2.item = 'choiceband'; const bad = score(id);
    pokemon.item = 'choiceband'; api.battleState.p2.item = 'leftovers'; const good = score(id);
    assert.ok(good.score > bad.score, `${id}: ${good.score} > ${bad.score}`);
    assert.ok(good.score > 0); assert.ok(bad.score < 0);
    assert.equal(good.ownItem, 'leftovers'); assert.equal(bad.ownItem, 'choiceband');
  }
});

test('評価修正: 持ち物交換は両者アイテムなし・ねんちゃく・メガストーンで失敗する', () => {
  const {api,pokemon,score} = effectReviewFixture('Charizard','Blastoise',['flamethrower','trick']);
  assert.equal(score('trick').failed, true);
  pokemon.item = 'leftovers'; api.battleState.p2.item = 'choicespecs'; api.battleState.p2.ability = 'stickyhold';
  assert.equal(score('trick').failed, true);
  api.battleState.p2.ability = null; pokemon.item = 'charizarditey';
  assert.equal(score('trick').failed, true);
});

test('評価修正: 交換で得る回復・有害アイテムを双方のHPとタイプに応じて評価する', () => {
  const {api,pokemon,score} = effectReviewFixture('Slowbro','Blastoise',['surf','trick']);
  pokemon.condition = '80/200'; api.battleState.p2.hpPercent = 100;
  api.battleState.p2.item = 'leftovers'; const recovery = score('trick');
  api.battleState.p2.item = 'blacksludge'; const harmful = score('trick');
  assert.ok(recovery.score > 0); assert.ok(harmful.score < 0);
});

test('評価修正: おいかぜ後も遅い場合・既に先手の場合・先制技の優先度差には加点しない', () => {
  const {api,pokemon,score} = effectReviewFixture('Blastoise','Lucario',['surf','tailwind']);
  api.battleState.p2.revealedMoves.Lucario = new Set(['flamethrower','darkpulse','dragonpulse','aurasphere']);
  pokemon.stats.spe = 74;
  const slow = score('tailwind',false,{spe:-6});
  assert.equal(slow.beforeSpeed,18); assert.equal(slow.afterSpeed,36); assert.equal(slow.score,0);
  pokemon.stats.spe = 300; assert.equal(score('tailwind').score,0);
  pokemon.stats.spe = 90; api.battleState.p2.revealedMoves.Lucario = new Set(['extremespeed','quickattack','bulletpunch','vacuumwave']);
  assert.equal(score('tailwind').score,0);
});

test('評価修正: おいかぜで速度関係を逆転する利益とトリックルームでの不利益を区別する', () => {
  const {api,pokemon,score} = effectReviewFixture('Blastoise','Arcanine',['surf','tailwind']);
  api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower','snarl','dragonpulse','fireblast']);
  pokemon.stats.spe = 90;
  assert.ok(score('tailwind').score > 0);
  api.fieldState.trickRoom = true; assert.ok(score('tailwind').score < 0);
  api.fieldState.sides.p1.tailwind = true; assert.equal(score('tailwind').failed,true);
});

test('評価修正: ほのおのまいの50%上昇と命中・行動順・ランク上限を追加効果へ反映する', () => {
  const {api,pokemon} = effectReviewFixture('Primarina','Volcarona',['alluringvoice']);
  api.battleState.p2.revealedMoves.Volcarona = new Set(['fierydance','bugbuzz','gigadrain','roost']);
  pokemon.stats.spe = 60;
  const added = () => api.addedEffectScore(api.battleDex.moves.get('alluringvoice'),pokemon,null,{},api.battleState.p2.boosts,'p1','p2','Volcarona',pokemon.moves).score;
  assert.equal(api.battleDex.moves.get('fierydance').secondary.chance,50);
  assert.equal(added(),2);
  pokemon.stats.spe = 300; assert.equal(added(),0);
  pokemon.stats.spe = 60; api.battleState.p2.boosts.spa = 6; assert.equal(added(),0);
  api.battleState.p2.boosts.spa = 0; api.battleState.p2.ability = 'contrary'; assert.equal(added(),0);
});

test('評価修正: チャージビームの70%上昇は命中率・無効・ちからずく・マントも区別する', () => {
  const {api,pokemon} = effectReviewFixture('Primarina','Blastoise',['alluringvoice','burningjealousy']);
  api.battleState.p2.revealedMoves.Blastoise = new Set(['chargebeam','surf','icebeam','protect']); pokemon.stats.spe = 1;
  const added = (id='alluringvoice') => api.addedEffectScore(api.battleDex.moves.get(id),pokemon,null,{}, {},'p1','p2','Blastoise',pokemon.moves).score;
  assert.ok(Math.abs(added() - 16 * 0.7 * 0.9 / 4) < 1e-10);
  assert.ok(Math.abs(added('burningjealousy') - engineBurnChip(api, 'Blastoise') * 0.7 * 0.9 / 4) < 1e-10);
  pokemon.ability = 'voltabsorb'; assert.equal(added(),0);
  pokemon.ability = ''; api.battleState.p2.ability = 'sheerforce'; assert.equal(added(),0);
  api.battleState.p2.ability = null; api.battleState.p2.item = 'covertcloak'; assert.equal(added(),0);
});

test('評価修正: 未公開かちきの候補でも能力下降の危険を評価し、公開後は候補を確定する', () => {
  const {api,score} = effectReviewFixture('Clefable','Milotic',['moonblast','charm']);
  api.battleState.p2.revealedMoves.Milotic = new Set(['surf','icebeam','recover','protect']); api.battleState.p2.item = 'leftovers';
  const unknown = score('charm',true);
  assert.ok(unknown.score < 0);
  api.battleState.p2.ability = 'competitive'; const known = score('charm',true);
  assert.ok(known.score < unknown.score); assert.equal(known.opponentBoosts.spa,2);
  api.battleState.p2.ability = 'marvelscale'; assert.equal(score('charm',true).score,0);
});

test('評価修正: 候補ごとの持ち物交換は予測の重みで平均し、公開情報・request・実戦の秘密を変更しない', () => {
  const {api,pokemon,request,score} = effectReviewFixture('Slowbro','Milotic',['surf','recover','trick']);
  pokemon.item = 'choiceband';
  api.battleState.p2.revealedMoves.Milotic = new Set(['surf','icebeam','recover','protect']);
  const before = JSON.stringify({ state:api.battleState,field:api.fieldState,request });
  const profiles = api.effectProfileGroups('p2','Milotic');
  const expected = profiles.reduce((sum,p) => sum + p.weight * (score('trick',false,{},p).failed ? 0 : score('trick',false,{},p).score),0);
  const value = score('trick',true); assert.ok(Math.abs(value.score-expected)<1e-10);
  const live = api.createDamageBattle(api.knownCombatant(pokemon),api.knownCombatant(combatant('Milotic','competitive')),'p2');
  try {
    api.stream.battle = live.calc; live.defender.item = 'choicespecs'; live.defender.storedStats.spa = 999; live.defender.moveSlots[0].pp = 0;
    assert.equal(score('trick',true).score,value.score);
    assert.equal(JSON.stringify({state:api.battleState,field:api.fieldState,request}),before);
  } finally {api.stream.battle=null;live.calc.destroy();}
});

test('評価修正: 技制限もいたずらごころの悪タイプ無効とサイコフィールドを守る', () => {
  const {api,pokemon,score} = effectReviewFixture('Whimsicott','Umbreon',['moonblast','encore','disable']);
  pokemon.ability = 'prankster'; api.battleState.p2.lastMove = 'surf';
  for (const id of ['encore','disable']) assert.match(score(id).reason,/いたずらごころ無効/);
  const ground = effectReviewFixture('Whimsicott','Blastoise',['moonblast','encore','disable']);
  ground.pokemon.ability = 'prankster'; ground.api.battleState.p2.lastMove = 'surf'; ground.api.fieldState.terrain = 'psychic';
  for (const id of ['encore','disable']) assert.match(ground.score(id).reason,/サイコフィールド/);
});

test('評価修正: メンタルハーブが解除する技制限とプレッシャーで使い切るPPを反映する', () => {
  const {api,pokemon,score} = effectReviewFixture('Dusclops','Blastoise',['shadowball','encore','disable']);
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf','icebeam','darkpulse','aurasphere']);
  api.battleState.p2.lastMove = 'surf'; api.battleState.p2.item = 'mentalherb';
  for (const id of ['encore','disable']) assert.equal(score(id).failed,true);
  api.battleState.p2.item = null; pokemon.stats.spe = 1; pokemon.ability = 'pressure';
  api.battleState.p2.ppUsed.Blastoise = {surf:22,icebeam:14,darkpulse:22,aurasphere:30};
  for (const id of ['encore','disable']) assert.equal(score(id).failed,true,'プレッシャーで残り2PPを消費');
});

test('評価修正: p2側の技制限・持ち物交換も自分と相手の公開状態を取り違えない', () => {
  const api = loadLogic(); api.battleState.p2.species = 'Slowbro'; api.battleState.p1.species = 'Blastoise';
  api.battleState.p1.revealedMoves.Blastoise = new Set(['surf','protect','rest','irondefense']);
  const own = {...combatant('Slowbro'), active:true,item:'',moves:['surf','recover','trick','disable'],stats:{...combatant('Slowbro').stats,spe:300}};
  const request=moveRequest(own,own.moves);
  const score = id => api.evaluateMove({id},'Slowbro','Blastoise',null,null,{}, {},request,'p2','p1');
  api.battleState.p1.lastMove='surf'; assert.ok(score('disable').score>0);
  request.side.pokemon[0].item='choiceband'; api.battleState.p1.item='leftovers'; assert.ok(score('trick').score>0);
  assert.equal(api.battleState.p1.item,'leftovers'); assert.equal(request.side.pokemon[0].item,'choiceband');
});

test('能力下降はエンジンの無効・反射・反転・反応と上限を反映する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Arcanine'), moves: ['flamethrower', 'snarl'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  for (const [ability, ownSpa, foeSpa] of [['', 0, -1], ['clearbody', 0, 0], ['mirrorarmor', -1, 0], ['contrary', 0, 1], ['competitive', 0, 1]]) {
    api.battleState.p2.ability = ability;
    const effect = stateEffect(api, 'confide', pokemon);
    assert.equal(effect.ownBoosts.spa, ownSpa, ability);
    assert.equal(effect.opponentBoosts.spa, foeSpa, ability);
    if (ability === 'clearbody') assert.equal(effect.score, 0);
    if (ability === 'mirrorarmor' || ability === 'contrary' || ability === 'competitive') assert.ok(effect.score < 0, ability);
    if (!ability) assert.ok(effect.score > 0);
  }
  api.battleState.p2.ability = '';
  assert.equal(stateEffect(api, 'confide', pokemon, 'Blastoise', {}, { spa: -6 }).score, 0);
});

test('追加能力下降もミラーアーマーの反射を減点し無効なら加点しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Arcanine'; api.battleState.p2.species = 'Blastoise';
  const pokemon = { ...combatant('Arcanine'), moves: ['flamethrower', 'snarl'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  const added = () => api.addedEffectScore(api.battleDex.moves.get('snarl'), pokemon, null, {}, {}, 'p1', 'p2', 'Blastoise', pokemon.moves);
  assert.ok(added().score > 0);
  api.battleState.p2.ability = 'mirrorarmor'; assert.ok(added().score < 0);
  api.battleState.p2.ability = 'clearbody'; assert.equal(added().score, 0);
});

test('能力変化は技構成に応じた与ダメージ・被ダメージで評価する', () => {
  const api = loadLogic();
  const special = { ...combatant('Venusaur'), moves: ['gigadrain', 'sludgebomb', 'swordsdance', 'growl'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  assert.equal(stateEffect(api, 'swordsdance', special).score, 0, '特殊技だけなら攻撃上昇を加点しない');
  assert.equal(stateEffect(api, 'growl', special).score, 0, '相手の4技が特殊なら攻撃下降を加点しない');
  const physical = { ...special, moves: ['seedbomb', 'swordsdance'] };
  const effect = stateEffect(api, 'swordsdance', physical);
  assert.ok(effect.after.outgoing > effect.before.outgoing);
  assert.ok(effect.score > 0);
  const defense = stateEffect(api, 'amnesia', special);
  assert.ok(defense.after.incoming < defense.before.incoming);
  assert.ok(defense.score > 0);
});

test('能力コピー・リセット・反転は自分への不利益も含める', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'psychup', 'haze'] };
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'sludgebomb', 'earthpower', 'energyball']);
  assert.equal(stateEffect(api, 'psychup', pokemon, 'Venusaur').score, 0);
  assert.ok(stateEffect(api, 'psychup', pokemon, 'Venusaur', {}, { spa: 2 }).score > 0);
  assert.ok(stateEffect(api, 'haze', pokemon, 'Venusaur', { spa: 2 }, {}).score < 0);
  assert.ok(stateEffect(api, 'haze', pokemon, 'Venusaur', {}, { spa: 2 }).score > 0);
  assert.equal(stateEffect(api, 'topsyturvy', pokemon, 'Venusaur', {}, { spa: 2 }).opponentBoosts.spa, -2);
});

test('攻撃の主効果である能力リセットと自己下降を評価する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Machamp'), moves: ['closecombat', 'rockslide', 'clearsmog'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  assert.ok(stateEffect(api, 'closecombat', pokemon).score < 0);
  assert.ok(stateEffect(api, 'clearsmog', pokemon, 'Blastoise', {}, { spa: 2 }).score > 0);
  api.battleState.p2.volatiles.substitute = true;
  assert.equal(stateEffect(api, 'clearsmog', pokemon, 'Blastoise', {}, { spa: 2 }).opponentBoosts.spa, 2);
});

test('除去技は自分側と相手側の設置技の損益を区別する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'rapidspin', 'defog'] };
  const baseline = stateEffect(api, 'rapidspin', pokemon).score;
  api.fieldState.sides.p1.stealthRock = true;
  assert.ok(stateEffect(api, 'rapidspin', pokemon).score > baseline);
  const ownOnly = stateEffect(api, 'defog', pokemon).score;
  api.fieldState.sides.p2.stealthRock = true;
  assert.ok(stateEffect(api, 'defog', pokemon).score < ownOnly, '相手側の設置技を消す不利益');
  api.battleState.p2.ability = 'clearbody';
  api.fieldState.sides.p1.stealthRock = false; api.fieldState.sides.p2.stealthRock = false;
  assert.equal(stateEffect(api, 'defog', pokemon).score, 0, '無効な回避下降に加点しない');
});

test('交代技は控えなしで加点せず有利な控えへの移動を評価する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'teleport'] };
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'sludgebomb', 'earthpower', 'energyball']);
  assert.equal(stateEffect(api, 'teleport', pokemon, 'Venusaur').score, 0);
  const bench = { ...combatant('Charizard'), moves: ['flamethrower'], active: false };
  assert.ok(stateEffect(api, 'teleport', pokemon, 'Venusaur', {}, {}, [bench]).score > 0);
  const noHazards = stateEffect(api, 'teleport', pokemon, 'Venusaur', {}, {}, [bench]).score;
  api.fieldState.sides.p1.stealthRock = true;
  assert.ok(stateEffect(api, 'teleport', pokemon, 'Venusaur', {}, {}, [bench]).score < noHazards);
});

test('いかくの反射とまけんきは交代後の実際の能力に反映する', () => {
  const api = loadLogic(); api.battleState.p2.species = 'Corviknight';
  api.battleState.p2.ability = 'mirrorarmor';
  const pokemon = { ...combatant('Arcanine', 'intimidate'), moves: ['flareblitz'] };
  const reflected = api.getIntimidateSwitch(pokemon, {}, [], 'p2');
  assert.equal(reflected.ownBoosts.atk, -1); assert.equal(reflected.boosts.atk, 0); assert.equal(reflected.bonus, 0);
  api.battleState.p2.ability = 'defiant';
  assert.equal(api.getIntimidateSwitch(pokemon, {}, [], 'p2').boosts.atk, 1);
});

test('素早さ上昇の価値は先手への逆転・先制技・トリックルームを区別する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), stats: { ...combatant('Blastoise').stats, spe: 70 }, moves: ['surf', 'agility'] };
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'protect', 'toxic', 'synthesis']);
  const normal = stateEffect(api, 'agility', pokemon, 'Venusaur');
  assert.equal(normal.before.order, -1); assert.equal(normal.after.order, 1); assert.ok(normal.score > 0);
  api.fieldState.trickRoom = true;
  const reversed = stateEffect(api, 'agility', pokemon, 'Venusaur');
  assert.equal(reversed.before.order, 1); assert.equal(reversed.after.order, -1); assert.ok(reversed.score < 0);
  api.fieldState.trickRoom = false;
  api.battleState.p2.revealedMoves.Venusaur = new Set(['quickattack', 'protect', 'toxic', 'synthesis']);
  assert.equal(stateEffect(api, 'agility', pokemon, 'Venusaur').score, 0, '優先度が違えば素早さだけでは逆転しない');
});

test('ランダム追加状態異常は全候補の成功率を平均しタイプ無効を反映する', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Porygon-Z'; api.battleState.p2.species = 'Blastoise';
  const pokemon = { ...combatant('Porygon-Z'), moves: ['triattack'] };
  const added = (id, species) => api.addedEffectScore(api.battleDex.moves.get(id), pokemon, null, {}, {}, 'p1', 'p2', species, pokemon.moves).score;
  const triExpected=(species)=>0.2/3*(added('flamethrower',species)/0.1+added('thunderbolt',species)/0.1+added('icebeam',species)/0.1);
  assert.ok(Math.abs(added('triattack', 'Blastoise') - triExpected('Blastoise')) < 1e-8);
  api.battleState.p2.species = 'Charizard';
  assert.ok(Math.abs(added('triattack', 'Charizard') - triExpected('Charizard')) < 1e-8);
  api.battleState.p2.species = 'Blastoise'; api.battleState.p2.item = 'covertcloak';
  assert.equal(added('triattack', 'Blastoise'), 0);
  api.battleState.p2.item = null;
  const direExpected=0.3/3*(added('sludgebomb','Blastoise')/0.3+added('thunderbolt','Blastoise')/0.1+added('relicsong','Blastoise')/0.1);
  assert.ok(Math.abs(added('direclaw', 'Blastoise') - direExpected) < 1e-8);
  assert.equal(added('throatchop', 'Blastoise'), 14);
});

test('はらだいこ・きあいだめ・混乱も実際の効果とHP代償を評価する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Snorlax'), moves: ['bodyslam', 'bellydrum', 'focusenergy'] };
  const drum = stateEffect(api, 'bellydrum', pokemon);
  assert.equal(drum.ownBoosts.atk, 6);
  assert.ok(drum.after.outgoing > drum.before.outgoing);
  assert.ok(drum.score < drum.after.value - drum.before.value, 'HP代償を引く');
  assert.equal(stateEffect(api, 'bellydrum', { ...pokemon, condition: '90/200' }).ownBoosts.atk, 0);
  assert.ok(stateEffect(api, 'focusenergy', pokemon).score > 0);
  assert.equal(stateEffect(api, 'confuseray', pokemon).score, 16);
  api.battleState.p2.ability = 'owntempo';
  assert.equal(stateEffect(api, 'confuseray', pokemon).score, 0);
});

test('つぼをつくは上げられる各能力の評価を平均し毎回同じ結果を返す', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Drapion'), moves: ['poisonjab', 'acupressure'] };
  const result = stateEffect(api, 'acupressure', pokemon);
  assert.equal(result.outcomes.length, 7);
  assert.equal(result.score, result.outcomes.reduce((sum, value) => sum + value, 0) / 7);
  assert.equal(stateEffect(api, 'acupressure', pokemon).score, result.score);
  assert.equal(stateEffect(api, 'acupressure', pokemon, 'Blastoise', { atk: 6, def: 6, spa: 6, spd: 6, spe: 6, accuracy: 6, evasion: 6 }).score, 0);
});

test('攻撃に伴う設置とやけど治癒も主ダメージと別に評価する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Kleavor'), moves: ['stoneaxe', 'surf'] };
  const rock = stateEffect(api, 'stoneaxe', pokemon);
  assert.ok(rock.score > 0);
  api.fieldState.sides.p2.stealthRock = true;
  assert.equal(stateEffect(api, 'stoneaxe', pokemon).score, 0);
  api.fieldState.sides.p2.stealthRock = false;
  api.battleState.p2.status = 'brn';
  assert.ok(stateEffect(api, 'sparklingaria', pokemon).score < 0, '相手のやけどを治す利益を減点');
  api.battleState.p2.item = 'covertcloak';
  assert.equal(stateEffect(api, 'sparklingaria', pokemon).score, 0);
});

test('効果評価は公開状態・自分のrequest・実戦バトルを書き換えない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'psychup', 'rapidspin'] };
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Venusaur';
  api.battleState.p2.boosts.spa = 2; api.fieldState.sides.p1.stealthRock = true;
  const request = moveRequest(pokemon, pokemon.moves);
  const snapshot = JSON.stringify({ own: api.battleState.p1, foe: api.battleState.p2, field: api.fieldState, request });
  for (const id of ['psychup', 'haze', 'rapidspin']) api.evaluateProjectedStateEffect(api.battleDex.moves.get(id), request.side.pokemon[0], 'Venusaur', {}, { spa: 2 }, request, 'p1', 'p2');
  assert.equal(JSON.stringify({ own: api.battleState.p1, foe: api.battleState.p2, field: api.fieldState, request }), snapshot);
});

test('いやしのすずは控えの状態異常と防音特性を区別する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blissey'), moves: ['seismictoss', 'healbell'] };
  assert.equal(stateEffect(api, 'healbell', pokemon).score, 0);
  const bench = { ...combatant('Machamp'), active: false, condition: '200/200 brn', moves: ['brickbreak'] };
  assert.ok(stateEffect(api, 'healbell', pokemon, 'Blastoise', {}, {}, [bench]).score > 0);
  assert.equal(stateEffect(api, 'healbell', pokemon, 'Blastoise', {}, {}, [{ ...bench, ability: 'soundproof' }]).score, 0);
});

test('設置技の除去はブーツを履いた本人以外の控えにも利益がある', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), item: 'heavydutyboots', moves: ['surf', 'rapidspin'] };
  const bench = { ...combatant('Charizard'), active: false, moves: ['flamethrower'] };
  const baseline = stateEffect(api, 'rapidspin', pokemon, 'Blastoise', {}, {}, [bench]).score;
  api.fieldState.sides.p1.stealthRock = true;
  assert.ok(stateEffect(api, 'rapidspin', pokemon, 'Blastoise', {}, {}, [bench]).score > baseline);
});

test('強制交代は控えなし・瀕死・きゅうばんでは成功扱いしない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Arcanine'), moves: ['flamethrower', 'roar'] };
  assert.equal(stateEffect(api, 'roar', pokemon).forcedSwitch, false);
  api.battleState.p2.previewSpecies = ['Blastoise', 'Venusaur'];
  assert.equal(stateEffect(api, 'roar', pokemon).forcedSwitch, true);
  api.battleState.p2.ability = 'suctioncups';
  assert.equal(stateEffect(api, 'roar', pokemon).forcedSwitch, false);
  api.battleState.p2.ability = '';
  api.battleState.p2.faintedSpecies.add('Venusaur');
  assert.equal(stateEffect(api, 'roar', pokemon).forcedSwitch, false);
});

test('p2の能力変化・除去評価も双方の公開状態を正しく対応させる', () => {
  const api = loadLogic();
  api.battleState.p2.species = 'Arcanine'; api.battleState.p1.species = 'Corviknight';
  api.battleState.p1.ability = 'mirrorarmor';
  const pokemon = { ...combatant('Arcanine'), active: true, moves: ['flamethrower', 'confide'] };
  const effect = api.evaluateProjectedStateEffect(api.battleDex.moves.get('confide'), pokemon, 'Corviknight', {}, {}, moveRequest(pokemon, pokemon.moves), 'p2', 'p1');
  assert.equal(effect.ownBoosts.spa, -1); assert.equal(effect.opponentBoosts.spa, 0); assert.ok(effect.score < 0);
  api.fieldState.sides.p2.stealthRock = true;
  const cleared = api.evaluateProjectedStateEffect(api.battleDex.moves.get('rapidspin'), pokemon, 'Corviknight', {}, {}, moveRequest(pokemon, ['flamethrower', 'rapidspin']), 'p2', 'p1');
  assert.ok(cleared.reason.includes('設置技の増減'));
});

test('未対応の変化技は一律10点を付けず理由を表示する', () => {
  const api = loadLogic();
  const result = evaluate(api, 'celebrate', 'Ditto', 'Blastoise');
  assert.equal(result.score, 0); assert.match(result.reason, /評価未対応/);
});

test('残件: シングルで使えない6技は未対応扱いせず失敗として除外する', () => {
  const api = loadLogic();
  for (const id of ['followme', 'ragepowder', 'afteryou', 'quash', 'allyswitch', 'dragoncheer']) {
    const result = evaluate(api, id, 'Clefable', 'Blastoise');
    assert.equal(result.score, -100, id); assert.match(result.reason, /シングル/, id);
  }
});

test('シングル設計: マスターの9技を形式別に制限し、有効な範囲技・相手対象技を維持する', () => {
  const api = loadLogic();
  const blocked = api.moves.map((row) => api.battleDex.moves.get(row.showdownId)).filter((move) => !battleRules.isMoveAllowed(move));
  assert.deepEqual(Array.from(blocked, (move) => move.id).sort(), ['followme','ragepowder','afteryou','quash','allyswitch','dragoncheer','helpinghand','aromaticmist','coaching'].sort());
  for (const move of blocked) {
    assert.equal(battleRules.isMoveAllowed(move, battleRules.BATTLE_MODES.doubles), true, move.id);
    assert.match(evaluate(api, move.id, 'Clefable', 'Blastoise').reason, /シングル/, move.id);
    assert.match(api.evaluateUtilityStatusMove(move, combatant('Clefable'), api.battleDex.species.get('Blastoise'), {}).reason, /シングル/, move.id);
  }
  for (const id of ['wideguard','quickguard','surf','earthquake','healpulse','pollenpuff','instruct','magneticflux','teatime']) {
    assert.equal(battleRules.isMoveAllowed(api.battleDex.moves.get(id)), true, id);
  }
  assert.equal(battleRules.isMoveAllowed({ id: 'futureallymove', target: 'adjacentAlly' }), false, '新しい味方専用技も対象定義で除外');
});

test('シングル設計: 日本語チーム変換とShowdownチーム検証の両方で登録を拒否する', () => {
  const api = loadLogic();
  const file = path.join(require('node:os').tmpdir(), `pokesim-singles-${require('node:crypto').randomUUID()}.json`);
  const team = JSON.parse(fs.readFileSync('teams/team-a.json', 'utf8'));
  team[0].moves[0] = 'てだすけ';
  try {
    fs.writeFileSync(file, JSON.stringify(team));
    assert.throws(() => api.convertTeam(file), /シングル.*ダブル向け/);
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
  const legal = Array.from(api.teamA, (member) => ({ ...member, moves: [...member.moves] }));
  assert.equal(api.validator.validateTeam(legal), null);
  for (const id of ['helpinghand','aromaticmist','coaching','followme','ragepowder','afteryou','quash','allyswitch','dragoncheer']) {
    const invalid = legal.map((member) => ({ ...member, moves: [...member.moves] }));
    invalid[0].moves[0] = id;
    assert.ok(api.validator.validateTeam(invalid).some((problem) => /シングル.*ダブル向け/.test(problem)), id);
  }
});

test('シングル設計: 禁止技を選択候補から外し元の技スロット番号を保持する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Clefable'), active: true, moves: ['helpinghand','surf'] };
  const request = moveRequest(pokemon, pokemon.moves);
  assert.equal(api.chooseActionInternal('p1', request, null, true), 'move 2', '種族判明前の簡易選択でも除外');
  api.battleState.p1.species = 'Clefable'; api.battleState.p2.species = 'Blastoise';
  assert.equal(api.chooseActionInternal('p1', request, null, true), 'move 2');
  assert.throws(() => api.chooseActionInternal('p1', moveRequest(pokemon, ['helpinghand']), null, true), /使用可能な技がありません/);
});

test('シングル設計: 公開履歴・既知技・構成予測の候補へ禁止技を混入させない', () => {
  const api = loadLogic();
  api.battleState.p2.species = 'Clefable';
  api.battleState.p2.revealedMoves.Clefable = new Set(['helpinghand','surf']);
  assert.deepEqual(Array.from(api.getRevealedMoves('p2','Clefable')), ['surf']);
  for (const action of api.publicActionModel('p2','Clefable', { moves: ['helpinghand','surf'] })) assert.notEqual(action.move?.id, 'helpinghand');
  api.battleState.p2.volatiles.encoreMove = 'helpinghand';
  assert.equal(api.publicActionModel('p2','Clefable')[0].unable, true, '技固定があっても禁止技を予測しない');
  delete api.battleState.p2.volatiles.encoreMove;
  for (const species of ['Clefable','Jumpluff','Lucario','Alcremie']) {
    for (const profile of api.predictOpponentSets('p2', species, ['helpinghand','coaching','aromaticmist','surf'])) {
      assert.ok(profile.moves.includes('surf'), species);
      assert.ok(profile.moves.every((id) => battleRules.isMoveAllowed(api.battleDex.moves.get(id))), species);
    }
  }
  assert.ok(api.battleState.p2.revealedMoves.Clefable.has('helpinghand'), '元の公開履歴は破壊しない');
});

test('シングル設計: ダブルの制限定義は保持するが未実装の対戦を開始しない', () => {
  assert.equal(battleRules.ACTIVE_BATTLE_RULES.gameType, 'singles');
  assert.equal(battleRules.BATTLE_MODES.doubles.activeSlots, 2);
  assert.throws(() => battleRules.assertBattleModeSupported(battleRules.BATTLE_MODES.doubles), /未実装/);
  assert.throws(() => battleRules.moveRestriction({ id: 'surf' }, { gameType: 'unknown' }), /未定義/);
  const api = loadLogic();
  assert.throws(() => api.chooseActionInternal('p1', { active: [{moves:[]},{moves:[]}] }, null, true), /シングルのみ/);
  assert.throws(() => api.chooseActionInternal('p1', { forceSwitch: [true,true] }, null, true), /シングルのみ/);
  assert.throws(() => battleRules.createBattleTeamValidator(null, null, battleRules.BATTLE_MODES.doubles), /未実装/);
});

test('残件: へんしんは公開4技・能力・ランクをコピーし変身済みとみがわりには失敗する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Ditto'), moves: ['transform'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'protect', 'shellsmash']);
  api.battleState.p2.ability = 'torrent';
  const result = stateEffect(api, 'transform', pokemon, 'Blastoise', {}, { spa: 2 });
  assert.equal(result.acted, true); assert.equal(result.ownBoosts.spa, 2);
  assert.deepEqual(Array.from(result.ownMoves), ['surf', 'icebeam', 'protect', 'shellsmash']);
  assert.ok(result.score > 0);
  api.battleState.p2.volatiles.substitute = true;
  assert.equal(stateEffect(api, 'transform', pokemon).failed, true);
  api.battleState.p2.volatiles.substitute = false; api.battleState.p2.transformed = true;
  assert.equal(stateEffect(api, 'transform', pokemon).failed, true);
});

test('残件: うらみは最後の技の推定PPを削り、技履歴なしでは失敗する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Gengar'), moves: ['shadowball', 'spite'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['hydropump', 'tackle', 'protect', 'rest']);
  assert.equal(stateEffect(api, 'spite', pokemon).failed, true);
  api.battleState.p2.lastMove = 'hydropump';
  const initial = stateEffect(api, 'spite', pokemon);
  assert.ok(initial.score > 0);
  api.battleState.p2.ppUsed.Blastoise = { hydropump: 7 };
  assert.ok(stateEffect(api, 'spite', pokemon).score > initial.score);
  api.battleState.p2.ppUsed.Blastoise.hydropump = 8;
  assert.equal(stateEffect(api, 'spite', pokemon).failed, true);
});

test('残件: ロックオンは低命中技の次の命中を上げ、必中技のみでは加点しない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['hydropump', 'lockon'] };
  assert.ok(stateEffect(api, 'lockon', pokemon).score > 0);
  assert.equal(stateEffect(api, 'lockon', { ...pokemon, moves: ['surf', 'lockon'] }).score, 0);
  api.battleState.p1.volatiles.lockon = true;
  assert.equal(stateEffect(api, 'lockon', pokemon).failed, true);
});

test('残件: しんぴのまもりは相手の状態異常技とすりぬけを区別する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'safeguard'] };
  api.battleState.p2.revealedMoves.Venusaur = new Set(['sleeppowder', 'toxic', 'confuseray', 'protect']);
  assert.ok(stateEffect(api, 'safeguard', pokemon, 'Venusaur').score > 0);
  api.battleState.p2.ability = 'infiltrator';
  assert.equal(stateEffect(api, 'safeguard', pokemon, 'Venusaur').score, 0);
  api.battleState.p2.ability = '';
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'earthpower', 'tackle', 'protect']);
  assert.equal(stateEffect(api, 'safeguard', pokemon, 'Venusaur').score, 0);
});

test('残件: のみこむは公開されたたくわえの1・2・3回と実回復上限を使う', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Snorlax'), condition: '20/200', moves: ['bodyslam', 'swallow'] };
  assert.equal(stateEffect(api, 'swallow', pokemon).failed, true);
  const scores = [];
  for (const layers of [1, 2, 3]) {
    api.battleState.p1.volatiles.stockpile = { layers, def: -layers, spd: -layers };
    const result = stateEffect(api, 'swallow', pokemon, 'Blastoise', { def: layers, spd: layers });
    assert.equal(result.acted, true); assert.equal(result.ownBoosts.def, 0); assert.equal(result.ownBoosts.spd, 0);
    scores.push(result.score);
  }
  assert.ok(scores[1] > scores[0]); assert.ok(scores[2] > scores[1]);
});

test('残件: いちゃもんとふういんは相手の使える攻撃を減らした分だけ評価する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Gengar'), moves: ['shadowball', 'surf', 'imprison', 'torment'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'tackle', 'protect', 'rest']);
  api.battleState.p2.lastMove = 'surf';
  assert.ok(stateEffect(api, 'torment', pokemon).score > 0);
  assert.ok(stateEffect(api, 'imprison', pokemon).score > 0);
  assert.equal(stateEffect(api, 'imprison', { ...pokemon, moves: ['shadowball', 'imprison'] }).score, 0);
});

test('残件: リサイクルは消費した物だけ回収し、奪われた持ち物は回収しない', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: Lax|Snorlax, L50|200/200\n|switch|p2a: Turtle|Blastoise, L50|200/200\n|-enditem|p1a: Lax|Sitrus Berry|[eat]');
  const pokemon = { ...combatant('Snorlax'), condition: '80/200', moves: ['bodyslam', 'recycle'] };
  const result = stateEffect(api, 'recycle', pokemon);
  assert.ok(result.score > 0); assert.equal(result.acted, true);
  api.updateBattleState('|-item|p1a: Lax|Sitrus Berry|[from] move: Recycle\n|-enditem|p1a: Lax|Sitrus Berry|[from] move: Knock Off');
  assert.equal(stateEffect(api, 'recycle', pokemon).failed, true);
  api.battleState.p1.consumedItems.Snorlax = 'leftovers';
  assert.ok(stateEffect(api, 'recycle', pokemon).score > 0);
  assert.equal(stateEffect(api, 'recycle', { ...pokemon, item: 'leftovers' }).failed, true);
});

test('残件: いやしのねがいは控えなしでは失敗し、本人の犠牲と控えの回復を比較する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blissey'), condition: '10/200', moves: ['seismictoss', 'healingwish'] };
  assert.equal(stateEffect(api, 'healingwish', pokemon).score, -100);
  const bench = { ...combatant('Venusaur'), active: false, condition: '20/200 brn', moves: ['gigadrain'] };
  assert.ok(stateEffect(api, 'healingwish', pokemon, 'Blastoise', {}, {}, [bench]).score > 0);
  const healthy = { ...bench, condition: '200/200' };
  assert.ok(stateEffect(api, 'healingwish', { ...pokemon, condition: '200/200' }, 'Blastoise', {}, {}, [healthy]).score < 0);
});

test('残件: まねっこは直前の公開技を自分の能力で評価し禁止技を呼ばない', () => {
  const api = loadLogic();
  assert.equal(evaluate(api, 'copycat', 'Sylveon', 'Blastoise').score, -100);
  api.publicEffectHistory.lastMove = { id: 'thunderbolt', player: 'p2', turn: 1 };
  const result = evaluate(api, 'copycat', 'Sylveon', 'Blastoise');
  assert.ok(result.maxDamagePercent > 0); assert.match(result.reason, /まねっこでThunderbolt/);
  api.publicEffectHistory.lastMove.id = 'protect';
  assert.equal(evaluate(api, 'copycat', 'Sylveon', 'Blastoise').score, -100);
});

test('残件: ワイドガードは範囲技だけ、ファストガードは先制技だけ防ぐ', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Machamp'), stats: { ...combatant('Machamp').stats, spe: 200 }, moves: ['brickbreak', 'wideguard', 'quickguard'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'protect', 'rest', 'toxic']);
  assert.ok(stateEffect(api, 'wideguard', pokemon).score > 0);
  assert.equal(stateEffect(api, 'quickguard', pokemon).score, 0);
  api.battleState.p2.revealedMoves.Blastoise = new Set(['aquajet', 'protect', 'rest', 'toxic']);
  assert.ok(stateEffect(api, 'quickguard', pokemon).score > 0);
  assert.equal(stateEffect(api, 'wideguard', pokemon).score, 0);
  api.battleState.p2.revealedMoves.Blastoise = new Set(['icebeam', 'protect', 'rest', 'toxic']);
  assert.equal(stateEffect(api, 'wideguard', pokemon).score, 0);
});

test('残件: いやしのはどうはシングルの相手を回復する不利益と回復上限を反映する', () => {
  const api = loadLogic(); const pokemon = { ...combatant('Blissey'), moves: ['seismictoss', 'healpulse'] };
  api.battleState.p2.hpPercent = 20;
  assert.ok(stateEffect(api, 'healpulse', pokemon).score < 0);
  api.battleState.p2.hpPercent = 100;
  assert.equal(stateEffect(api, 'healpulse', pokemon).score, 0);
});

test('残件: そうでんは先手の対面変化を評価し、後手なら加点しない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Garchomp'), stats: { ...combatant('Garchomp').stats, spe: 300 }, moves: ['earthquake', 'electrify'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'tackle', 'protect']);
  assert.ok(stateEffect(api, 'electrify', pokemon).score > 0);
  assert.equal(stateEffect(api, 'electrify', { ...pokemon, stats: { ...pokemon.stats, spe: 1 } }).score, 0);
});

test('残件: フェアリーロックとくらいつくは双方の交代を止める損益を比較する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blastoise'), moves: ['surf', 'fairylock', 'jawlock'] };
  const bench = { ...combatant('Charizard'), active: false, moves: ['flamethrower'] };
  api.battleState.p2.revealedMoves.Venusaur = new Set(['gigadrain', 'sludgebomb', 'earthpower', 'protect']);
  assert.equal(stateEffect(api, 'fairylock', pokemon, 'Venusaur').score, 0);
  assert.ok(stateEffect(api, 'fairylock', pokemon, 'Venusaur', {}, {}, [bench]).score < 0);
  assert.ok(stateEffect(api, 'jawlock', pokemon, 'Venusaur', {}, {}, [bench]).score < 0);
});

test('残件: じばそうさはプラス・マイナスだけ防御を上げる', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Ampharos', 'plus'), moves: ['thunderbolt', 'magneticflux'] };
  const result = stateEffect(api, 'magneticflux', pokemon);
  assert.equal(result.ownBoosts.def, 1); assert.equal(result.ownBoosts.spd, 1); assert.ok(result.score > 0);
  assert.equal(stateEffect(api, 'magneticflux', { ...pokemon, ability: 'static' }).failed, true);
});

test('残件: おちゃかいは双方のきのみの実効果と何も食べられない場合を区別する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Snorlax'), condition: '200/200 par', item: 'lumberry', moves: ['bodyslam', 'teatime'] };
  const result = stateEffect(api, 'teatime', pokemon);
  assert.equal(result.ownStatus, ''); assert.equal(result.ownItem, ''); assert.ok(result.score > 0);
  assert.equal(stateEffect(api, 'teatime', { ...pokemon, condition: '200/200', item: '' }).failed, true);
  api.battleState.p2.item = 'lumberry'; api.battleState.p2.status = 'par';
  assert.ok(stateEffect(api, 'teatime', { ...pokemon, condition: '200/200', item: '' }).score < 0);
});

test('残件: さいはいは相手の直前技をもう一度動かす不利益と禁止技を反映する', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Blissey'), moves: ['seismictoss', 'instruct'] };
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'protect', 'rest', 'hydropump']);
  api.battleState.p2.lastMove = 'surf';
  assert.ok(stateEffect(api, 'instruct', pokemon).score < 0);
  api.battleState.p2.lastMove = 'instruct';
  assert.equal(stateEffect(api, 'instruct', pokemon).failed, true);
});

test('残件: 公開ログだけからPP使用・追加減少・消費品・たくわえ・ターン内上昇を保持する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: Lax|Snorlax, L50|200/200\n|switch|p2a: Turtle|Blastoise, L50|200/200\n|turn|1\n|move|p1a: Lax|Stockpile|p1a: Lax\n|-start|p1a: Lax|stockpile1\n|-boost|p1a: Lax|def|1\n|-boost|p1a: Lax|spd|1\n|move|p2a: Turtle|Hydro Pump|p1a: Lax\n|-activate|p2a: Turtle|move: Spite|Hydro Pump|4');
  assert.equal(api.battleState.p1.volatiles.stockpile.layers, 1); assert.equal(api.battleState.p1.volatiles.stockpile.def, -1);
  assert.equal(api.battleState.p1.statsRaisedThisTurn, true);
  assert.equal(api.battleState.p2.ppUsed.Blastoise.hydropump, 5);
  api.updateBattleState('|turn|2'); assert.equal(api.battleState.p1.statsRaisedThisTurn, false);
  api.updateBattleState('|switch|p1a: Other|Venusaur, L50|200/200'); assert.equal(api.battleState.p1.volatiles.stockpile, undefined);
  api.updateBattleState('|clearpoke'); assert.deepEqual(Object.keys(api.battleState.p2.ppUsed), []);
});

test('残件: とどめばりは倒せた場合のみ上昇し、失敗・無効では加点しない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Drapion'), moves: ['poisonjab', 'fellstinger'] };
  api.battleState.p2.previewSpecies = ['Blastoise', 'Venusaur'];
  const full = stateEffect(api, 'fellstinger', pokemon);
  assert.equal(full.ownBoosts.atk, 0); assert.equal(full.score, 0);
  api.battleState.p2.hpPercent = 1;
  const ko = stateEffect(api, 'fellstinger', pokemon);
  assert.equal(ko.ownBoosts.atk, 3); assert.ok(ko.score > 0);
  const request = moveRequest(pokemon, pokemon.moves);
  const evaluated = api.evaluateMove({ id: 'fellstinger' }, 'Drapion', 'Blastoise', null, null, {}, {}, request, 'p1', 'p2');
  assert.match(evaluated.reason, /とどめばり/);
  api.battleState.p2.previewSpecies = [];
  assert.equal(stateEffect(api, 'fellstinger', pokemon).ownBoosts.atk, 0, '最後の相手なら上昇しない');
  api.battleState.p2.previewSpecies = ['Blastoise','Venusaur'];
  api.battleState.p2.volatiles.substitute = true;
  assert.equal(stateEffect(api, 'fellstinger', pokemon).ownBoosts.atk, 0, 'みがわりを倒しても上昇しない');
});

test('残件: かふんだんごはシングルの相手に攻撃し味方回復を加点しない', () => {
  const api = loadLogic();
  const pokemon = { ...combatant('Ribombee'), moves: ['pollenpuff'] };
  const result = api.evaluateMove({ id: 'pollenpuff' }, 'Ribombee', 'Blastoise', null, null, {}, {}, moveRequest(pokemon, pokemon.moves), 'p1', 'p2');
  assert.ok(result.maxDamagePercent > 0);
  assert.ok(!/回復/.test(result.reason || ''));
  const defender = combatant('Blastoise');
  assert.equal(damageFor(api, 'pollenpuff', pokemon, defender).minDamagePercent, executeEngineMove(api, 'pollenpuff', pokemon, defender).damage);
});

test('残件: シェルアームズは物理・特殊の選択が実行エンジンと一致する', () => {
  const api = loadLogic();
  const foe = combatant('Blastoise');
  for (const stats of [{ atk: 220, spa: 20 }, { atk: 20, spa: 220 }]) {
    const pokemon = { ...combatant('Slowbro-Galar'), stats: { ...combatant('Slowbro-Galar').stats, ...stats } };
    const result = damageFor(api, 'shellsidearm', pokemon, foe);
    assert.equal(result.minDamagePercent, executeEngineMove(api, 'shellsidearm', pokemon, foe).damage);
    assert.match(result.fieldReason, /分類/);
  }
});

test('残件: シェルアームズの物理側だけゴツゴツメットを考慮する', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Slowbro-Galar'; api.battleState.p2.species = 'Blastoise';
  for (const [physical, stats] of [[true, { atk: 300, spa: 20 }], [false, { atk: 20, spa: 300 }]]) {
    const pokemon = { ...combatant('Slowbro-Galar'), stats: { ...combatant('Slowbro-Galar').stats, ...stats }, moves: ['shellsidearm'] };
    const score = () => api.evaluateMove({ id: 'shellsidearm' }, 'Slowbro-Galar', 'Blastoise', null, null, {}, {}, moveRequest(pokemon, pokemon.moves), 'p1', 'p2').score;
    api.battleState.p2.item = null; const baseline = score();
    api.battleState.p2.item = 'rockyhelmet'; const protectedScore = score();
    if (physical) assert.ok(baseline - protectedScore > 16);
    else assert.equal(protectedScore, baseline);
  }
});

test('残件: しっとのほのおとみわくのボイスは公開された当ターン上昇で発動する', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Arcanine'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  const pokemon = { ...combatant('Arcanine'), moves: ['flamethrower', 'burningjealousy', 'alluringvoice'] };
  const added = (id) => api.addedEffectScore(api.battleDex.moves.get(id), pokemon, null, {}, {}, 'p1', 'p2', 'Blastoise', pokemon.moves).score;
  assert.equal(added('burningjealousy'), 0); assert.equal(added('alluringvoice'), 0);
  api.battleState.p2.statsRaisedThisTurn = true;
  assert.ok(Math.abs(added('burningjealousy') - engineBurnChip(api, 'Blastoise')) < 1e-10); assert.equal(added('alluringvoice'), 16);
  api.battleState.p2.item = 'covertcloak';
  assert.equal(added('burningjealousy'), 0); assert.equal(added('alluringvoice'), 0);
});

test('残件: 条件付き追加効果は先に動く相手の積み技とランク上限を考慮する', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Arcanine'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['shellsmash', 'protect', 'rest', 'surf']);
  const pokemon = { ...combatant('Arcanine'), stats: { ...combatant('Arcanine').stats, spe: 1 }, moves: ['flamethrower', 'burningjealousy'] };
  const added = (own) => api.addedEffectScore(api.battleDex.moves.get('burningjealousy'), own, null, {}, {}, 'p1', 'p2', 'Blastoise', own.moves).score;
  assert.ok(Math.abs(added(pokemon) - engineBurnChip(api, 'Blastoise') / 4) < 1e-10, '4技のうち先に使うからをやぶる1技だけ');
  assert.equal(added({ ...pokemon, stats: { ...pokemon.stats, spe: 300 } }), 0);
  api.battleState.p2.boosts = { ...api.createEmptyBoosts(), atk: 6, spa: 6, spe: 6 };
  assert.equal(api.addedEffectScore(api.battleDex.moves.get('burningjealousy'), pokemon, null, {}, api.battleState.p2.boosts, 'p1', 'p2', 'Blastoise', pokemon.moves).score, 0);
});

test('残件: ぶきみなじゅもんは最後の技のPP減少を評価しマント・履歴なしでは加点しない', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Slowking-Galar'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'darkpulse', 'aurasphere']);
  const pokemon = { ...combatant('Slowking-Galar'), stats: { ...combatant('Slowking-Galar').stats, spe: 300 }, moves: ['eeriespell'] };
  const added = () => api.addedEffectScore(api.battleDex.moves.get('eeriespell'), pokemon, null, {}, {}, 'p1', 'p2', 'Blastoise', pokemon.moves).score;
  assert.equal(added(), 0);
  api.battleState.p2.lastMove = 'surf'; assert.ok(added() > 0);
  const previousMoveValue = added();
  api.battleState.p2.volatiles.mustrecharge = true;
  assert.equal(added(), previousMoveValue, '反動で動けない相手にも前の技のPP減少は有効');
  delete api.battleState.p2.volatiles.mustrecharge;
  api.battleState.p2.item = 'covertcloak'; assert.equal(added(), 0);
  api.battleState.p2.item = null; api.battleState.p2.ppUsed.Blastoise = { surf: 24 }; assert.equal(added(), 0);
});

test('残件: 31技の対応分類と実行評価は未対応の理由を返さない', () => {
  const api = loadLogic();
  const statusIds = ['transform','spite','lockon','safeguard','swallow','torment','followme','recycle','imprison','healingwish','copycat','wideguard','ragepowder','afteryou','quickguard','allyswitch','healpulse','quash','electrify','fairylock','magneticflux','instruct','teatime','dragoncheer'];
  for (const id of statusIds) {
    assert.ok(api.moveEffectEvaluationKind(api.battleDex.moves.get(id)), id);
    const result = evaluate(api, id, 'Blastoise', 'Venusaur');
    assert.ok(Number.isFinite(result.score), id); assert.ok(!/評価未対応/.test(result.reason || ''), id);
  }
  for (const id of ['fellstinger','pollenpuff','jawlock','shellsidearm','burningjealousy','eeriespell','alluringvoice']) assert.equal(api.hasHandledAdditionalEffect(api.battleDex.moves.get(id)), true, id);
});

test('残件: 新しい効果評価は相手の非公開技・PP・持ち物・能力を読み込まない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Ditto'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['surf', 'icebeam', 'protect', 'shellsmash']);
  const pokemon = { ...combatant('Ditto'), active: true, moves: ['transform'] };
  const request = moveRequest(pokemon, pokemon.moves);
  const original = JSON.stringify({ battle: api.battleState, field: api.fieldState, request });
  const baseline = api.evaluateProjectedStateEffect(api.battleDex.moves.get('transform'), pokemon, 'Blastoise', {}, {}, request, 'p1', 'p2').score;
  const live = api.createDamageBattle(api.knownCombatant(pokemon), api.knownCombatant({ ...combatant('Blastoise'), moves: ['surf','icebeam'], item: 'choiceband', ability: 'raindish' }), 'p2');
  try {
    api.stream.battle = live.calc;
    live.defender.storedStats.atk = 999; live.defender.moveSlots[0].pp = 0;
    assert.equal(api.evaluateProjectedStateEffect(api.battleDex.moves.get('transform'), pokemon, 'Blastoise', {}, {}, request, 'p1', 'p2').score, baseline);
    assert.equal(JSON.stringify({ battle: api.battleState, field: api.fieldState, request }), original);
  } finally { api.stream.battle = null; live.calc.destroy(); }
});

test('残件: 公開PPが尽きた技を行動候補から除き、ヒメリの回復後は戻す', () => {
  const api = loadLogic(); api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['hydropump', 'surf', 'protect', 'rest']);
  api.battleState.p2.ppUsed.Blastoise = { hydropump: 8 };
  assert.ok(!api.publicActionModel('p2', 'Blastoise').some((row) => row.move?.id === 'hydropump'));
  api.updateBattleState('|-activate|p2a: Turtle|item: Leppa Berry|Hydro Pump|[consumed]');
  assert.ok(api.publicActionModel('p2', 'Blastoise').some((row) => row.move?.id === 'hydropump'));
  api.battleState.p2.ppUsed.Blastoise = { hydropump: 8, surf: 24, protect: 16, rest: 8 };
  assert.equal(api.publicActionModel('p2', 'Blastoise')[0].move.id, 'struggle');
});

test('残件: 条件付き追加効果は相手の睡眠・まひによる行動不能も織り込む', () => {
  const api = loadLogic(); api.battleState.p1.species = 'Arcanine'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['shellsmash', 'protect', 'rest', 'surf']);
  const pokemon = { ...combatant('Arcanine'), stats: { ...combatant('Arcanine').stats, spe: 1 }, moves: ['flamethrower','burningjealousy'] };
  const score = () => api.addedEffectScore(api.battleDex.moves.get('burningjealousy'), pokemon, null, {}, {}, 'p1', 'p2', 'Blastoise', pokemon.moves).score;
  assert.ok(Math.abs(score() - engineBurnChip(api, 'Blastoise') / 4) < 1e-10);
  api.battleState.p2.status = 'slp'; api.battleState.p2.statusAge = 0;
  assert.equal(score(), 0);
  api.battleState.p2.status = 'par'; assert.equal(score(), 0, '既に状態異常ならやけどは入らない');
  assert.equal(api.addedEffectScore(api.battleDex.moves.get('alluringvoice'), pokemon, 'par', {}, {}, 'p1', 'p2', 'Blastoise', pokemon.moves).score, 4 * 7 / 8);
});

test('残件: p2側でも消費品とたくわえを公開ログから評価する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: Turtle|Blastoise, L50|200/200\n|switch|p2a: Lax|Snorlax, L50|200/200\n|-enditem|p2a: Lax|Sitrus Berry|[eat]\n|move|p2a: Lax|Stockpile|p2a: Lax\n|-start|p2a: Lax|stockpile1\n|-boost|p2a: Lax|def|1\n|-boost|p2a: Lax|spd|1');
  const pokemon = { ...combatant('Snorlax'), active: true, condition: '20/200', moves: ['bodyslam','swallow','recycle'] };
  const result = api.evaluateProjectedStateEffect(api.battleDex.moves.get('swallow'), pokemon, 'Blastoise', { def: 1, spd: 1 }, {}, moveRequest(pokemon, pokemon.moves), 'p2', 'p1');
  assert.equal(result.acted, true); assert.equal(result.ownBoosts.def, 0);
  assert.equal(api.battleState.p2.consumedItems.Snorlax, 'sitrusberry');
});

function moveRequest(pokemon, moveIds) {
  return { side: { pokemon: [{ ...pokemon, active: true, moves: moveIds }] }, active: [{ trapped: true, moves: moveIds.map((id) => ({ id, move: id, pp: 10, disabled: false })) }] };
}

function executeEngineMove(api, id, attacker, defender, options = {}) {
  const session = api.createDamageBattle(api.knownCombatant(attacker, options.attackerBoosts), api.knownCombatant(defender, options.defenderBoosts), 'p2');
  try {
    if (options.weather) session.calc.field.setWeather(options.weather, session.attacker);
    if (options.substitute) session.defender.addVolatile('substitute');
    session.attacker.activeMoveActions = options.actions ?? 1;
    session.calc.randomChance = (n, d) => d === 100 || n >= d;
    session.calc.random = (n = 2) => n === 16 ? options.roll ?? 15 : n === 7 ? options.diceRoll ?? 6 : 0;
    const hp = session.defender.hp;
    const ownHp = session.attacker.hp;
    session.calc.actions.useMove(id, session.attacker, { target: options.self ? session.attacker : session.defender });
    return { damage: (hp - session.defender.hp) / session.defender.maxhp * 100, healed: session.attacker.hp - ownHp, substitute: !!session.defender.volatiles.substitute, seeded: !!session.defender.volatiles.leechseed, ownStatus: session.attacker.status, foeStatus: session.defender.status, foeVolatiles: Object.keys(session.defender.volatiles) };
  } finally { session.calc.destroy(); }
}

test('相手のみがわりにはやどりぎ・状態異常を入れず、本体のKOと混同しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Venusaur';
  api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.volatiles.substitute = true;
  for (const id of ['leechseed', 'toxic']) assert.equal(evaluate(api, id, 'Venusaur', 'Blastoise').score, -100);
  const attacker = combatant('Venusaur', 'overgrow');
  const defender = combatant('Blastoise');
  const result = damageFor(api, 'gigadrain', attacker, defender);
  assert.equal(result.minDamagePercent, 0);
  assert.equal(result.maxDamagePercent, 0);
  assert.equal(result.bodyHitChance, 0);
  assert.ok(result.substituteScore > 0, 'みがわりを削る価値は残す');
  assert.equal(executeEngineMove(api, 'gigadrain', attacker, defender, { substitute: true }).damage, 0);
  assert.equal(executeEngineMove(api, 'leechseed', attacker, defender, { substitute: true }).seeded, false);
});

test('みがわりを貫通する音技・すりぬけと、自分対象の技は使える', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Jumpluff';
  api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.volatiles.substitute = true;
  assert.ok(evaluate(api, 'leechseed', 'Jumpluff', 'Blastoise', 'infiltrator').score > 0);
  assert.equal(executeEngineMove(api, 'leechseed', combatant('Jumpluff', 'infiltrator'), combatant('Blastoise'), { substitute: true }).seeded, true);
  for (const [id, attacker] of [['hypervoice', combatant('Sylveon', 'pixilate')], ['gigadrain', combatant('Jumpluff', 'infiltrator')]]) {
    const result = damageFor(api, id, attacker, combatant('Blastoise'));
    assert.ok(result.minDamagePercent > 0);
    assert.equal(result.minDamagePercent, executeEngineMove(api, id, attacker, combatant('Blastoise'), { substitute: true }).damage);
  }
  assert.ok(evaluate(api, 'swordsdance', 'Venusaur', 'Blastoise').score > 0);
});

test('連続技はみがわり破壊後の一撃から本体を削る', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Machamp';
  api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.volatiles.substitute = true;
  const attacker = { ...combatant('Machamp'), stats: { atk: 400, def: 120, spa: 100, spd: 125, spe: 100 } };
  const defender = combatant('Blastoise');
  const result = damageFor(api, 'doublekick', attacker, defender);
  const engine = executeEngineMove(api, 'doublekick', attacker, defender, { substitute: true });
  assert.ok(engine.damage > 0);
  assert.equal(result.minDamagePercent, engine.damage);
  assert.ok(result.bodyHits < 2);
});

test('みがわりが防いだ追加効果を加点せず、公開されていない残りHPを参照しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise';
  api.battleState.p2.species = 'Arcanine';
  api.battleState.p2.volatiles.substitute = true;
  assert.doesNotMatch(evaluate(api, 'scald', 'Blastoise', 'Arcanine').reason || '', /やけど/);
  const attacker = combatant('Blastoise');
  const defender = combatant('Arcanine');
  const live = api.createDamageBattle(api.knownCombatant(attacker), api.knownCombatant(defender), 'p2');
  api.stream.battle = live.calc;
  try {
    live.defender.addVolatile('substitute');
    const before = damageFor(api, 'watergun', attacker, defender);
    live.defender.volatiles.substitute.hp = 1;
    assert.deepEqual(damageFor(api, 'watergun', attacker, defender), before);
  } finally { api.stream.battle = null; live.calc.destroy(); }
});

test('みがわりを攻撃した場合も自分への追加能力上昇は評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Kangaskhan';
  api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.volatiles.substitute = true;
  const result = evaluate(api, 'poweruppunch', 'Kangaskhan', 'Blastoise');
  assert.equal(result.maxDamagePercent, 0);
  assert.match(result.reason, /能力上昇/);
});

test('通常攻撃の命中・回避ランクをエンジンに合わせる', () => {
  const api = loadLogic();
  const attacker = combatant('Raichu');
  const defender = combatant('Blastoise');
  const attackBoosts = api.createEmptyBoosts(); attackBoosts.accuracy = -6;
  assert.equal(damageFor(api, 'thunderbolt', attacker, defender, { attackerBoosts: attackBoosts }).hitChance, 0.33);
  attackBoosts.accuracy = 6;
  assert.equal(damageFor(api, 'thunderbolt', attacker, defender, { attackerBoosts: attackBoosts }).hitChance, 1);
  const defenseBoosts = api.createEmptyBoosts(); defenseBoosts.evasion = 6;
  assert.equal(damageFor(api, 'thunderbolt', attacker, defender, { defenderBoosts: defenseBoosts }).hitChance, 0.33);
});

test('かみなりの雨・晴れ、ノーガード、こうかくレンズ、ひかりのこなを反映する', () => {
  const api = loadLogic();
  const attacker = combatant('Raichu');
  const defender = combatant('Blastoise');
  assert.equal(damageFor(api, 'thunder', attacker, defender).hitChance, 0.7);
  assert.equal(damageFor(api, 'thunder', attacker, defender, { weather: 'rain' }).hitChance, 1);
  assert.equal(damageFor(api, 'thunder', attacker, defender, { weather: 'sun' }).hitChance, 0.5);
  attacker.ability = 'noguard';
  assert.equal(damageFor(api, 'thunder', attacker, defender).hitChance, 1);
  attacker.ability = ''; attacker.item = 'widelens';
  assert.equal(damageFor(api, 'thunder', attacker, defender).hitChance, 0.77);
  attacker.item = ''; defender.item = 'brightpowder';
  assert.equal(damageFor(api, 'thunderbolt', attacker, defender).hitChance, 0.9);
});

test('変化技にも命中ランクとノーガードの補正を適用する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Arcanine'; api.battleState.p2.species = 'Blastoise';
  const request = moveRequest(combatant('Arcanine'), ['willowisp']);
  const ownBoosts = api.createEmptyBoosts(); ownBoosts.accuracy = -6;
  const baseline = api.evaluateMove({ id: 'willowisp' }, 'Arcanine', 'Blastoise', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, 'p1', 'p2');
  const result = api.evaluateMove({ id: 'willowisp' }, 'Arcanine', 'Blastoise', null, null, ownBoosts, api.createEmptyBoosts(), request, 'p1', 'p2');
  assert.equal(result.hitChance, 0.28);
  assert.ok(Math.abs(result.score - baseline.score * 0.28 / 0.85) < 1e-8);
  request.side.pokemon[0].ability = 'noguard';
  const certain = api.evaluateMove({ id: 'willowisp' }, 'Arcanine', 'Blastoise', null, null, ownBoosts, api.createEmptyBoosts(), request, 'p1', 'p2');
  assert.equal(certain.hitChance, 1);
  assert.ok(Math.abs(certain.score - baseline.score / 0.85) < 1e-8);
});

test('ねむるは回復・状態異常の解除と、失敗する条件を評価する', () => {
  const api = loadLogic();
  assert.equal(evaluate(api, 'rest', 'Blastoise', 'Arcanine').score, -100);
  const hurt = evaluate(api, 'rest', 'Blastoise', 'Arcanine', 'torrent', '', '50/200');
  assert.ok(hurt.score > 0);
  assert.match(hurt.reason, /回復75%/);
  const engine = executeEngineMove(api, 'rest', { ...combatant('Blastoise', 'torrent'), condition: '50/200' }, combatant('Arcanine'), { self: true });
  assert.equal(engine.healed, 150); assert.equal(engine.ownStatus, 'slp');
  api.battleState.p1.status = 'brn';
  assert.ok(evaluate(api, 'rest', 'Blastoise', 'Arcanine', 'torrent', '', '50/200 brn').score > hurt.score);
  api.battleState.p1.status = null;
  assert.equal(evaluate(api, 'rest', 'Blastoise', 'Arcanine', 'insomnia', '', '50/200').score, -100);
  for (const terrain of ['electric', 'misty']) {
    api.fieldState.terrain = terrain;
    assert.equal(evaluate(api, 'rest', 'Blastoise', 'Arcanine', 'torrent', '', '50/200').score, -100);
    assert.ok(evaluate(api, 'rest', 'Charizard', 'Arcanine', 'blaze', '', '50/200').score > 0);
  }
});

test('ねごとは睡眠時だけ、呼び出せる技と失敗する呼び出しの平均で評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Arcanine';
  const request = moveRequest(combatant('Blastoise', 'torrent'), ['sleeptalk', 'surf']);
  const score = (id) => api.evaluateMove({ id }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, 'p1', 'p2');
  const surf = score('surf');
  assert.equal(score('sleeptalk').score, -100);
  api.battleState.p1.status = 'slp'; request.side.pokemon[0].condition = '200/200 slp';
  assert.equal(score('sleeptalk').score, surf.score);
  request.side.pokemon[0].moves.push('rest');
  assert.equal(score('sleeptalk').score, surf.score / 2);
  api.battleState.p1.statusAge = 3;
  assert.equal(score('sleeptalk').score, 0);
  api.battleState.p1.statusAge = 0;
  request.side.pokemon[0].moves = ['sleeptalk', 'solarbeam'];
  assert.equal(score('sleeptalk').score, -100);
  assert.equal(score('sleeptalk').maxDamagePercent, 0);
});

for (const id of ['fakeout', 'firstimpression']) {
  test(`${id}: 登場後の行動・行動不能・再登場を区別する`, () => {
    const api = loadLogic();
    api.updateBattleState('|switch|p1a: 親|Kangaskhan, L50|200/200\n|turn|1');
    assert.ok(evaluate(api, id, 'Kangaskhan', 'Blastoise').score > 0);
    api.updateBattleState('|move|p1a: 親|Tackle|p2a: カメ\n|turn|2');
    assert.equal(evaluate(api, id, 'Kangaskhan', 'Blastoise').score, -100);
    assert.equal(executeEngineMove(api, id, combatant('Kangaskhan'), combatant('Blastoise'), { actions: 2 }).damage, 0);
    api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|200/200\n|switch|p1a: 親|Kangaskhan, L50|200/200\n|cant|p1a: 親|par\n|turn|3');
    assert.equal(evaluate(api, id, 'Kangaskhan', 'Blastoise').score, -100);
    api.updateBattleState('|switch|p1a: 親|Kangaskhan, L50|200/200');
    assert.ok(evaluate(api, id, 'Kangaskhan', 'Blastoise').score > 0);
  });
}

for (const player of ['p1', 'p2']) {
  test(`${player}: 選出が3匹判明した後は未選出を交代候補から除く`, () => {
    const api = loadLogic();
    api.battleState[player].previewSpecies = ['Charizard', 'Blastoise', 'Venusaur', 'Gengar', 'Arcanine', 'Steelix'];
    const show = (name) => api.updateBattleState(`|switch|${player}a: ニック|${name}, L50|200/200`);
    show('Charizard'); show('Blastoise');
    assert.ok(api.benchSpeciesNames(player).includes('Steelix'));
    show('Venusaur');
    assert.deepEqual([...api.benchSpeciesNames(player)], ['Charizard', 'Blastoise']);
    assert.equal(api.resistSwitchIn(player, api.battleDex.moves.get('thunderbolt')), null);
    show('Charizard');
    api.updateBattleState(`|detailschange|${player}a: ニック|Charizard-Mega-X, L50\n|faint|${player}a: ニック`);
    show('Venusaur');
    assert.deepEqual([...api.benchSpeciesNames(player)], ['Blastoise']);
    assert.equal(api.battleState[player].selectedSpecies.size, 3);
    api.updateBattleState('|clearpoke');
    assert.equal(api.battleState[player].selectedSpecies.size, 0);
  });
}

test('いかさまダイスのトリプルアクセルは命中後3回、通常は途中で外れる', () => {
  const api = loadLogic();
  const attacker = { ...combatant('Weavile', 'pressure'), item: 'loadeddice' };
  const defender = { ...combatant('Blastoise'), condition: '2000/2000' };
  const result = damageFor(api, 'tripleaxel', attacker, defender);
  assert.equal(result.hitChance, 0.9);
  assert.equal(result.minDamagePercent, executeEngineMove(api, 'tripleaxel', attacker, defender).damage);
  assert.match(result.fieldReason, /連続3.0回/);
  attacker.item = '';
  const normal = damageFor(api, 'tripleaxel', attacker, defender);
  assert.ok(normal.score < result.score);
  assert.match(normal.fieldReason, /連続2.7回/);
  attacker.ability = 'noguard';
  assert.match(damageFor(api, 'tripleaxel', attacker, defender).fieldReason, /連続3.0回/);
});

test('いかさまダイスのネズミざんは4〜10回で、最小・最大がエンジンと一致する', () => {
  const api = loadLogic();
  const attacker = { ...combatant('Maushold', 'technician'), item: 'loadeddice' };
  const defender = { ...combatant('Blastoise'), condition: '2000/2000' };
  for (const ability of ['technician', 'skilllink']) {
    attacker.ability = ability;
    const result = damageFor(api, 'populationbomb', attacker, defender);
    assert.match(result.fieldReason, /連続7.0回/);
    assert.equal(result.minDamagePercent, executeEngineMove(api, 'populationbomb', attacker, defender, { diceRoll: 6 }).damage);
    assert.equal(result.maxDamagePercent, executeEngineMove(api, 'populationbomb', attacker, defender, { diceRoll: 0, roll: 0 }).damage);
  }
});

test('いかさまダイスの2〜5回技は4〜5回、スキルリンクなら5回になる', () => {
  const api = loadLogic();
  const attacker = { ...combatant('Cinccino', 'technician'), item: 'loadeddice' };
  const defender = { ...combatant('Blastoise'), condition: '2000/2000' };
  assert.match(damageFor(api, 'tailslap', attacker, defender).fieldReason, /連続4.5回/);
  attacker.ability = 'skilllink';
  const result = damageFor(api, 'tailslap', attacker, defender);
  assert.match(result.fieldReason, /連続5.0回/);
  assert.equal(result.minDamagePercent, executeEngineMove(api, 'tailslap', attacker, defender).damage);
});

for (const [species, ability, move] of [
  ['Vaporeon', 'waterabsorb', 'surf'], ['Arcanine', 'flashfire', 'flamethrower'],
  ['Jolteon', 'voltabsorb', 'thunderbolt'], ['Gengar', 'levitate', 'earthquake'],
  ['Azumarill', 'sapsipper', 'gigadrain'], ['Shedinja', 'wonderguard', 'surf'],
]) {
  test(`${ability}: 命中前の特性で無効化し、かたやぶりなら通る`, () => {
    const api = loadLogic();
    const attacker = combatant('Blastoise');
    const defender = combatant(species, ability);
    const immune = damageFor(api, move, attacker, defender);
    assert.equal(immune.immune, true);
    assert.equal(immune.score, 0);
    attacker.ability = 'moldbreaker';
    assert.ok(damageFor(api, move, attacker, defender).score > 0);
  });
}

test('相手の未公開特性を決めつけず、公開後だけ無効化する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise';
  api.battleState.p2.species = 'Vaporeon';
  assert.ok(evaluate(api, 'surf', 'Blastoise', 'Vaporeon').score > 0);
  api.updateBattleState('|-ability|p2a: シャワーズ|Water Absorb');
  assert.equal(evaluate(api, 'surf', 'Blastoise', 'Vaporeon').score, 0);
});

test('とくせいガードはかたやぶりから無効化特性を守る', () => {
  const api = loadLogic();
  assert.equal(damageFor(api, 'surf', combatant('Blastoise', 'moldbreaker'), { ...combatant('Vaporeon', 'waterabsorb'), item: 'abilityshield' }).immune, true);
});

test('控えはランク0、同じ種族の場のポケモンには公開ランクを適用する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise';
  api.battleState.p2.species = 'Arcanine';
  const defender = { ...combatant('Blastoise', 'torrent'), active: false };
  const incoming = () => api.estimateIncomingDamage(defender, 'Arcanine', 'crunch', api.createEmptyBoosts(), 'p1');
  const baseline = incoming();
  api.battleState.p1.boosts.def = 6;
  assert.deepEqual(range(incoming()), range(baseline));
  defender.active = true;
  assert.ok(incoming().maxDamagePercent < baseline.maxDamagePercent);
});

test('交代読みの別種族に、場のHP・状態異常・防御ランクを渡さない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise';
  api.battleState.p2.species = 'Arcanine';
  const estimate = () => api.estimateBattleDamage({
    move: api.battleDex.moves.get('surf'), attackerSpecies: api.battleDex.species.get('Blastoise'),
    defenderSpecies: api.battleDex.species.get('Steelix'), attackerPokemon: combatant('Blastoise'), defenderPlayer: 'p2',
  });
  const before = estimate();
  api.battleState.p2.boosts.spd = 6;
  api.battleState.p2.hpPercent = 10;
  api.battleState.p2.status = 'brn';
  assert.deepEqual(estimate(), before);
});

test('がんじょう: 満タンの単発だけ耐え、連続技・削れたHP・かたやぶりを区別する', () => {
  const api = loadLogic();
  const attacker = { ...combatant('Blastoise', 'torrent'), stats: { atk: 300, def: 120, spa: 300, spd: 125, spe: 100 } };
  const defender = { ...combatant('Steelix', 'sturdy'), condition: '150/150' };
  const single = damageFor(api, 'surf', attacker, defender, { weather: 'rain' });
  assert.ok(single.minDamagePercent > 0 && single.maxDamagePercent < 100);
  // 完全な実ダメージ処理とも照合する。
  const session = api.createDamageBattle(api.knownCombatant(attacker), api.knownCombatant(defender), 'p2');
  try {
    const move = api.prepareDamageMove(session.calc, session.attacker, session.defender, api.battleDex.moves.get('surf'));
    session.calc.damage(1000, session.defender, session.attacker, move);
    assert.equal(session.defender.hp, 1);
  } finally { session.calc.destroy(); }
  assert.ok(damageFor(api, 'surgingstrikes', attacker, defender).minDamagePercent >= 100);
  defender.condition = '149/150';
  assert.ok(damageFor(api, 'surf', attacker, defender).minDamagePercent >= 100);
  defender.condition = '150/150';
  attacker.ability = 'moldbreaker';
  assert.ok(damageFor(api, 'surf', attacker, defender).minDamagePercent >= 100);
});

test('持ち物の公開・交代・消費・交換・メガフォルムを記憶する', () => {
  const api = loadLogic();
  const log = (s) => api.updateBattleState(s);
  log('|switch|p2a: イヌ|Arcanine, L50|200/200\n|-item|p2a: イヌ|Choice Scarf');
  log('|switch|p2a: カメ|Blastoise, L50|200/200');
  assert.equal(api.revealedItemFor('p2', 'Arcanine'), 'choicescarf');
  log('|switch|p2a: イヌ|Arcanine, L50|200/200');
  assert.equal(api.getPublicSpeedModifiers('p2').scarf, true);
  log('|-enditem|p2a: イヌ|Choice Scarf\n|-item|p2a: イヌ|Leftovers');
  log('|switch|p2a: カメ|Blastoise, L50|200/200\n|switch|p2a: イヌ|Arcanine, L50|200/200');
  assert.equal(api.battleState.p2.item, 'leftovers');
  log('|-enditem|p2a: イヌ|Leftovers\n|switch|p2a: カメ|Blastoise, L50|200/200\n|switch|p2a: イヌ|Arcanine, L50|200/200');
  assert.equal(api.battleState.p2.item, null);
  log('|switch|p2a: リザ|Charizard, L50|200/200\n|-item|p2a: リザ|Charizardite X\n|move|p2a: リザ|Flamethrower|p1a: カメ\n|detailschange|p2a: リザ|Charizard-Mega-X, L50');
  assert.equal(api.battleState.p2.species, 'Charizard-Mega-X');
  assert.equal(api.battleState.p2.ability, 'toughclaws');
  assert.equal(api.revealedItemFor('p2', 'Charizard-Mega-X'), 'charizarditex');
  assert.ok(api.battleState.p2.revealedMoves['Charizard-Mega-X'].has('flamethrower'));
});

test('こおり解除技は行動でき、通常技は25%、ねむりは公開経過で評価する', () => {
  const api = loadLogic();
  const normal = evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent');
  api.battleState.p1.status = 'frz';
  const frozen = evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent', '', '200/200 frz');
  assert.ok(Math.abs(frozen.score - normal.score * 0.25) < 1e-8);
  const scald = evaluate(api, 'scald', 'Blastoise', 'Arcanine', 'torrent', '', '200/200 frz');
  assert.ok(scald.score > frozen.score);
  assert.match(scald.reason, /こおり解除/);
  api.battleState.p1.status = 'slp';
  api.battleState.p1.statusAge = 0;
  assert.equal(evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent').score, 0);
  api.battleState.p1.statusAge = 2;
  assert.equal(evaluate(api, 'surf', 'Blastoise', 'Arcanine', 'torrent').score, normal.score);
});

test('吸収回復は自分の空きHPと相手の残りHPを上限にする', () => {
  const api = loadLogic();
  const attacker = combatant('Venusaur', 'overgrow');
  const defender = combatant('Blastoise', 'torrent');
  assert.equal(damageFor(api, 'gigadrain', attacker, defender).recoilPercent, 0);
  attacker.condition = '199/200';
  assert.equal(damageFor(api, 'gigadrain', attacker, defender).recoilPercent, -0.5);
  attacker.condition = '100/200';
  defender.condition = '2/200';
  assert.equal(damageFor(api, 'gigadrain', attacker, defender).recoilPercent, -0.5);
  defender.ability = 'liquidooze';
  attacker.condition = '200/200';
  assert.equal(damageFor(api, 'gigadrain', attacker, defender).recoilPercent, 0.5);
  attacker.ability = 'magicguard';
  assert.equal(damageFor(api, 'gigadrain', attacker, defender).recoilPercent, 0);
});

test('反動は相手の残りHPを超えた理論ダメージから計算しない', () => {
  const api = loadLogic();
  const result = damageFor(api, 'flareblitz', combatant('Arcanine'), { ...combatant('Venusaur'), condition: '3/200' });
  assert.equal(result.recoilPercent, 0.5);
});

test('半減実は連続技の最初の一撃で消費し、実際の技実行と一致する', () => {
  const api = loadLogic();
  const attacker = combatant('Machamp');
  const defender = { ...combatant('Steelix'), item: 'chopleberry' };
  const result = damageFor(api, 'doublekick', attacker, defender);
  const session = api.createDamageBattle(api.knownCombatant(attacker), api.knownCombatant(defender), 'p2');
  try {
    session.calc.random = (n = 2) => n === 16 ? 15 : 0;
    session.calc.randomChance = (numerator, denominator) => numerator >= denominator;
    session.calc.actions.useMove('doublekick', session.attacker, session.defender);
    assert.equal(session.defender.item, '');
    assert.equal(result.minDamagePercent, (session.defender.maxhp - session.defender.hp) / session.defender.maxhp * 100);
  } finally { session.calc.destroy(); }
});

test('みがわりの再使用とHP不足は失敗評価にする', () => {
  const api = loadLogic();
  assert.ok(evaluate(api, 'substitute', 'Venusaur', 'Blastoise').score > 0);
  api.battleState.p1.volatiles.substitute = true;
  assert.equal(evaluate(api, 'substitute', 'Venusaur', 'Blastoise').score, -100);
  api.battleState.p1.volatiles.substitute = false;
  assert.ok(evaluate(api, 'substitute', 'Venusaur', 'Blastoise', '', '', '50/200').score < 0);
});

test('一撃必殺は命中30%で評価し、必中時以外は確定KOにしない', () => {
  const api = loadLogic();
  const attacker = combatant('Machamp');
  const defender = combatant('Blastoise');
  const result = damageFor(api, 'fissure', attacker, defender);
  assert.equal(result.score, 30);
  assert.equal(result.hitChance, 0.3);
  assert.equal(result.minDamagePercent, 0);
  assert.equal(result.maxDamagePercent, 100);
  attacker.ability = 'noguard';
  const certain = damageFor(api, 'fissure', attacker, defender);
  assert.equal(certain.score, 100);
  assert.equal(certain.minDamagePercent, 100);
  assert.equal(certain.critChance, 0);
});

test('一撃必殺のタイプ・レベル・がんじょうとぜったいれいどの命中率を区別する', () => {
  const api = loadLogic();
  const attacker = combatant('Blastoise');
  assert.equal(damageFor(api, 'fissure', attacker, combatant('Charizard')).immune, true);
  assert.equal(damageFor(api, 'fissure', attacker, combatant('Steelix', 'sturdy')).immune, true);
  assert.equal(damageFor(api, 'sheercold', attacker, combatant('Lapras')).immune, true);
  assert.equal(damageFor(api, 'sheercold', attacker, combatant('Arcanine')).hitChance, 0.2);
  assert.equal(damageFor(api, 'sheercold', combatant('Lapras'), combatant('Arcanine')).hitChance, 0.3);
  assert.equal(damageFor(api, 'fissure', attacker, { ...combatant('Arcanine'), details: 'Arcanine, L51' }).immune, true);
  attacker.ability = 'moldbreaker';
  assert.ok(damageFor(api, 'fissure', attacker, combatant('Steelix', 'sturdy')).score > 0);
  assert.ok(api.getLearnedDamagingMoveIds('Glalie').includes('sheercold'));
});

for (const player of ['p1', 'p2']) {
  test(`${player}: メガシンカ後の能力・特性・タイプで評価し合法なmega行動を選ぶ`, () => {
    const api = loadLogic();
    const opponent = player === 'p1' ? 'p2' : 'p1';
    api.battleState[player].species = 'Charizard';
    api.battleState[opponent].species = 'Venusaur';
    const request = moveRequest({ ...combatant('Charizard', 'blaze'), item: 'charizarditex' }, ['flareblitz']);
    request.active[0].canMegaEvo = true;
    const projected = api.projectMegaRequest(player, request);
    assert.equal(projected.species, 'Charizard-Mega-X');
    assert.equal(projected.ability, 'toughclaws');
    assert.deepEqual([...api.battleDex.species.get(projected.species).types], ['Fire', 'Dragon']);
    assert.ok(projected.request.side.pokemon[0].stats.atk > request.side.pokemon[0].stats.atk);
    assert.match(api.chooseAction(player, request), /^move 1 mega$/);
    assert.equal(api.battleState[player].species, 'Charizard');
    assert.equal(request.side.pokemon[0].ability, 'blaze');
    request.active[0].canMegaEvo = false;
    assert.equal(api.chooseAction(player, request), 'move 1');
  });
}

test('メガリザードンYのひでりを予測に使い、公開前に天候を確定させない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Charizard';
  api.battleState.p2.species = 'Venusaur';
  const request = moveRequest({ ...combatant('Charizard', 'blaze'), item: 'charizarditey' }, ['flamethrower']);
  request.active[0].canMegaEvo = true;
  const projected = api.projectMegaRequest('p1', request);
  assert.equal(projected.weather, 'sun');
  assert.equal(api.chooseAction('p1', request), 'move 1 mega');
  assert.equal(api.fieldState.weather, null);
  assert.equal(api.battleState.p1.ability, null);
});

test('もうかの通常攻撃が強い場合はメガシンカを保留する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Charizard';
  api.battleState.p1.hpPercent = 25;
  api.battleState.p2.species = 'Venusaur';
  const request = moveRequest({ ...combatant('Charizard', 'blaze'), condition: '50/200', stats: { atk: 93, def: 98, spa: 161, spd: 105, spe: 167 }, item: 'charizarditex' }, ['flamethrower']);
  request.active[0].canMegaEvo = true;
  assert.equal(api.chooseAction('p1', request), 'move 1');
});

test('メガシンカを含む合法チームで、AIの全行動が受理され終局まで進む', (t) => {
  const api = loadLogic();
  for (const [team, item, move] of [[api.teamA, 'charizarditey', 'flamethrower'], [api.teamB, 'charizarditex', 'dragonclaw']]) {
    const charizard = team.find((set) => api.battleDex.species.get(set.species).id === 'charizard');
    charizard.item = item;
    charizard.moves = [move];
    assert.equal(api.validator.validateTeam(team), null);
  }
  const publicLog = [];
  const battle = new api.Battle({
    formatid: api.FORMAT, seed: [17, 29, 41, 53],
    send(type, data) {
      if (type !== 'update') return;
      const lines = Array.isArray(data) ? data : data.split('\n');
      const shared = [];
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].startsWith('|split|')) { index++; continue; }
        shared.push(lines[index]);
      }
      publicLog.push(...shared);
      api.updateBattleState(shared.join('\n'));
    },
  });
  api.stream.battle = battle;
  let choices = 0;
  let megaChoices = 0;
  try {
    battle.setPlayer('p1', { name: 'Mega-Y', team: api.Teams.pack(api.teamA) });
    battle.setPlayer('p2', { name: 'Mega-X', team: api.Teams.pack(api.teamB) });
    battle.sendUpdates();
    for (const [player, team] of [['p1', api.teamA], ['p2', api.teamB]]) {
      const order = ['charizard', 'blastoise', 'venusaur'].map((id) => team.findIndex((set) => api.battleDex.species.get(set.species).id === id) + 1).join('');
      assert.equal(battle.choose(player, `team ${order}`), true);
    }
    battle.sendUpdates();
    for (let step = 0; step < 200 && !battle.ended; step++) {
      const pending = battle.sides.map((side) => ({ player: side.id, request: side.activeRequest }));
      for (const { player, request } of pending) {
        if (!request || request.wait) continue;
        api.latestRequests[player] = request;
        const action = api.chooseAction(player, request);
        assert.ok(action, `${player}: 有効なrequestに行動がない`);
        if (action.endsWith(' mega')) megaChoices++;
        assert.equal(battle.choose(player, action), true, `${player}: ${action}`);
        choices++;
      }
      battle.sendUpdates();
    }
    assert.equal(battle.ended, true, '200回の行動受付以内に終局する');
    assert.ok(megaChoices >= 1);
    assert.ok(publicLog.some((line) => line.startsWith('|detailschange|') && line.includes('Mega')));
    assert.ok(publicLog.some((line) => line.startsWith('|-mega|')));
    assert.ok(publicLog.some((line) => /\|sunnyday\|/i.test(line)));
    assert.ok(!publicLog.some((line) => /NaN|Invalid choice|\|error\|/.test(line)));
    t.diagnostic(`${battle.turn}ターン、${choices}行動、メガシンカ${megaChoices}回、勝者${battle.winner}`);
  } finally {
    api.stream.battle = null;
    battle.destroy();
  }
});

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

test('でんじはは地面・電気に無効で、どくどくはふしょくなら毒・鋼にも通る', () => {
  const api = loadLogic();
  for (const foe of ['Garchomp', 'Raichu']) {
    assert.equal(evaluate(api, 'thunderwave', 'Raichu', foe).score, -100);
    assert.equal(executeEngineMove(api, 'thunderwave', combatant('Raichu'), combatant(foe)).foeStatus, '');
  }
  assert.ok(evaluate(api, 'thunderwave', 'Raichu', 'Blastoise').score > 0);
  for (const foe of ['Venusaur', 'Steelix']) {
    assert.equal(evaluate(api, 'toxic', 'Salazzle', foe).score, -100);
    assert.ok(evaluate(api, 'toxic', 'Salazzle', foe, 'corrosion').score > 0);
    assert.equal(executeEngineMove(api, 'toxic', combatant('Salazzle', 'corrosion'), combatant(foe)).foeStatus, 'tox');
  }
});

test('変化技の反射・無効は公開特性、かたやぶり、とくせいガードを区別する', () => {
  const api = loadLogic();
  for (const [foe, ability] of [['Espeon', 'magicbounce'], ['Gholdengo', 'goodasgold']]) {
    api.battleState.p2.ability = null;
    assert.ok(evaluate(api, 'taunt', 'Haxorus', foe).score > 0, '未公開特性を決めつけない');
    api.battleState.p2.ability = ability;
    assert.equal(evaluate(api, 'taunt', 'Haxorus', foe).score, -100);
    assert.ok(!executeEngineMove(api, 'taunt', combatant('Haxorus'), combatant(foe, ability)).foeVolatiles.includes('taunt'));
    assert.ok(evaluate(api, 'taunt', 'Haxorus', foe, 'moldbreaker').score > 0);
    assert.ok(executeEngineMove(api, 'taunt', combatant('Haxorus', 'moldbreaker'), combatant(foe, ability)).foeVolatiles.includes('taunt'));
    api.battleState.p2.item = 'abilityshield';
    assert.equal(evaluate(api, 'taunt', 'Haxorus', foe, 'moldbreaker').score, -100);
    api.battleState.p2.item = null;
    const own = { ...combatant('Haxorus'), active: true, moves: ['dragonclaw', 'swordsdance'] };
    const self = api.evaluateMove({ id: 'swordsdance' }, 'Haxorus', foe, null, null, {}, {},
      moveRequest(own, own.moves), 'p1', 'p2');
    assert.equal(self.ownBoosts.atk, 2, '自分対象は反射されない');
  }
});

test('粉技のタイプ無効と状態異常を防ぐフィールドをエンジンで確認する', () => {
  const api = loadLogic();
  assert.equal(evaluate(api, 'sleeppowder', 'Venusaur', 'Venusaur').score, -100);
  assert.ok(evaluate(api, 'sleeppowder', 'Venusaur', 'Blastoise').score > 0);
  api.fieldState.terrain = 'misty';
  assert.equal(evaluate(api, 'willowisp', 'Gengar', 'Blastoise').score, -100);
  assert.ok(evaluate(api, 'willowisp', 'Gengar', 'Aerodactyl').score > 0);
});

for (const [id, own, foe] of [
  ['scald', 'Blastoise', 'Arcanine'], ['thunderbolt', 'Raichu', 'Raichu'],
  ['icebeam', 'Blastoise', 'Glaceon'], ['sludgebomb', 'Gengar', 'Venusaur'],
]) {
  test(`${id}: タイプで無効な追加状態異常には加点しない`, () => {
    const api = loadLogic();
    api.battleState.p1.species = own; api.battleState.p2.species = foe;
    const added = api.addedEffectScore(api.battleDex.moves.get(id), combatant(own), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', foe);
    assert.equal(added.score, 0);
    assert.equal(added.reason, null);
    assert.equal(executeEngineMove(api, id, combatant(own), combatant(foe)).foeStatus, '');
    api.battleState.p2.species = 'Snorlax';
    const allowed = api.addedEffectScore(api.battleDex.moves.get(id), combatant(own), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Snorlax');
    assert.ok(allowed.score > 0);
    assert.notEqual(executeEngineMove(api, id, combatant(own), combatant('Snorlax')).foeStatus, '');
  });
}

test('追加効果はりんぷん・おんみつマントを反映し、自分の追加上昇は残す', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Snorlax';
  const added = (id, ability = '') => api.addedEffectScore(api.battleDex.moves.get(id), combatant('Blastoise', ability), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Snorlax');
  assert.ok(added('scald').score > 0);
  api.battleState.p2.item = 'covertcloak';
  assert.equal(added('scald').score, 0);
  assert.equal(executeEngineMove(api, 'scald', combatant('Blastoise'), { ...combatant('Snorlax'), item: 'covertcloak' }).foeStatus, '');
  assert.ok(added('poweruppunch').selfScore > 0);
  assert.equal(added('nuzzle').score, 0, '100%の追加効果もおんみつマントで防がれる');
  assert.equal(executeEngineMove(api, 'nuzzle', combatant('Blastoise'), { ...combatant('Snorlax'), item: 'covertcloak' }).foeStatus, '');
  api.battleState.p2.item = null; api.battleState.p2.ability = 'shielddust';
  assert.equal(added('scald').score, 0);
  assert.ok(added('scald', 'moldbreaker').score > 0);
  api.battleState.p2.ability = 'goodasgold';
  assert.ok(added('scald').score > 0, 'おうごんのからだは攻撃の追加やけどを防がない');
});

test('ひるみ無効特性と、追加状態異常のフィールド無効を反映する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Charizard'; api.battleState.p2.species = 'Snorlax';
  const added = (id, ability = '') => api.addedEffectScore(api.battleDex.moves.get(id), combatant('Charizard', ability), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Snorlax');
  assert.ok(added('airslash').score > 0);
  api.battleState.p2.ability = 'innerfocus';
  assert.equal(added('airslash').score, 0);
  assert.ok(added('airslash', 'moldbreaker').score > 0);
  api.battleState.p2.ability = null; api.fieldState.terrain = 'misty';
  assert.equal(added('scald').score, 0);
  api.battleState.p2.species = 'Aerodactyl';
  assert.ok(api.addedEffectScore(api.battleDex.moves.get('scald'), combatant('Charizard'), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Aerodactyl').score > 0);
});

test('てんのめぐみの追加効果確率を二重補正しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Togekiss'; api.battleState.p2.species = 'Snorlax';
  const added = (ability) => api.addedEffectScore(api.battleDex.moves.get('airslash'), combatant('Togekiss', ability), null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Snorlax');
  assert.equal(added('serenegrace').score, Math.min(24, added('').score * 2));
});

for (const id of ['synthesis', 'morningsun', 'moonlight', 'shoreup']) {
  test(`${id}: 天候・回復上限・満タン時を実際の回復量で評価する`, () => {
    const api = loadLogic();
    for (const weather of [null, 'sun', 'rain', 'sand', 'snow']) {
      api.fieldState.weather = weather;
      const engineWeather = { sun: 'sunnyday', rain: 'raindance', sand: 'sandstorm', snow: 'snowscape' }[weather];
      for (const hp of [25, 180, 200]) {
        const condition = `${hp}/200`;
        const ai = evaluate(api, id, 'Venusaur', 'Blastoise', 'overgrow', '', condition);
        const engine = executeEngineMove(api, id, { ...combatant('Venusaur', 'overgrow'), condition }, combatant('Blastoise'), { self: true, weather: engineWeather });
        if (engine.healed > 0) assert.equal(ai.score, engine.healed / 200 * 100 * 0.8);
        else assert.equal(ai.score, -100);
      }
    }
  });
}

test('通常の回復技もHP95%以上の実回復量と、天候を無効にする特性を反映する', () => {
  const api = loadLogic();
  assert.equal(evaluate(api, 'recover', 'Alakazam', 'Blastoise', '', '', '190/200').score, 4);
  assert.equal(evaluate(api, 'synthesis', 'Venusaur', 'Blastoise', 'dryskin', '', '50/200').score, 40);
  api.battleState.p2.ability = 'cloudnine'; api.fieldState.weather = 'sun';
  assert.equal(evaluate(api, 'synthesis', 'Venusaur', 'Blastoise', '', '', '50/200').score, 40);
});

test('相手側への設置技もマジックミラーで反射され、みがわりでは防がれない', () => {
  const api = loadLogic();
  api.battleState.p2.previewSpecies = ['Espeon', 'Arcanine', 'Charizard'];
  api.battleState.p2.volatiles.substitute = true;
  assert.ok(evaluate(api, 'stealthrock', 'Haxorus', 'Espeon').score > 0);
  api.battleState.p2.ability = 'magicbounce';
  assert.equal(evaluate(api, 'stealthrock', 'Haxorus', 'Espeon').score, -100);
  assert.ok(evaluate(api, 'stealthrock', 'Haxorus', 'Espeon', 'moldbreaker').score > 0);
});

test('公開されたかいふくふうじとでんじふゆうを回復・状態異常に反映する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Venusaur';
  api.battleState.p1.volatiles.healblock = true;
  assert.equal(evaluate(api, 'synthesis', 'Venusaur', 'Blastoise', '', '', '50/200').score, -100);
  api.battleState.p2.magnetRise = true; api.fieldState.terrain = 'misty';
  assert.ok(evaluate(api, 'willowisp', 'Venusaur', 'Blastoise').score > 0);
  api.battleState.p2.smackDown = true;
  assert.equal(evaluate(api, 'willowisp', 'Venusaur', 'Blastoise').score, -100);
});

test('いたみわけはHP実数の平均・端数切捨て・双方の回復上限を評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Gengar'; api.battleState.p2.species = 'Pikachu';
  for (const [condition, foePercent] of [['200/400', 100], ['1/200', 100], ['200/200', 1]]) {
    api.battleState.p2.hpPercent = foePercent;
    const pokemon = { ...combatant('Gengar'), active: true, condition };
    const actual = api.evaluatePainSplit(pokemon, 'Pikachu', api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2');
    const expected = ['min', 'max'].map((endpoint) => {
      const s = api.createPublicMoveSession(pokemon, 'Pikachu', api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', endpoint);
      try {
        const average = Math.floor((s.attacker.hp + s.defender.hp) / 2);
        return { own: (Math.min(s.attacker.maxhp, average) - s.attacker.hp) / s.attacker.maxhp * 100, foe: (s.defender.hp - Math.min(s.defender.maxhp, average)) / s.defender.maxhp * 100 };
      } finally { s.calc.destroy(); }
    });
    assert.equal(actual.ownHpChangePercent, (expected[0].own + expected[1].own) / 2);
    assert.equal(actual.opponentHpRemovedPercent, (expected[0].foe + expected[1].foe) / 2);
    assert.equal(actual.score, actual.ownHpChangePercent * 0.8 + actual.opponentHpRemovedPercent * 0.6);
    if (condition === '200/400') assert.ok(actual.score < 0, '自分が50%、相手が100%でも実数次第で自分が減る');
  }
});

test('いたみわけは相手の非公開最大HPを読まず、みがわりには失敗する', () => {
  const api = loadLogic();
  const own = combatant('Gengar');
  const s = api.createDamageBattle(api.knownCombatant(own), api.knownCombatant(combatant('Pikachu')), 'p2');
  try {
    api.stream.battle = s.calc;
    const first = evaluate(api, 'painsplit', 'Gengar', 'Pikachu', '', '', '50/200');
    s.calc.sides[1].active[0].maxhp = 9999;
    s.calc.sides[1].active[0].hp = 9999;
    const second = evaluate(api, 'painsplit', 'Gengar', 'Pikachu', '', '', '50/200');
    assert.equal(first.score, second.score);
    api.battleState.p2.volatiles.substitute = true;
    assert.equal(evaluate(api, 'painsplit', 'Gengar', 'Pikachu', '', '', '50/200').score, -100);
  } finally { api.stream.battle = null; s.calc.destroy(); }
});

for (const player of ['p1', 'p2']) {
  test(`${player}: ねむる後の2行動は眠り、3行動目に起きる。ねごとも同じ確率を使う`, () => {
    const api = loadLogic();
    const foe = player === 'p1' ? 'p2' : 'p1';
    api.battleState[foe].species = 'Arcanine';
    api.updateBattleState(`|switch|${player}a: カメ|Blastoise, L50|50/200\n|move|${player}a: カメ|Rest|${player}a: カメ\n|-status|${player}a: カメ|slp|[from] move: Rest`);
    const request = moveRequest({ ...combatant('Blastoise'), condition: '200/200 slp' }, ['surf', 'sleeptalk']);
    const score = (id) => api.evaluateMove({ id }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, player, foe);
    const session = api.createDamageBattle(api.knownCombatant({ ...combatant('Blastoise'), condition: '50/200' }), api.knownCombatant(combatant('Arcanine')), foe);
    try {
      session.calc.actions.useMove('rest', session.attacker, session.attacker);
      for (let age = 0; age <= 2; age++) {
        const engineCanMove = !!session.calc.runEvent('BeforeMove', session.attacker, session.defender, session.calc.dex.getActiveMove('surf'));
        assert.equal(api.sleepWakeChance(player), Number(engineCanMove));
        if (engineCanMove) { assert.ok(score('surf').score > 0); assert.equal(score('sleeptalk').score, 0); }
        else { assert.equal(score('surf').score, 0); assert.equal(score('surf').maxDamagePercent, 0); assert.ok(score('sleeptalk').score > 0); }
        if (age < 2) api.updateBattleState(`|cant|${player}a: カメ|slp\n|move|${player}a: カメ|Sleep Talk|${player}a: カメ`);
      }
    } finally { session.calc.destroy(); }
  });
}

test('ねむるの履歴は交代後も種族ごとに保持し、治癒・通常の眠りで解除する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|50/200\n|-status|p1a: カメ|slp|[from] move: Rest\n|cant|p1a: カメ|slp');
  api.updateBattleState('|switch|p1a: 鳥|Charizard, L50|200/200 slp');
  assert.equal(api.battleState.p1.sleepSource, null);
  assert.equal(api.battleState.p1.statusAge, 0);
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|200/200 slp');
  assert.equal(api.battleState.p1.statusAge, 1);
  assert.equal(api.sleepWakeChance('p1'), 0);
  api.updateBattleState('|cant|p1a: カメ|slp');
  assert.equal(api.sleepWakeChance('p1'), 1);
  api.updateBattleState('|-curestatus|p1a: カメ|slp\n|-status|p1a: カメ|slp|[from] move: Sleep Powder\n|cant|p1a: カメ|slp');
  assert.equal(api.battleState.p1.sleepSource, null);
  assert.ok(Math.abs(api.sleepWakeChance('p1') - 1 / 3) < 1e-12);
  api.updateBattleState('|clearpoke');
  assert.equal(Object.keys(api.battleState.p1.sleepHistory).length, 0);
});

test('はやおきのねむるは1行動眠って起き、自分のrequestの特性も使用する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Kangaskhan'; api.battleState.p2.species = 'Arcanine';
  api.updateBattleState('|-status|p1a: 親|slp|[from] move: Rest');
  assert.equal(evaluate(api, 'surf', 'Kangaskhan', 'Arcanine', 'earlybird', '', '200/200 slp').score, 0);
  api.updateBattleState('|cant|p1a: 親|slp');
  assert.ok(evaluate(api, 'surf', 'Kangaskhan', 'Arcanine', 'earlybird', '', '200/200 slp').score > 0);
  assert.equal(api.battleState.p1.ability, null, '自分の特性が公開されていなくてもrequestから判断する');
  const session = api.createDamageBattle(api.knownCombatant({ ...combatant('Kangaskhan', 'earlybird'), condition: '50/200' }), api.knownCombatant(combatant('Arcanine')), 'p2');
  try {
    session.calc.actions.useMove('rest', session.attacker, session.attacker);
    assert.equal(!!session.calc.runEvent('BeforeMove', session.attacker, session.defender, session.calc.dex.getActiveMove('surf')), false);
    assert.equal(!!session.calc.runEvent('BeforeMove', session.attacker, session.defender, session.calc.dex.getActiveMove('surf')), true);
  } finally { session.calc.destroy(); }
});

function engineConditionalMove(api, id, own, foe, response, roll = 15, options = {}) {
  const s = api.createDamageBattle(api.knownCombatant(own, options.boosts), api.knownCombatant(foe), 'p2');
  try {
    s.calc.randomChance = (n, d) => d === 100 || n >= d;
    s.calc.random = (n = 2) => n === 16 ? roll : n === 100 ? 99 : 0;
    if (options.substitute) s.attacker.addVolatile('substitute');
    const before = s.defender.hp;
    if (id === 'suckerpunch') {
      s.calc.queue.push({ choice: 'move', pokemon: s.defender, move: s.calc.dex.getActiveMove(response) });
    } else {
      s.attacker.addVolatile(id);
      s.calc.queue.push({ choice: 'move', pokemon: s.attacker, move: s.calc.dex.getActiveMove(id) });
      s.calc.actions.useMove(response, s.defender, s.attacker);
    }
    if (s.attacker.hp > 0) s.calc.actions.useMove(id, s.attacker, s.defender);
    return { damage: (before - s.defender.hp) / s.defender.maxhp * 100, alive: s.attacker.hp > 0 };
  } finally { s.calc.destroy(); }
}

for (const player of ['p1', 'p2']) {
  test(`${player}: ふいうちは公開された変化技ロックでは失敗し、攻撃ロックなら通る`, () => {
    const api = loadLogic();
    const foe = player === 'p1' ? 'p2' : 'p1';
    api.battleState[player].species = 'Absol'; api.battleState[foe].species = 'Venusaur';
    const pokemon = { ...combatant('Absol'), active: true };
    const score = () => api.evaluateMove({ id: 'suckerpunch' }, 'Absol', 'Venusaur', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), { side: { pokemon: [pokemon] } }, player, foe);
    api.battleState[foe].volatiles = { encore: true, encoreMove: 'swordsdance' };
    assert.equal(score().score, 0); assert.equal(score().maxDamagePercent, 0);
    assert.equal(engineConditionalMove(api, 'suckerpunch', pokemon, combatant('Venusaur'), 'swordsdance').damage, 0);
    api.battleState[foe].volatiles.encoreMove = 'tackle';
    assert.ok(score().score > 0);
    assert.ok(engineConditionalMove(api, 'suckerpunch', pokemon, combatant('Venusaur'), 'tackle').damage > 0);
    api.battleState[foe].volatiles = {}; api.battleState[foe].item = 'choiceband'; api.battleState[foe].lastMove = 'swordsdance';
    assert.equal(score().score, 0);
    api.battleState[foe].lastMove = 'tackle'; assert.ok(score().score > 0);
    api.battleState[foe].volatiles.mustrecharge = true; assert.equal(score().score, 0);
  });
}

test('ふいうちの未公開枠は成功を確定せず、公開情報に応じて成功見込みを変える', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Absol'; api.battleState.p2.species = 'Venusaur';
  const own = combatant('Absol'), foe = combatant('Venusaur');
  const guaranteed = damageFor(api, 'suckerpunch', own, foe, { responseMove: 'tackle' });
  const unknown = damageFor(api, 'suckerpunch', own, foe);
  assert.equal(unknown.conditionalChance, 0.5);
  assert.equal(unknown.score, guaranteed.score * 0.5);
  assert.equal(unknown.minDamagePercent, 0);
  assert.equal(unknown.hitChance, 0.5);
  api.battleState.p2.revealedMoves.Venusaur = new Set(['swordsdance', 'protect', 'leechseed', 'synthesis']);
  assert.equal(damageFor(api, 'suckerpunch', own, foe).score, 0);
  api.battleState.p2.revealedMoves.Venusaur = new Set(['tackle', 'gigadrain', 'sludgebomb', 'vinewhip']);
  assert.equal(damageFor(api, 'suckerpunch', own, foe).score, guaranteed.score);
});

test('ふいうちは相手が先に動く先制攻撃には失敗する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Absol'; api.battleState.p2.species = 'Raichu';
  const own = { ...combatant('Absol'), stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 50 } };
  const foe = { ...combatant('Raichu'), stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 200 } };
  assert.equal(damageFor(api, 'suckerpunch', own, foe, { responseMove: 'quickattack' }).score, 0);
  assert.equal(damageFor(api, 'suckerpunch', own, foe, { responseMove: 'extremespeed' }).score, 0);
  assert.ok(damageFor(api, 'suckerpunch', own, foe, { responseMove: 'tackle' }).score > 0);
  api.fieldState.trickRoom = true;
  assert.ok(damageFor(api, 'suckerpunch', own, foe, { responseMove: 'quickattack' }).score > 0);
});

test('相手のふいうち・反撃技の危険度は、自分が選ぶ技に応じて変わる', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Absol';
  const own = { ...combatant('Blastoise'), moves: ['surf', 'raindance'], active: true };
  assert.equal(api.estimateIncomingDamage(own, 'Absol', 'suckerpunch', api.createEmptyBoosts(), 'p1', null, 'raindance').expectedDamagePercent, 0);
  assert.ok(api.estimateIncomingDamage(own, 'Absol', 'suckerpunch', api.createEmptyBoosts(), 'p1', null, 'surf').expectedDamagePercent > 0);
  const revealed = ['suckerpunch', 'swordsdance', 'protect', 'taunt'];
  assert.equal(api.evaluatePreMoveThreat('p1', own, { id: 'raindance' }, 'Absol', revealed, api.createEmptyBoosts(), api.createEmptyBoosts(), null, null).threat, null);
  api.battleState.p2.species = 'Wobbuffet';
  assert.equal(api.estimateIncomingDamage(own, 'Wobbuffet', 'counter', api.createEmptyBoosts(), 'p1', null, 'surf').expectedDamagePercent, 0);
  assert.ok(api.estimateIncomingDamage(own, 'Wobbuffet', 'mirrorcoat', api.createEmptyBoosts(), 'p1', null, 'surf').expectedDamagePercent > 0);
});

for (const [id, response, wrong] of [['counter', 'tackle', 'surf'], ['mirrorcoat', 'psychic', 'tackle']]) {
  test(`${id}: 同ターンの対応する被ダメージを倍返しし、別分類・変化技では失敗する`, () => {
    const api = loadLogic();
    api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Blastoise';
    const own = combatant('Wobbuffet'), foe = combatant('Blastoise');
    const ai = damageFor(api, id, own, foe, { responseMove: response });
    assert.ok(ai.score > 0);
    assert.equal(ai.hitChance, 1);
    assert.equal(ai.minDamagePercent, engineConditionalMove(api, id, own, foe, response, 15).damage);
    assert.equal(ai.maxDamagePercent, engineConditionalMove(api, id, own, foe, response, 0).damage);
    for (const move of [wrong, 'raindance']) {
      assert.equal(damageFor(api, id, own, foe, { responseMove: move }).score, 0);
      assert.equal(engineConditionalMove(api, id, own, foe, move).damage, 0);
    }
  });
}

test('反撃技は倒される前提では加点せず、きあいのタスキで生存すれば返せる', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Blastoise';
  const own = { ...combatant('Wobbuffet'), stats: { atk: 100, def: 1, spa: 100, spd: 125, spe: 50 } };
  const foe = { ...combatant('Blastoise'), stats: { atk: 500, def: 120, spa: 100, spd: 125, spe: 100 } };
  assert.equal(damageFor(api, 'counter', own, foe, { responseMove: 'tackle' }).score, 0);
  assert.equal(engineConditionalMove(api, 'counter', own, foe, 'tackle').alive, false);
  own.item = 'focussash';
  assert.ok(damageFor(api, 'counter', own, foe, { responseMove: 'tackle' }).score > 0);
  assert.ok(engineConditionalMove(api, 'counter', own, foe, 'tackle').damage > 0);
});

test('反撃技は最後の打撃・みがわり・返す技のタイプ無効もエンジンに合わせる', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Blastoise';
  const own = { ...combatant('Wobbuffet'), active: true }, foe = combatant('Blastoise');
  const multi = damageFor(api, 'counter', own, foe, { responseMove: 'doublekick' });
  assert.equal(multi.minDamagePercent, engineConditionalMove(api, 'counter', own, foe, 'doublekick', 15).damage);
  api.battleState.p1.volatiles.substitute = true;
  assert.equal(damageFor(api, 'counter', own, foe, { responseMove: 'tackle' }).score, 0);
  assert.equal(engineConditionalMove(api, 'counter', own, foe, 'tackle', 15, { substitute: true }).damage, 0);
  api.battleState.p1.volatiles = {}; api.battleState.p2.species = 'Gengar';
  assert.equal(damageFor(api, 'counter', own, combatant('Gengar'), { responseMove: 'tackle' }).score, 0);
});

test('反撃技は相手が外す可能性を加味し、未公開技の推定を確定KOにしない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Blastoise';
  const own = combatant('Wobbuffet'), foe = combatant('Blastoise');
  const miss = damageFor(api, 'counter', own, foe, { responseMove: 'megapunch' });
  assert.equal(miss.hitChance, 0.85);
  assert.ok(miss.score > 0);
  api.battleState.p2.revealedMoves.Blastoise = new Set(['tackle']);
  const guessed = damageFor(api, 'counter', own, foe);
  assert.ok(guessed.score > 0);
  assert.equal(guessed.minDamagePercent, 0);
  assert.ok(guessed.hitChance > 0 && guessed.hitChance < 1);
  assert.match(guessed.fieldReason, /推定/);
});

test('おやこあいでタスキを突破する攻撃にKO加点し、通常の単発では加点しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Kangaskhan-Mega'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.item = 'focussash';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['raindance', 'protect', 'recover', 'swordsdance']);
  api.battleState.p1.boosts.atk = 6;
  const own = { ...combatant('Kangaskhan-Mega', 'parentalbond'), stats: { atk: 194, def: 120, spa: 100, spd: 125, spe: 100 } };
  const request = moveRequest(own, ['doubleedge']);
  const score = () => {
    let result;
    api.chooseActionInternal('p1', request, (value) => { result = value; }, true);
    return result;
  };
  const evaluated = () => api.evaluateMove({ id: 'doubleedge' }, 'Kangaskhan-Mega', 'Blastoise', null, null, api.battleState.p1.boosts, api.createEmptyBoosts(), request, 'p1', 'p2');
  assert.ok(evaluated().minDamagePercent >= 100);
  assert.equal(score(), evaluated().score + 80);
  request.side.pokemon[0].ability = '';
  assert.ok(evaluated().maxDamagePercent < 100);
  assert.equal(score(), evaluated().score);
});

test('自分のタスキを突破する連続攻撃もKO危険として評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Machamp';
  const own = { ...combatant('Blastoise'), item: 'focussash', stats: { atk: 100, def: 1, spa: 100, spd: 125, spe: 10 } };
  const multi = api.evaluateIncomingRisk(own, 'Machamp', ['doublekick', 'protect', 'raindance', 'swordsdance'], api.createEmptyBoosts(), 'p1');
  assert.ok(multi.damage.minDamagePercent >= 100);
  assert.equal(multi.koRisk, '確定で倒れる危険');
  const single = api.evaluateIncomingRisk(own, 'Machamp', ['closecombat', 'protect', 'raindance', 'swordsdance'], api.createEmptyBoosts(), 'p1');
  assert.ok(single.damage.maxDamagePercent < 100);
  assert.equal(single.koRisk, null);
});

test('遅いねこだましもひるみを加点し、より高い優先度で相手が動いた後は加点しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Kangaskhan'; api.battleState.p2.species = 'Electrode';
  const own = { ...combatant('Kangaskhan'), stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 50 } };
  const added = () => api.addedEffectScore(api.battleDex.moves.get('fakeout'), own, null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Electrode');
  assert.equal(added().score, 24);
  assert.ok(executeEngineMove(api, 'fakeout', own, combatant('Electrode')).foeVolatiles.includes('flinch'));
  api.battleState.p2.volatiles = { encore: true, encoreMove: 'protect' };
  assert.equal(added().score, 0);
  api.battleState.p2.volatiles = {}; api.battleState.p2.ability = 'innerfocus';
  assert.equal(added().score, 0);
});

test('ひるみは相手の先制技とトリックルームを含む行動順で評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Charizard'; api.battleState.p2.species = 'Raichu';
  const own = { ...combatant('Charizard'), stats: { atk: 100, def: 120, spa: 100, spd: 125, spe: 1000 } };
  const added = () => api.addedEffectScore(api.battleDex.moves.get('airslash'), own, null, api.createEmptyBoosts(), api.createEmptyBoosts(), 'p1', 'p2', 'Raichu');
  api.battleState.p2.volatiles = { encore: true, encoreMove: 'quickattack' };
  assert.equal(added().score, 0);
  api.battleState.p2.volatiles.encoreMove = 'tackle';
  assert.ok(added().score > 0);
  api.fieldState.trickRoom = true;
  assert.equal(added().score, 0);
});

for (const player of ['p1', 'p2']) {
  test(`${player}: 通常の眠りとはやおきは、それまで眠り続けた条件付き確率を使う`, () => {
    const api = loadLogic();
    const s = api.createDamageBattle(api.knownCombatant(combatant('Kangaskhan')), api.knownCombatant(combatant('Blastoise')), 'p2');
    try {
      for (const ability of ['', 'earlybird']) {
        s.attacker.ability = ability;
        for (let age = 0; age < 4; age++) {
          let possible = 0, wakes = 0;
          const generated = [];
          for (const sampleIndex of [0, 1, 2]) {
            s.attacker.clearStatus();
            // 実際のonStartが渡す候補をサンプルする。内部カウントの手動設定では検証しない。
            s.calc.sample = (items) => items[sampleIndex];
            assert.equal(s.attacker.setStatus('slp', s.defender, s.calc.dex.moves.get('sleeppowder')), true);
            generated.push(s.attacker.statusState.startTime);
            let survived = true;
            for (let prior = 0; prior < age; prior++) {
              if (s.calc.runEvent('BeforeMove', s.attacker, s.defender, s.calc.dex.getActiveMove('tackle'))) { survived = false; break; }
            }
            if (!survived) continue;
            possible++;
            if (s.calc.runEvent('BeforeMove', s.attacker, s.defender, s.calc.dex.getActiveMove('tackle'))) wakes++;
          }
          assert.deepEqual(generated, [2, 3, 3], 'Championsの実際の初期カウント');
          api.battleState[player].statusAge = age;
          assert.ok(Math.abs(api.sleepWakeChance(player, ability) - (possible ? wakes / possible : 1)) < 1e-12);
        }
      }
    } finally { s.calc.destroy(); }
  });
}

test('通常の眠りは1回眠った後1/3、2回後100%で起き、攻撃・ねごとへ反映する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Arcanine';
  const request = moveRequest(combatant('Blastoise'), ['surf', 'sleeptalk']);
  const score = (id) => api.evaluateMove({ id }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, 'p1', 'p2');
  const awake = score('surf').score;
  api.battleState.p1.status = 'slp'; api.battleState.p1.statusAge = 1; request.side.pokemon[0].condition = '200/200 slp';
  assert.ok(Math.abs(score('surf').score - awake / 3) < 1e-10);
  assert.ok(Math.abs(score('sleeptalk').score - awake * 2 / 3) < 1e-10);
  api.battleState.p1.statusAge = 2;
  assert.equal(score('surf').score, awake);
  assert.equal(score('sleeptalk').score, 0);
  api.battleState.p1.statusAge = 1; request.side.pokemon[0].ability = 'earlybird';
  assert.equal(score('surf').score, awake);
  assert.equal(score('sleeptalk').score, 0);
});

for (const player of ['p1', 'p2']) {
  test(`${player}: こおりは実エンジンの25%・25%・100%と攻撃評価が一致する`, () => {
    const api = loadLogic();
    const foe = player === 'p1' ? 'p2' : 'p1';
    api.battleState[player].species = 'Blastoise'; api.battleState[foe].species = 'Arcanine';
    const request = moveRequest(combatant('Blastoise'), ['surf']);
    const score = () => api.evaluateMove({ id: 'surf' }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, player, foe);
    const awake = score();
    const s = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), api.knownCombatant(combatant('Arcanine')), foe);
    try {
      for (let age = 0; age <= 2; age++) {
        let able = 0;
        for (let draw = 0; draw < 4; draw++) {
          s.attacker.clearStatus();
          assert.equal(s.attacker.setStatus('frz', s.defender, s.calc.dex.moves.get('icebeam')), true);
          assert.equal(s.attacker.statusState.startTime, 3);
          s.calc.randomChance = () => false;
          for (let prior = 0; prior < age; prior++) {
            assert.equal(s.calc.runEvent('BeforeMove', s.attacker, s.defender, s.calc.dex.getActiveMove('surf')), false);
          }
          s.calc.randomChance = (n, d) => {
            assert.equal(n, 1); assert.equal(d, 4);
            return draw < n;
          };
          if (s.calc.runEvent('BeforeMove', s.attacker, s.defender, s.calc.dex.getActiveMove('surf'))) able++;
        }
        const expected = age === 2 ? 1 : 1 / 4;
        assert.equal(able / 4, expected);
        api.battleState[player].status = 'frz'; api.battleState[player].statusAge = age;
        request.side.pokemon[0].condition = '200/200 frz';
        assert.equal(api.cantMoveFactor('frz', player), expected);
        const actual = score();
        assert.ok(Math.abs(actual.score - awake.score * expected) < 1e-10);
        assert.equal(actual.hitChance, awake.hitChance * expected);
        assert.equal(actual.minDamagePercent, expected === 1 ? awake.minDamagePercent : 0);
      }
    } finally { s.calc.destroy(); }
  });

  test(`${player}: こおりの公開経過を交代後も保持し、別個体・治癒・再付与ではリセットする`, () => {
    const api = loadLogic();
    const log = (lines) => api.updateBattleState(lines.replaceAll('PLAYER', player));
    log('|switch|PLAYERa: カメ|Blastoise, L50|200/200\n|-status|PLAYERa: カメ|frz\n|cant|PLAYERa: カメ|frz');
    assert.equal(api.battleState[player].statusAge, 1);
    log('|switch|PLAYERa: 鳥|Charizard, L50|200/200 frz');
    assert.equal(api.battleState[player].statusAge, 0);
    log('|switch|PLAYERa: カメ|Blastoise, L50|200/200 frz');
    assert.equal(api.battleState[player].statusAge, 1);
    log('|cant|PLAYERa: カメ|frz\n|switch|PLAYERa: 犬|Arcanine, L50|200/200\n|drag|PLAYERa: カメ|Blastoise, L50|200/200 frz');
    assert.equal(api.battleState[player].statusAge, 2);
    assert.equal(api.cantMoveFactor('frz', player), 1);
    log('|-curestatus|PLAYERa: カメ|frz\n|-status|PLAYERa: カメ|frz');
    assert.equal(api.battleState[player].statusAge, 0);
    assert.equal(api.cantMoveFactor('frz', player), 1 / 4);
    log('|clearpoke');
    assert.equal(Object.keys(api.battleState[player].freezeHistory).length, 0);
  });

  test(`${player}: まひの行動不能は実エンジンで1/8、攻撃の評価と命中見込みは7/8になる`, () => {
    const api = loadLogic();
    const foe = player === 'p1' ? 'p2' : 'p1';
    const s = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), api.knownCombatant(combatant('Arcanine')), foe);
    try {
      assert.equal(s.attacker.setStatus('par', s.defender, s.calc.dex.moves.get('glare')), true);
      let unable = 0;
      for (let draw = 0; draw < 8; draw++) {
        s.calc.randomChance = (n, d) => {
          assert.equal(n, 1); assert.equal(d, 8);
          return draw < n;
        };
        if (!s.calc.runEvent('BeforeMove', s.attacker, s.defender, s.calc.dex.getActiveMove('surf'))) unable++;
      }
      assert.equal(unable, 1);
      api.battleState[player].species = 'Blastoise'; api.battleState[foe].species = 'Arcanine';
      const request = moveRequest(combatant('Blastoise'), ['surf']);
      const score = () => api.evaluateMove({ id: 'surf' }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), request, player, foe);
      const awake = score();
      api.battleState[player].status = 'par'; request.side.pokemon[0].condition = '200/200 par';
      const actual = score();
      assert.equal(api.cantMoveFactor('par', player), 7 / 8);
      assert.equal(actual.score, awake.score * 7 / 8);
      assert.equal(actual.hitChance, awake.hitChance * 7 / 8);
      assert.equal(actual.minDamagePercent, 0, '行動不能の可能性を確定KOに含めない');
    } finally { s.calc.destroy(); }
  });
}

test('相手のねむり・こおり・まひの行動可能性を被ダメージ危険度へ反映する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Arcanine';
  const own = combatant('Blastoise');
  const risk = () => api.evaluateIncomingRisk(own, 'Arcanine', ['flamethrower', 'protect', 'roar', 'sunnyday'], api.createEmptyBoosts(), 'p1');
  const awake = risk();
  assert.ok(awake.penalty > 0);
  for (const [status, age, expected] of [['slp', 0, 0], ['slp', 1, 1 / 3], ['slp', 2, 1], ['frz', 0, 1 / 4], ['frz', 1, 1 / 4], ['frz', 2, 1], ['par', 0, 7 / 8]]) {
    api.battleState.p2.status = status; api.battleState.p2.statusAge = age;
    assert.ok(Math.abs(risk().penalty - awake.penalty * expected) < 1e-10, `${status}: ${age}回`);
  }
});

test('こおりの評価は非公開の残りカウントを参照しない', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|200/200\n|-status|p1a: カメ|frz\n|cant|p1a: カメ|frz');
  const s = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), api.knownCombatant(combatant('Arcanine')), 'p2');
  try {
    api.stream.battle = s.calc;
    s.attacker.setStatus('frz', s.defender, s.calc.dex.moves.get('icebeam'));
    const score = () => evaluate(api, 'surf', 'Blastoise', 'Arcanine', '', '', '200/200 frz').score;
    s.attacker.statusState.time = 1;
    const first = score();
    s.attacker.statusState.time = 3;
    assert.equal(score(), first);
  } finally { api.stream.battle = null; s.calc.destroy(); }
});

test('カウンターを構えている相手へのふいうちが成功する組み合わせも評価する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Absol';
  const own = combatant('Wobbuffet'), foe = combatant('Absol');
  const ai = damageFor(api, 'counter', own, foe, { responseMove: 'suckerpunch' });
  const engine = engineConditionalMove(api, 'counter', own, foe, 'suckerpunch');
  assert.ok(ai.score > 0);
  assert.equal(ai.minDamagePercent, engine.damage);
});

for (const player of ['p1', 'p2']) {
  test(`${player}: 公開された控えHP・状態を記憶し、控えへの回復で場のHPを上書きしない`, () => {
    const api = loadLogic();
    const log = (lines) => api.updateBattleState(lines.replaceAll('PLAYER', player));
    const bench = () => api.rangedCombatant(api.battleDex.species.get('Blastoise'), 'def', 'max', api.createEmptyBoosts(), player);
    log('|switch|PLAYERa: カメ|Blastoise, L50|100/100\n|-damage|PLAYERa: カメ|25/100 psn\n|switch|PLAYERa: 犬|Arcanine, L50|100/100');
    assert.equal(bench().hpPercent, 25); assert.equal(bench().status, 'psn');
    log('|-heal|PLAYERa: カメ|75/100 psn');
    assert.equal(bench().hpPercent, 75); assert.equal(api.battleState[player].hpPercent, 100);
    log('|-curestatus|PLAYERa: カメ|psn');
    assert.equal(bench().status, null);
    assert.equal(api.rangedCombatant(api.battleDex.species.get('Steelix'), 'def', 'max', api.createEmptyBoosts(), player).hpPercent, 100);
    log('|clearpoke\n|switch|PLAYERa: 牛|Tauros, L50|100/100');
    assert.equal(Object.keys(api.battleState[player].publicPokemon).length, 1);
    assert.equal(bench().hpPercent, 100);
  });

  test(`${player}: あくびは受けた当日の行動を妨げず、翌ターン終了後の眠りを評価する`, () => {
    const api = loadLogic();
    const foe = player === 'p1' ? 'p2' : 'p1';
    api.updateBattleState(`|switch|${player}a: カメ|Blastoise, L50|100/100\n|switch|${foe}a: 犬|Arcanine, L50|100/100\n|turn|10`);
    const own = { ...combatant('Blastoise'), active: true, moves: ['surf'] };
    const score = () => api.evaluateMove({ id: 'surf' }, 'Blastoise', 'Arcanine', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), { side: { pokemon: [own] } }, player, foe);
    const before = score();
    api.updateBattleState(`|-start|${player}a: カメ|move: Yawn`);
    assert.equal(score().score, before.score);
    assert.equal(api.predictYawnSleepChance(player, own), 0);
    api.updateBattleState('|turn|11');
    const pending = score();
    assert.equal(api.predictYawnSleepChance(player, own), 1);
    assert.ok(pending.score < before.score);
    assert.equal(pending.hitChance, before.hitChance);
    assert.equal(pending.minDamagePercent, before.minDamagePercent, '現在の攻撃は眠りで減らさない');
    const s = api.createDamageBattle(api.knownCombatant(own), api.knownCombatant(combatant('Arcanine')), foe);
    try {
      assert.ok(s.attacker.addVolatile('yawn', s.defender));
      s.calc.fieldEvent('Residual');
      assert.equal(s.attacker.status, '');
      s.calc.fieldEvent('Residual');
      assert.equal(s.attacker.status, 'slp');
    } finally { s.calc.destroy(); }
    api.updateBattleState(`|switch|${player}a: 鳥|Charizard, L50|100/100`);
    assert.equal(api.battleState[player].yawnDueTurn, null);
    assert.equal(api.predictYawnSleepChance(player, { ...combatant('Charizard'), active: true }), 0);
  });
}

test('あくび予測は眠り無効の特性・地形・きのみと、眠ったまま使える技を反映する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100\n|turn|1\n|-start|p1a: カメ|move: Yawn\n|turn|2');
  const own = { ...combatant('Blastoise'), active: true, moves: ['surf'] };
  const ordinary = api.evaluateYawnRisk('p1', own).penalty;
  assert.ok(ordinary > 0);
  for (const ability of ['insomnia', 'vitalspirit', 'comatose']) assert.equal(api.evaluateYawnRisk('p1', { ...own, ability }).penalty, 0);
  for (const item of ['lumberry', 'chestoberry']) assert.equal(api.evaluateYawnRisk('p1', { ...own, item }).penalty, 0);
  api.fieldState.terrain = 'electric';
  assert.equal(api.evaluateYawnRisk('p1', own).penalty, 0);
  api.fieldState.terrain = 'misty';
  assert.equal(api.evaluateYawnRisk('p1', own).penalty, 0);
  api.fieldState.terrain = null;
  assert.ok(api.evaluateYawnRisk('p1', { ...own, ability: 'earlybird' }).penalty < ordinary);
  assert.ok(api.evaluateYawnRisk('p1', { ...own, moves: ['surf', 'sleeptalk'] }).penalty < ordinary);
});

test('交代技はあくびを避けるが、無効なボルトチェンジでは避けられない', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: 電気|Rotom, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100\n|turn|1\n|-start|p1a: 電気|move: Yawn\n|turn|2');
  assert.equal(evaluate(api, 'voltswitch', 'Rotom', 'Arcanine').yawnPenalty, 0);
  assert.ok(evaluate(api, 'voltswitch', 'Rotom', 'Garchomp').yawnPenalty > 0);
});

test('相手のあくびは今の攻撃を止めず、次の睡眠を自分の積み技の評価に反映する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100\n|-ability|p2a: 犬|Flash Fire\n|-enditem|p2a: 犬|Sitrus Berry\n|turn|1');
  const before = evaluate(api, 'shellsmash', 'Blastoise', 'Arcanine');
  api.updateBattleState('|-start|p2a: 犬|move: Yawn\n|turn|2');
  const after = evaluate(api, 'shellsmash', 'Blastoise', 'Arcanine');
  assert.equal(after.opponentNextTurnSleepChance, 1);
  assert.ok(after.score > before.score);
  assert.equal(api.cantMoveFactor(api.battleState.p2.status, 'p2'), 1);
});

test('あくびで眠るターンには、居座る通常攻撃から安全な控えへの交代へ判断が変わる', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100\n|move|p2a: 犬|Flamethrower|p1a: カメ\n|move|p2a: 犬|Protect|p2a: 犬\n|move|p2a: 犬|Roar|p1a: カメ\n|move|p2a: 犬|Sunny Day|p2a: 犬\n|turn|1');
  const own = { ...combatant('Blastoise'), active: true, moves: ['surf'] };
  const bench = { ...combatant('Slowbro'), active: false, moves: ['surf'], stats: { atk: 100, def: 120, spa: 60, spd: 125, spe: 10 } };
  const request = moveRequest(own, ['surf']);
  request.active[0].trapped = false;
  request.side.pokemon.push(bench);
  assert.equal(api.chooseActionInternal('p1', request, null, true), 'move 1');
  api.updateBattleState('|-start|p1a: カメ|move: Yawn\n|turn|2');
  assert.equal(api.chooseActionInternal('p1', request, null, true), 'switch 2');
  request.active[0].trapped = true;
  assert.equal(api.chooseActionInternal('p1', request, null, true), 'move 1');
});

test('記憶した控えHPで、満タンのがんじょうと削れた交代先を区別する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: 鉄|Steelix, L50|100/100\n|-ability|p2a: 鉄|Sturdy\n|-enditem|p2a: 鉄|Sitrus Berry\n|switch|p2a: 犬|Arcanine, L50|100/100');
  const own = { ...combatant('Blastoise'), stats: { atk: 100, def: 120, spa: 1000, spd: 125, spe: 100 } };
  const options = { move: api.battleDex.moves.get('surf'), attackerSpecies: api.battleDex.species.get('Blastoise'), defenderSpecies: api.battleDex.species.get('Steelix'), attackerPokemon: own, defenderPlayer: 'p2' };
  const full = api.estimateInferredBattleDamage(options);
  assert.ok(full.minDamagePercent < 100 && full.minDamagePercent > 90);
  api.updateBattleState('|switch|p2a: 鉄|Steelix, L50|100/100\n|-damage|p2a: 鉄|25/100\n|switch|p2a: 犬|Arcanine, L50|100/100');
  const damaged = api.estimateInferredBattleDamage(options);
  assert.ok(damaged.minDamagePercent >= 100, '削れているのでがんじょうで止まらない');
  assert.equal(executeEngineMove(api, 'surf', own, { ...combatant('Steelix', 'sturdy'), condition: '50/200' }).damage, 25);
});

test('控えのHPは最後の公開値を保持し、さいせいりょくは仮定した特性ごとに回復を計算する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: ヤド|Slowbro, L50|25/100\n|switch|p2a: 犬|Arcanine, L50|100/100');
  const spec = api.rangedCombatant(api.battleDex.species.get('Slowbro'), 'def', 'max', api.createEmptyBoosts(), 'p2');
  assert.equal(spec.hpPercent, 25);
  const recovered = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), { ...spec, ability: 'regenerator' }, 'p2');
  const engine = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), { ...spec, ability: 'regenerator', canRegenerate: false }, 'p2');
  try {
    engine.calc.singleEvent('SwitchOut', engine.calc.dex.abilities.get('regenerator'), engine.defender.abilityState, engine.defender);
    assert.ok(Math.abs(recovered.defender.hp - engine.defender.hp) <= 1, '公開HPの丸めによる最大1HP差');
    assert.ok(recovered.defender.hp / recovered.defender.maxhp > 0.5);
  } finally { recovered.calc.destroy(); engine.calc.destroy(); }
  assert.equal(api.battleState.p2.publicPokemon.Slowbro.hpPercent, 25, '推定回復を公開されたHPに書き戻さない');
});

test('構成候補は合法な4技を固定し、公開技を必ず含め、対面で技セットを入れ替えない', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p2a: 犬|Arcanine, L50|100/100\n|move|p2a: 犬|Flamethrower|p1a: カメ');
  const profiles = api.predictOpponentSets('p2', 'Arcanine');
  assert.ok(profiles.length > 1);
  const learned = api.getLearnedDamagingMoveIds('Arcanine');
  assert.ok(Math.abs(profiles.reduce((sum, row) => sum + row.weight, 0) - 1) < 1e-10);
  for (const profile of profiles) {
    assert.equal(profile.moves.length, 4);
    assert.equal(new Set(profile.moves).size, 4);
    assert.ok(profile.moves.includes('flamethrower'));
    for (const id of profile.moves) if (api.isDamagingMove(api.battleDex.moves.get(id))) assert.ok(learned.includes(id));
    if (profile.item.startsWith('choice')) assert.ok(profile.moves.every((id) => api.battleDex.moves.get(id).category !== 'Status'));
  }
  api.battleState.p1.species = 'Steelix';
  assert.deepEqual(api.predictOpponentSets('p2', 'Arcanine'), profiles);
  const threat = api.hiddenIncomingThreat(combatant('Blastoise'), 'Arcanine', api.createEmptyBoosts(), 'p1', ['flamethrower']);
  assert.ok(threat?.predictedSets.length);
  assert.ok(threat.predictedSets.every((row) => row.moves.includes('flamethrower')));
  for (const damage of threat.options) assert.ok(threat.predictedSets.some((row) => row.moves.includes(damage.moveId)));
  assert.equal(api.hiddenIncomingThreat(combatant('Blastoise'), 'Arcanine', api.createEmptyBoosts(), 'p1', ['flamethrower', 'protect', 'roar', 'sunnyday']), null);
});

test('公開された持ち物・特性・消費で構成候補を絞り、公開済みの同じ持ち物も除外する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p2a: カメ|Blastoise, L50|100/100\n|-item|p2a: カメ|Leftovers\n|switch|p2a: 犬|Arcanine, L50|100/100');
  assert.ok(api.predictOpponentSets('p2', 'Arcanine').every((row) => row.item !== 'leftovers'));
  api.updateBattleState('|-ability|p2a: 犬|Flash Fire\n|-item|p2a: 犬|Choice Band');
  assert.ok(api.predictOpponentSets('p2', 'Arcanine').every((row) => row.ability === 'flashfire' && row.item === 'choiceband'));
  api.updateBattleState('|-enditem|p2a: 犬|Choice Band');
  assert.ok(api.predictOpponentSets('p2', 'Arcanine').every((row) => row.item === ''));
  api.updateBattleState('|switch|p2a: カメ|Blastoise, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100');
  assert.ok(api.predictOpponentSets('p2', 'Arcanine').every((row) => row.item === '' && row.ability === 'flashfire'));
});

test('無効化やダメージの原因欄に公開された特性・持ち物も候補へ反映する', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: シャワ|Vaporeon, L50|100/100\n|-immune|p2a: シャワ|[from] ability: Water Absorb');
  assert.ok(api.predictOpponentSets('p2', 'Vaporeon').every((row) => row.ability === 'waterabsorb'));
  api.updateBattleState('|-damage|p1a: カメ|80/100|[from] item: Rocky Helmet|[of] p2a: シャワ');
  assert.equal(api.battleState.p2.item, 'rockyhelmet');
  assert.equal(api.battleState.p1.item, null);
});

test('未公開の無効化特性は候補として重み付けし、公開後は実エンジンと同じ無効になる', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Vaporeon';
  const options = { move: api.battleDex.moves.get('surf'), attackerSpecies: api.battleDex.species.get('Blastoise'), defenderSpecies: api.battleDex.species.get('Vaporeon'), attackerPokemon: combatant('Blastoise'), defenderPlayer: 'p2' };
  const base = api.estimateBattleDamage(options);
  const predicted = api.estimateInferredBattleDamage(options);
  assert.ok(predicted.score > 0 && predicted.score < base.score);
  assert.equal(predicted.minDamagePercent, 0);
  assert.equal(predicted.immune, false);
  api.updateBattleState('|-ability|p2a: シャワ|Water Absorb');
  assert.equal(api.estimateInferredBattleDamage(options).immune, true);
  assert.equal(executeEngineMove(api, 'surf', combatant('Blastoise'), combatant('Vaporeon', 'waterabsorb')).damage, 0);
});

test('未公開のふゆうも接地判定に反映し、サイコフィールドの先制技を候補ごとに判定する', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Scizor'; api.battleState.p2.species = 'Bronzong';
  api.fieldState.terrain = 'psychic';
  const options = { move: api.battleDex.moves.get('bulletpunch'), attackerSpecies: api.battleDex.species.get('Scizor'), defenderSpecies: api.battleDex.species.get('Bronzong'), attackerPokemon: combatant('Scizor', 'technician'), defenderPlayer: 'p2' };
  const predicted = api.estimateInferredBattleDamage(options);
  assert.ok(predicted.score > 0);
  assert.equal(predicted.minDamagePercent, 0);
  api.fieldState.gravity = true;
  assert.equal(api.estimateInferredBattleDamage(options).score, 0);
});

test('未公開のタスキ・スカーフを候補に含め、公開後はダメージ・速度の幅を絞る', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Gengar';
  assert.ok(api.predictOpponentSets('p2', 'Gengar').some((row) => row.item === 'focussash'));
  const options = { move: api.battleDex.moves.get('surf'), attackerSpecies: api.battleDex.species.get('Blastoise'), defenderSpecies: api.battleDex.species.get('Gengar'), attackerPokemon: { ...combatant('Blastoise'), stats: { atk: 100, def: 120, spa: 1000, spd: 125, spe: 100 } }, defenderPlayer: 'p2' };
  assert.ok(api.estimateInferredBattleDamage(options).minDamagePercent < 100);
  api.updateBattleState('|-item|p2a: 幽霊|Life Orb');
  assert.ok(api.estimateInferredBattleDamage(options).minDamagePercent >= 100);
  api.updateBattleState('|switch|p2a: 犬|Arcanine, L50|100/100');
  const base = api.getOpponentSpeedRange('p1', 'Arcanine', api.createEmptyBoosts(), null);
  assert.ok(api.getOpponentSpeedRange('p1', 'Arcanine', api.createEmptyBoosts(), null, true).maxSpeed > base.maxSpeed);
  api.updateBattleState('|-item|p2a: 犬|Leftovers');
  assert.equal(api.getOpponentSpeedRange('p1', 'Arcanine', api.createEmptyBoosts(), null, true).maxSpeed, base.maxSpeed);
});

test('構成予測は非公開の技・持ち物・特性・控えHPを変更しても変化しない', () => {
  const api = loadLogic();
  api.updateBattleState('|switch|p1a: カメ|Blastoise, L50|100/100\n|switch|p2a: 犬|Arcanine, L50|100/100');
  const s = api.createDamageBattle(api.knownCombatant(combatant('Blastoise')), api.knownCombatant(combatant('Arcanine')), 'p2');
  try {
    api.stream.battle = s.calc;
    const first = api.predictOpponentSets('p2', 'Arcanine');
    const damage = () => api.hiddenIncomingThreat(combatant('Blastoise'), 'Arcanine', api.createEmptyBoosts(), 'p1', []).expectedDamagePercent;
    const initial = damage();
    s.defender.ability = 'hugepower'; s.defender.item = 'choiceband'; s.defender.hp = 1;
    s.defender.moveSlots = [{ id: 'explosion', pp: 5, maxpp: 5 }];
    api.latestRequests.p2 = moveRequest({ ...combatant('Arcanine', 'hugepower'), item: 'choiceband', condition: '1/200' }, ['explosion']);
    assert.deepEqual(api.predictOpponentSets('p2', 'Arcanine'), first);
    assert.equal(damage(), initial);
  } finally { api.stream.battle = null; s.calc.destroy(); }
});

test('条件付き技の推定は相手の実際の選択・非公開request・能力実数を参照しない', () => {
  const api = loadLogic();
  api.battleState.p1.species = 'Wobbuffet'; api.battleState.p2.species = 'Blastoise';
  api.battleState.p2.revealedMoves.Blastoise = new Set(['tackle']);
  const own = { ...combatant('Wobbuffet'), active: true };
  const s = api.createDamageBattle(api.knownCombatant(own), api.knownCombatant(combatant('Blastoise')), 'p2');
  try {
    api.stream.battle = s.calc;
    const scores = () => ['counter', 'suckerpunch'].map((id) => api.evaluateMove({ id }, 'Wobbuffet', 'Blastoise', null, null, api.createEmptyBoosts(), api.createEmptyBoosts(), { side: { pokemon: [own] } }, 'p1', 'p2').score);
    const first = scores();
    s.calc.queue.push({ choice: 'move', pokemon: s.defender, move: s.calc.dex.getActiveMove('raindance') });
    s.defender.storedStats.atk = 9999;
    s.defender.ability = 'hugepower';
    api.latestRequests.p2 = moveRequest({ ...combatant('Blastoise', 'hugepower'), item: 'choiceband' }, ['raindance']);
    assert.deepEqual(scores(), first);
  } finally { api.stream.battle = null; s.calc.destroy(); }
});
