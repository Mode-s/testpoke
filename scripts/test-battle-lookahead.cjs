const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const filename = path.join(__dirname, 'battle-from-json.cjs');
const source = fs.readFileSync(filename, 'utf8');
function loadLogic() {
  const context = vm.createContext({ require, process, console: { ...console, log() {} } });
  vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context, { filename });
  return vm.runInContext(`({ battleState, fieldState, speedLearningState, speedKnowledge, stream, Battle, battleDex,
    lookaheadPolicy, lookaheadDecisions, lookaheadCache, hiddenDisruptionPolicy, updateBattleState,
    createLookaheadBattle, advanceLookaheadTurn, lookaheadActions, computeLookahead,
    lookaheadNextPlan, lookaheadActionKey, lookaheadPosition, finishLookaheadChoice,
    limitLookaheadActions, lookaheadMoveRole, chooseAction, effectProfileGroups })`, context);
}
function pokemon(species, ids, extra = {}) {
  return { details: `${species}, L50`, condition: '200/200', stats: { atk: 120, def: 120, spa: 120, spd: 120, spe: 100 },
    ability: '', item: '', active: true, moves: ids, ...extra };
}
function fixture(own = 'Blastoise', foe = 'Arcanine', ids = ['surf', 'protect'], foeIds = ['flamethrower', 'protect']) {
  const api = loadLogic(); api.battleState.p1.species = own; api.battleState.p2.species = foe;
  api.speedLearningState.turn = 5;
  const request = { active: [{ moves: ids.map((id) => ({ id, move: api.battleDex.moves.get(id).name, pp: 16, maxpp: 16, disabled: false })) }],
    side: { pokemon: [pokemon(own, ids)] } };
  const profile = { role: 'physical', ability: '', item: '', moves: foeIds, weight: 1 };
  const build = (sample = 0) => api.createLookaheadBattle('p1', request, profile, sample);
  const turn = (calc, ownSlot = 1, foeSlot = 1) => api.advanceLookaheadTurn(JSON.stringify(calc.toJSON()), 'p1', { kind: 'move', slot: ownSlot }, { kind: 'move', slot: foeSlot });
  return { api, request, profile, build, turn };
}

test('先読みの一手は双方の行動・やけど・回復を経て次のrequestまで進む', () => {
  const f = fixture(); f.request.side.pokemon[0].condition = '160/200 brn'; f.request.side.pokemon[0].item = 'leftovers';
  const calc = f.build();
  try {
    const result = f.turn(calc, 2, 2); assert.ok(result); assert.equal(result.turn, 6);
    assert.equal(result.own.hp, 160); assert.equal(result.own.status, 'brn');
    assert.ok(result.publicLog.some((line) => line.includes('[from] brn')));
    assert.ok(result.publicLog.some((line) => line.includes('Leftovers')));
  } finally { calc.destroy(); }
});
test('公開された猛毒の次回カウントを一度だけターン終了へ適用する', () => {
  const f = fixture(); f.request.side.pokemon[0].condition = '200/200 tox';
  f.api.battleState.p1.status = 'tox'; f.api.battleState.p1.toxicCounter = 3;
  const calc = f.build();
  try { const result = f.turn(calc, 2, 2); assert.equal(result.own.hp, 164); } finally { calc.destroy(); }
});
test('あくびは翌ターン終了に眠り、その状態を次の仮計算へ引き継ぐ', () => {
  const f = fixture('Blastoise', 'Slowbro', ['protect', 'surf'], ['yawn', 'protect']);
  const calc = f.build();
  try {
    const first = f.turn(calc, 2, 1); assert.ok(first); assert.equal(first.own.status, '');
    const second = f.api.advanceLookaheadTurn(first.state, 'p1', { kind: 'move', slot: 2 }, { kind: 'move', slot: 2 });
    assert.ok(second); assert.equal(second.own.status, 'slp');
  } finally { calc.destroy(); }
});
test('公開済みあくびは今ターン終了の眠りとして復元する', () => {
  const f = fixture(); f.api.battleState.p1.volatiles.yawn = true; f.api.battleState.p1.yawnDueTurn = 5;
  const calc = f.build();
  try { assert.equal(f.turn(calc, 2, 2).own.status, 'slp'); } finally { calc.destroy(); }
});
test('残り1ターンの天候・壁・トリックルームをターン終了で解除する', () => {
  const f = fixture(); const field = f.api.fieldState;
  field.weather = 'sand'; field.weatherTurns = 1; field.trickRoom = true; field.trickRoomTurns = 1;
  field.sides.p1.reflect = true; field.sides.p1.reflectTurns = 1;
  const calc = f.build();
  try {
    const after = f.turn(calc, 2, 2); const restored = f.api.Battle.fromJSON(after.state);
    try { assert.equal(restored.field.weather, ''); assert.equal(restored.field.pseudoWeather.trickroom, undefined); assert.equal(restored.sides[0].sideConditions.reflect, undefined); }
    finally { restored.destroy(); }
  } finally { calc.destroy(); }
});
test('先行KOのあと控えを出し、ターンを終えてから次の判断に進む', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'protect'], ['wildcharge', 'protect']);
  f.request.side.pokemon[0].condition = '1/200';
  f.request.side.pokemon.push(pokemon('Garchomp', ['earthquake', 'protect'], { active: false }));
  const calc = f.build();
  try {
    const after = f.turn(calc); assert.ok(after); assert.equal(after.turn, 6);
    assert.equal(after.own.species, 'Garchomp'); assert.ok(after.own.hp > 0);
    assert.ok(after.publicLog.some((line) => line.startsWith('|faint|')));
    assert.ok(after.publicLog.some((line) => line.startsWith('|switch|')));
  } finally { calc.destroy(); }
});
test('とんぼがえりの途中の交代後も相手の行動と残余処理を実行する', () => {
  const f = fixture('Scizor', 'Blastoise', ['uturn', 'protect'], ['surf', 'protect']);
  f.request.side.pokemon[0].stats.spe = 1000;
  f.request.side.pokemon.push(pokemon('Arcanine', ['flamethrower', 'protect'], { active: false }));
  const calc = f.build();
  try {
    const after = f.turn(calc); assert.ok(after); assert.equal(after.turn, 6); assert.equal(after.own.species, 'Arcanine');
    assert.ok(after.own.hp < 200); assert.ok(after.publicLog.some((line) => line.includes('|Surf|')));
  } finally { calc.destroy(); }
});
test('先読みは実戦の私有状態を参照せず、公開状態と自分のrequestを書き換えない', () => {
  const f = fixture(); f.api.stream.battle = new Proxy({}, { get() { throw new Error('実戦の私有状態にアクセス'); } });
  const before = JSON.stringify([f.api.battleState, f.api.fieldState, f.request], (_, value) => value instanceof Set ? [...value] : value);
  const calc = f.build();
  try { assert.ok(f.turn(calc)); } finally { calc.destroy(); }
  assert.equal(JSON.stringify([f.api.battleState, f.api.fieldState, f.request], (_, value) => value instanceof Set ? [...value] : value), before);
});
test('計算の上限に達した未完了候補を点数0の有力候補として使わない', () => {
  const f = fixture(); const result = f.api.computeLookahead('p1', f.request, [{ kind: 'move', id: 'surf', slot: 1, score: 30 }],
    { ...f.api.lookaheadPolicy, maxMillis: 0, maxNodes: 0 });
  assert.equal(result.reason, 'incomplete-first-turn'); assert.equal(result.rows.length, 0); assert.equal(result.nodes, 0);
});

test('仮説ごとの最善手を自由に足さず、同じ公開観測では共通の次の技を選ぶ', () => {
  const f = fixture('Blastoise', 'Vaporeon', ['surf', 'icebeam', 'protect'], ['acidarmor']);
  const outcomes = [];
  for (const ability of ['waterabsorb', 'hydration']) {
    f.profile.ability = ability; const calc = f.build();
    try { outcomes.push({ ...f.turn(calc, 3, 1), weight: 0.5 }); } finally { calc.destroy(); }
  }
  assert.equal(outcomes[0].observable, outcomes[1].observable);
  const policy = { ...f.api.lookaheadPolicy, maxFoeActions: 1, maxNextActions: 3 };
  const budget = () => ({ nodes: 0, limit: 1000, deadline: Infinity });
  const common = f.api.lookaheadNextPlan(outcomes, 'p1', policy, budget());
  const oracle = f.api.lookaheadNextPlan(outcomes.map((row, i) => ({ ...row, observable: `private-hypothesis-${i}` })), 'p1', policy, budget());
  assert.ok(common); assert.equal(common.plans.length, 1); assert.equal(common.plans[0].hypotheses, 2);
  assert.equal(common.plans[0].id, 'icebeam'); assert.ok(common.value < oracle.value);
});
test('積み→攻撃の利益を、攻撃→攻撃や積み続ける場合と比較する', () => {
  const f = fixture('Scizor', 'Blastoise', ['swordsdance', 'bulletpunch'], ['tackle']);
  f.request.side.pokemon[0].ability = 'technician';
  const calc = f.build();
  try {
    const policy = { ...f.api.lookaheadPolicy, maxFoeActions: 1, maxNextActions: 2 };
    const future = (slot) => f.api.lookaheadNextPlan([{ ...f.turn(calc, slot, 1), weight: 1 }], 'p1', policy, { nodes: 0, limit: 100, deadline: Infinity });
    const setup = future(1); const attack = future(2);
    assert.ok(setup.value > attack.value); assert.equal(setup.plans[0].id, 'bulletpunch');
  } finally { calc.destroy(); }
});
test('まもるで継続ダメージによる勝利に届く場合は防御を保持する', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'protect'], ['thunderfang']);
  f.request.side.pokemon[0].condition = '1/200'; f.request.side.pokemon[0].stats.spe = 1;
  f.api.battleState.p2.status = 'tox'; f.api.battleState.p2.toxicCounter = 1; f.api.battleState.p2.hpPercent = 1;
  const calc = f.build();
  try { assert.equal(f.turn(calc, 2, 1).winner, 'p1'); assert.equal(f.turn(calc, 1, 1).winner, 'p2'); } finally { calc.destroy(); }
});
test('通常評価が低い回復・積み・設置も候補として残す', () => {
  const f = fixture();
  const actions = [
    { kind: 'move', slot: 1, id: 'surf', role: 'attack', score: 100 },
    { kind: 'move', slot: 2, id: 'recover', role: 'heal', score: 1 },
    { kind: 'move', slot: 3, id: 'swordsdance', role: 'setup', score: 0 },
    { kind: 'move', slot: 4, id: 'spikes', role: 'hazard', score: -1 },
  ];
  assert.deepEqual(Array.from(f.api.limitLookaheadActions(actions, 4), (row) => row.id).sort(), ['recover', 'spikes', 'surf', 'swordsdance']);
});
test('技のPP・使用不能・技スロット・交代禁止を候補抽出で尊重する', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'icebeam', 'protect']);
  f.request.active[0].moves[0].pp = 0; f.request.active[0].moves[1].disabled = true;
  const calc = f.build();
  try {
    const rows = f.api.lookaheadActions(calc, 'p1', 6);
    assert.deepEqual(Array.from(rows, (row) => row.slot), [3]);
    calc.sides[0].activeRequest.active[0].trapped = true;
    assert.ok(rows.every((row) => row.kind === 'move'));
  } finally { calc.destroy(); }
});
test('同じ公開観測から合法な素早さ配分を作り、攻撃・HP・速度の合計上限を守る', () => {
  const f = fixture('Blastoise', 'Scizor', ['surf', 'protect'], ['bulletpunch']);
  f.api.speedKnowledge.p1.Scizor = { observations: 1, candidates: [128] };
  const calc = f.build();
  try {
    const mon = calc.sides[1].active[0]; assert.equal(mon.storedStats.spe, 128);
    assert.ok(Object.values(mon.set.evs).reduce((a, b) => a + b, 0) <= 66);
  } finally { calc.destroy(); }
});
test('Championsのこおりは公開済み行動不能2回の次に必ず解ける', () => {
  const f = fixture(); f.request.side.pokemon[0].condition = '200/200 frz';
  f.api.battleState.p1.status = 'frz'; f.api.battleState.p1.statusAge = 2;
  const calc = f.build();
  try { assert.equal(f.turn(calc, 1, 2).own.status, ''); } finally { calc.destroy(); }
});
test('連続まもるの成功履歴を初期盤面と次のターンへ引き継ぐ', () => {
  const f = fixture(); f.api.battleState.p1.protectionChain = { count: 2, turn: 4 };
  const calc = f.build();
  try {
    assert.equal(calc.sides[0].active[0].volatiles.stall.counter, 9);
    const result = f.turn(calc, 2, 2); assert.ok(result);
    const next = f.api.Battle.fromJSON(result.state);
    try { if (result.publicLog.some((line) => line.startsWith('|-singleturn|p1'))) assert.equal(next.sides[0].active[0].volatiles.stall.counter, 27); }
    finally { next.destroy(); }
  } finally { calc.destroy(); }
});
test('公開されたほろびのカウントを復元し、倒れた後の交代まで進める', () => {
  const f = fixture(); f.api.updateBattleState('|-start|p1a: Blastoise|perish1');
  f.request.side.pokemon.push(pokemon('Garchomp', ['earthquake'], { active: false }));
  const calc = f.build();
  try { const result = f.turn(calc, 2, 2); assert.ok(result); assert.equal(result.own.species, 'Garchomp'); }
  finally { calc.destroy(); }
});
test('2ターン先読みは全行動で同じ4技構成を使い、確定で動ける先手KOを維持する', () => {
  const f = fixture(); const legacy = { kind: 'move', id: 'surf', slot: 1, score: 100 };
  const scored = [{ ...legacy, move: f.request.active[0].moves[0], minDamagePercent: 200, hitChance: 1 }];
  const action = f.api.finishLookaheadChoice('p1', f.request, scored, false, legacy, { certainFirstKO: true }, null, true);
  assert.equal(action, 'move 1'); assert.equal(f.api.lookaheadDecisions.get('p1').reason, 'certain-first-ko');
  assert.equal(f.api.lookaheadDecisions.get('p1').nodes, 0);
});
test('1ターンと2ターンを同じ深さで比較し、上限を超えた2ターン候補は除外する', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'protect']);
  const actions = [{ kind: 'move', id: 'surf', slot: 1, score: 30 }, { kind: 'move', id: 'protect', slot: 2, score: 20 }];
  const before = JSON.stringify(f.request);
  const first = f.api.computeLookahead('p1', f.request, actions, { ...f.api.lookaheadPolicy, depth: 1, maxMillis: 0, samples: 1, maxProfiles: 1 });
  assert.ok(first.rows.length === 2); assert.ok(first.rows.every((row) => row.depth === 1));
  const second = f.api.computeLookahead('p1', f.request, actions, { ...f.api.lookaheadPolicy, depth: 2, maxMillis: 0, samples: 1, maxProfiles: 1 });
  assert.equal(second.rows.length, 2); assert.ok(second.rows.every((row) => row.depth === 2));
  assert.ok(second.profiles.every((profile) => profile.moves.length <= 4)); assert.equal(JSON.stringify(f.request), before);
  const limited = f.api.computeLookahead('p1', f.request, actions, { ...f.api.lookaheadPolicy, depth: 2, maxMillis: 0, samples: 1, maxProfiles: 1, maxNodes: first.nodes });
  assert.ok(limited.rows.every((row) => row.depth === 1)); assert.equal(limited.reason, 'first-turn-fallback'); assert.ok(limited.nodes <= first.nodes);
});
test('交代→回復で耐え直せる場合を、交代→攻撃で倒れる場合と比較する', () => {
  const f = fixture('Scizor', 'Arcanine', ['bulletpunch', 'protect'], ['flareblitz']);
  f.request.side.pokemon.push(pokemon('Slowbro', ['surf', 'slackoff'], { active: false, condition: '100/200' }));
  const calc = f.build();
  try {
    const first = f.api.advanceLookaheadTurn(JSON.stringify(calc.toJSON()), 'p1', { kind: 'switch', slot: 2 }, { kind: 'move', slot: 1 });
    assert.ok(first); assert.equal(first.own.species, 'Slowbro'); assert.ok(first.own.hp > 0);
    const next = f.api.lookaheadNextPlan([{ ...first, weight: 1 }], 'p1', { ...f.api.lookaheadPolicy, maxFoeActions: 1, maxNextActions: 2 }, { nodes: 0, limit: 100, deadline: Infinity });
    assert.ok(next); assert.equal(next.plans[0].id, 'slackoff');
  } finally { calc.destroy(); }
});
test('積みの前に倒されるなら能力上昇の利益を計上しない', () => {
  const f = fixture('Scizor', 'Arcanine', ['swordsdance', 'protect'], ['flamethrower']);
  f.request.side.pokemon[0].condition = '1/200'; f.request.side.pokemon[0].stats.spe = 1;
  const calc = f.build();
  try { const after = f.turn(calc); assert.ok(after.ended); assert.equal(after.value, -10000); assert.ok(!after.publicLog.some((line) => line.startsWith('|-boost|p1'))); }
  finally { calc.destroy(); }
});
test('入場ダメージで交代先が倒れても次の控えへの交代を完了する', () => {
  const f = fixture('Blastoise', 'Jolteon', ['surf'], ['thunderbolt']);
  f.request.side.pokemon[0].condition = '1/200'; f.api.fieldState.sides.p1.spikes = 1;
  f.request.side.pokemon.push(pokemon('Garchomp', ['earthquake'], { active: false, condition: '1/200' }));
  f.request.side.pokemon.push(pokemon('Vaporeon', ['surf'], { active: false }));
  const calc = f.build();
  try {
    const after = f.turn(calc); assert.ok(after); assert.equal(after.own.species, 'Vaporeon');
    assert.equal(after.publicLog.filter((line) => line.startsWith('|faint|p1')).length, 2);
    assert.equal(after.turn, 6);
  } finally { calc.destroy(); }
});
test('平均の先読みが有利でも、独立した重大技の破綻条件を満たす変更は採用しない', () => {
  const f = fixture(); Object.assign(f.api.lookaheadPolicy, { maxMillis: 0, samples: 1, maxProfiles: 1 });
  const scored = f.request.active[0].moves.map((move, i) => ({ move, slot: i + 1, score: 30 - i, minDamagePercent: 0, hitChance: 1 }));
  const legacy = { kind: 'move', id: 'protect', slot: 2, score: 29 };
  const risk = { rows: [{ kind: 'move', slot: 1, loss: 200 }, { kind: 'move', slot: 2, loss: 0 }] };
  const action = f.api.finishLookaheadChoice('p1', f.request, scored, false, legacy, risk, null, true);
  assert.equal(action, 'move 2');
});
test('HP・ランク・公開技のSetが変わると先読みキャッシュを使い回さない', () => {
  const f = fixture(); Object.assign(f.api.lookaheadPolicy, { maxMillis: 0, samples: 1, maxProfiles: 1 });
  const scored = f.request.active[0].moves.map((move, i) => ({ move, slot: i + 1, score: 30 - i, minDamagePercent: 0, hitChance: 1 }));
  const legacy = { kind: 'move', id: 'surf', slot: 1, score: 30 };
  const call = () => f.api.finishLookaheadChoice('p1', f.request, scored, false, legacy, null, null, true);
  f.api.battleState.p2.revealedMoves.Arcanine = new Set(['flamethrower']); call(); call();
  let size = f.api.lookaheadCache.size;
  f.request.side.pokemon[0].condition = '199/200'; call(); assert.equal(f.api.lookaheadCache.size, ++size);
  f.api.battleState.p1.boosts.spa = 1; call(); assert.equal(f.api.lookaheadCache.size, ++size);
  f.api.battleState.p2.revealedMoves.Arcanine.add('protect'); call(); assert.equal(f.api.lookaheadCache.size, ++size);
});
test('倒れた選出済み個体の分だけ相手の生存仮説枠を減らし、未選出の控えを増やさない', () => {
  const f = fixture(); const state = f.api.battleState.p2;
  state.previewSpecies = ['Arcanine', 'Gengar', 'Steelix', 'Scizor', 'Gyarados', 'Slowbro']; state.faintedSpecies = new Set(['Gengar']);
  const calc = f.build();
  try { assert.equal(calc.sides[1].pokemonLeft, 2); assert.ok(calc.sides[1].pokemon.every((mon) => mon.species.name !== 'Gengar')); }
  finally { calc.destroy(); }
});
test('p2側の先読みでも自分のrequestだけを使い、継続ダメージで勝つ防御を再現する', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'protect'], ['thunderfang']);
  f.request.side.pokemon[0].condition = '1/200'; f.request.side.pokemon[0].stats.spe = 1;
  f.api.battleState.p2.status = 'tox'; f.api.battleState.p2.toxicCounter = 1; f.api.battleState.p2.hpPercent = 1;
  [f.api.battleState.p1, f.api.battleState.p2] = [f.api.battleState.p2, f.api.battleState.p1];
  const calc = f.api.createLookaheadBattle('p2', f.request, f.profile);
  try {
    const after = f.api.advanceLookaheadTurn(JSON.stringify(calc.toJSON()), 'p2', { kind: 'move', slot: 2 }, { kind: 'move', slot: 1 });
    assert.equal(after.winner, 'p2'); assert.equal(after.value, 10000);
  } finally { calc.destroy(); }
});

test('こだわりでrequestが1技でも、交代後は本来の全技と残りPP・自分の実数を保つ', () => {
  const f = fixture('Blastoise', 'Arcanine', ['surf', 'protect', 'icebeam'], ['protect']);
  f.request.side.pokemon[0].condition = '186/186';
  f.request.side.pokemon[0].stats = { atk: 92, def: 120, spa: 150, spd: 125, spe: 100 };
  f.request.side.pokemon[0].item = 'choicespecs'; f.api.battleState.p1.lastMove = 'surf';
  f.request.active[0].moves = [{ ...f.request.active[0].moves[0], pp: 1 }];
  f.request.side.pokemon.push(pokemon('Garchomp', ['earthquake'], { active: false }));
  const calc = f.build();
  try {
    assert.deepEqual(Array.from(calc.sides[0].activeRequest.active[0].moves.filter((row) => !row.disabled), (row) => row.id), ['surf']);
    const first = f.api.advanceLookaheadTurn(JSON.stringify(calc.toJSON()), 'p1', { kind: 'switch', slot: 2 }, { kind: 'move', slot: 1 });
    const second = f.api.advanceLookaheadTurn(first.state, 'p1', { kind: 'switch', slot: 2 }, { kind: 'move', slot: 1 });
    assert.ok(second); const after = f.api.Battle.fromJSON(second.state);
    try {
      assert.deepEqual(Array.from(after.sides[0].activeRequest.active[0].moves, (row) => row.id), ['surf', 'protect', 'icebeam']);
      assert.equal(after.sides[0].active[0].moveSlots[0].pp, 1);
      assert.deepEqual(after.sides[0].activeRequest.side.pokemon[0].stats, f.request.side.pokemon[0].stats);
      assert.deepEqual(after.sides[0].active[0].storedStats, f.request.side.pokemon[0].stats);
    } finally { after.destroy(); }
  } finally { calc.destroy(); }
});
test('合法な自分の実数を性格・66ポイント内の配分へ戻し、控えの使用済みPPも復元する', () => {
  const f = fixture(); const original = new f.api.Battle({ formatid: 'gen9championsbssregmc', seed: [1, 2, 3, 4] });
  try {
    original.setPlayer('p1', { name: 'Own', team: [{ species: 'Blastoise', ability: 'Torrent', moves: ['surf', 'protect'], nature: 'Modest', level: 50, evs: { hp: 32, spa: 32, spe: 2 } }] });
    original.setPlayer('p2', { name: 'Foe', team: [{ species: 'Arcanine', moves: ['protect'], level: 50 }] });
    const mon = original.sides[0].pokemon[0];
    f.request.side.pokemon[0].stats = Object.fromEntries(['atk', 'def', 'spa', 'spd', 'spe'].map((stat) => [stat, mon.baseStoredStats[stat]]));
    f.request.side.pokemon[0].condition = `${mon.maxhp}/${mon.maxhp}`;
    f.request.side.pokemon.push(pokemon('Garchomp', ['earthquake'], { active: false }));
    f.api.battleState.p1.ppUsed.Garchomp = { earthquake: 4 };
    const calc = f.build();
    try {
      const own = calc.sides[0].active[0];
      assert.ok(Object.values(own.set.evs).every((n) => n >= 0 && n <= 32));
      assert.ok(Object.values(own.set.evs).reduce((sum, n) => sum + n, 0) <= 66);
      assert.deepEqual(calc.spreadModify(own.species.baseStats, own.set), { hp: mon.maxhp, ...f.request.side.pokemon[0].stats });
      const bench = calc.sides[0].pokemon[1];
      assert.equal(bench.moveSlots[0].pp, bench.moveSlots[0].maxpp - 4);
    } finally { calc.destroy(); }
  } finally { original.destroy(); }
});
test('変身済みの盤面は不明な現在実数を捏造せず、従来判断へ戻す', () => {
  const f = fixture(); f.api.battleState.p1.transformed = true;
  const result = f.api.computeLookahead('p1', f.request, [{ kind: 'move', slot: 1, id: 'surf' }]);
  assert.equal(result.reason, 'unsupported-transformed-state'); assert.equal(result.nodes, 0); assert.equal(result.rows.length, 0);
});
test('溜め技や反動の技スロットを公開記録から復元できない場合は別の技を予測しない', () => {
  const f = fixture('Blastoise', 'Arcanine', ['hyperbeam', 'protect']);
  f.request.active[0].moves = [{ id: 'recharge', move: 'Recharge' }];
  const result = f.api.computeLookahead('p1', f.request, [{ kind: 'move', slot: 1, id: 'recharge' }]);
  assert.equal(result.reason, 'unsupported-move-request'); assert.equal(result.nodes, 0); assert.equal(result.rows.length, 0);
});
test('製品と同じJavaScript実行環境でも状態の保存・再読込・2ターン比較が成功する', () => {
  const Module = require('node:module'); const native = new Module(filename, module);
  native.filename = filename; native.paths = module.paths;
  native._compile(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };\nmodule.exports = { battleState, speedLearningState, computeLookahead, lookaheadPolicy };', filename);
  const api = native.exports; const f = fixture();
  api.battleState.p1.species = 'Blastoise'; api.battleState.p2.species = 'Arcanine'; api.speedLearningState.turn = 5;
  const result = api.computeLookahead('p1', f.request, [{ kind: 'move', slot: 1, id: 'surf', score: 30 }, { kind: 'move', slot: 2, id: 'protect', score: 20 }],
    { ...api.lookaheadPolicy, maxMillis: 0, samples: 1, maxProfiles: 1 });
  assert.equal(result.reason, 'complete'); assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.depth === 2 && Number.isFinite(row.value)));
});
test('探索中の重力で控えが接地した場合は、その仮盤面の設置負担を評価する', () => {
  const f = fixture(); f.api.fieldState.sides.p1.spikes = 3;
  f.request.side.pokemon.push(pokemon('Corviknight', ['bravebird'], { active: false }));
  const calc = f.build();
  try {
    const before = f.api.lookaheadPosition(calc, 'p1');
    calc.field.addPseudoWeather('gravity', calc.sides[0].active[0]);
    assert.equal(before - f.api.lookaheadPosition(calc, 'p1'), 20);
    assert.equal(f.api.fieldState.gravity, false);
  } finally { calc.destroy(); }
});

module.exports = { loadLogic, fixture, pokemon };
