const fs = require('node:fs');
const { ACTIVE_BATTLE_RULES, moveRestriction, isMoveAllowed, assertMoveAllowed, createBattleTeamValidator, assertRequestSupported } = require('./battle-rules.cjs');

const { Battle, BattleStream, Dex, Side, Teams, TeamValidator } = require('../vendor/pokemon-showdown/dist/sim');

Dex.includeFormats();

const FORMAT = ACTIVE_BATTLE_RULES.format;
const BATTLE_LEVEL = 50;
const STEALTH_ROCK_TEST_MODE = false;
const battleDex = Dex.forFormat(FORMAT);

// ========================================
// JSON読み込み
// ========================================

function loadMaster(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

  if (Array.isArray(data)) {
    return data;
  }

  const array = Object.values(data).find((value) => Array.isArray(value) && value.some((entry) => entry && typeof entry === 'object' && 'name' in entry && 'showdownId' in entry));

  if (!array) {
    throw new Error(`マスターデータが見つかりません: ${path}`);
  }

  return array;
}

function findByName(data, name, type) {
  const found = data.find((entry) => entry.name === name);

  if (!found) {
    throw new Error(`${type}が見つかりません: ${name}`);
  }

  return found;
}

// ========================================
// マスターデータ
// ========================================

const roster = loadMaster('./data/champions-roster.json');

const moves = loadMaster('./data/champions-moves.json');

const items = loadMaster('./data/champions-items.json');

const abilities = loadMaster('./data/champions-abilities.json');

const natures = loadMaster('./data/champions-natures.json');

const learnsets = JSON.parse(fs.readFileSync('./data/champions-learnsets.json', 'utf8')).learnsets;

const moveByChampionsId = new Map(moves.map((move) => [move.id, move]));

const learnsetByName = new Map(learnsets.map((entry) => [entry.name, entry.moves]));

const rosterByShowdownId = new Map();

for (const entry of roster) {
  if (!rosterByShowdownId.has(entry.showdownId)) {
    rosterByShowdownId.set(entry.showdownId, entry);
  }
}

// ========================================
// 日本語チーム → Showdown形式
// ========================================

function convertTeam(path) {
  const team = JSON.parse(fs.readFileSync(path, 'utf-8'));

  return team.map((member) => {
    const pokemon = findByName(roster, member.pokemon, 'ポケモン');

    const ability = findByName(abilities, member.ability, 'とくせい');

    const nature = findByName(natures, member.nature, 'せいかく');

    const item = member.item ? findByName(items, member.item, 'もちもの') : null;

    const showdownMoves = member.moves.map((moveName) => {
      const move = findByName(moves, moveName, 'わざ');
      assertMoveAllowed(battleDex.moves.get(move.showdownId), member.pokemon);
      return move.showdownId;
    });

    return {
      species: pokemon.showdownId,
      ability: ability.showdownId,
      item: item?.showdownId ?? '',
      nature: nature.showdownId,
      moves: showdownMoves,
      level: 100,

      evs: {
        hp: member.statPoints?.hp ?? 0,
        atk: member.statPoints?.attack ?? 0,
        def: member.statPoints?.defense ?? 0,
        spa: member.statPoints?.spAttack ?? 0,
        spd: member.statPoints?.spDefense ?? 0,
        spe: member.statPoints?.speed ?? 0,
      },
    };
  });
}

// ========================================
// チーム
// ========================================

const teamA = convertTeam('./teams/team-a.json');

const teamB = convertTeam('./teams/team-b.json');

// ========================================
// 合法性チェック
// ========================================

const validator = createBattleTeamValidator(TeamValidator, Dex);

const problemsA = validator.validateTeam(teamA);

const problemsB = validator.validateTeam(teamB);

if (problemsA) {
  console.error('Team A に問題があります:');
  console.error(problemsA);
  process.exit(1);
}

if (problemsB) {
  console.error('Team B に問題があります:');
  console.error(problemsB);
  process.exit(1);
}

const packedTeamA = Teams.pack(teamA);

const packedTeamB = Teams.pack(teamB);

// ========================================
// 能力ランク
// ========================================

function createEmptyBoosts() {
  return {
    atk: 0,
    def: 0,
    spa: 0,
    spd: 0,
    spe: 0,
    accuracy: 0,
    evasion: 0,
  };
}

function clampBoost(value) {
  return Math.max(-6, Math.min(6, value));
}

function getBoostMultiplier(stage) {
  if (stage >= 0) {
    return (2 + stage) / 2;
  }

  return 2 / (2 - stage);
}

// ========================================
// 盤面
// ========================================

const battleState = {
  p1: {
    species: null,
    hpPercent: 100,
    status: null,
    lastMove: null,
    boosts: createEmptyBoosts(),
    revealedMoves: {},
    previewSpecies: [],
    faintedSpecies: new Set(),
    selectedSpecies: new Set(),
    activeMoveActions: 0,
    lastActionTurn: null,
    item: null,
    ability: null,
    revealedAbilities: {},
    revealedItems: {},
    unburden: false,
    toxicCounter: 0,
    lastChoice: null,
    statusAge: 0,
    sleepSource: null,
    sleepHistory: {},
    freezeHistory: {},
    publicPokemon: {},
    publicNames: {},
    yawnDueTurn: null,
    recentSpecies: [],
    gender: null,
    volatiles: {},
  },

  p2: {
    species: null,
    hpPercent: 100,
    status: null,
    lastMove: null,
    boosts: createEmptyBoosts(),
    revealedMoves: {},
    previewSpecies: [],
    faintedSpecies: new Set(),
    selectedSpecies: new Set(),
    activeMoveActions: 0,
    lastActionTurn: null,
    item: null,
    ability: null,
    revealedAbilities: {},
    revealedItems: {},
    unburden: false,
    toxicCounter: 0,
    lastChoice: null,
    statusAge: 0,
    sleepSource: null,
    sleepHistory: {},
    freezeHistory: {},
    publicPokemon: {},
    publicNames: {},
    yawnDueTurn: null,
    recentSpecies: [],
    gender: null,
    volatiles: {},
  },
};

// ========================================
// AIごとの非公開情報・素早さ推定
// ========================================

// 各AIが自分側のrequestだけを保持する。
// 相手側requestの実数値は推定には使わない。
const latestRequests = {
  p1: null,
  p2: null,
};

const publicEffectHistory = { lastMove: null };
for (const state of Object.values(battleState)) {
  state.ppUsed = {};
  state.consumedItems = {};
  state.statsRaisedThisTurn = false;
  state.transformed = false;
}

// observer -> opponent species -> 候補となる素早さ実数値
const speedKnowledge = {
  p1: {},
  p2: {},
};

const speedLearningState = {
  turn: 0,
  moveEvents: [],
};

const fieldState = {
  trickRoom: false,
  gravity: false,
  weather: null,
  terrain: null,

  sides: {
    p1: {
      stealthRock: false,
      spikes: 0,
      toxicSpikes: 0,
      reflect: false,
      lightScreen: false,
      auroraVeil: false,
      stickyWeb: false,
    },

    p2: {
      stealthRock: false,
      spikes: 0,
      toxicSpikes: 0,
      reflect: false,
      lightScreen: false,
      auroraVeil: false,
      stickyWeb: false,
    },
  },
};

// ========================================
// 場の状態ヘルパー
// ========================================

function normalizeBattleEffect(value) {
  return String(value ?? '')
    .replace(/^(move|ability|item):\s*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function genderOf(value) {
  if (value === 'M' || value === 'F') {
    return value;
  }

  const parts = String(value ?? '')
    .split(',')
    .map((part) => part.trim());

  if (parts.includes('M')) {
    return 'M';
  }

  if (parts.includes('F')) {
    return 'F';
  }

  return null;
}

function itemLabel(itemId) {
  const labels = {
    airballoon: 'ふうせん',
    choicescarf: 'こだわりスカーフ',
    leftovers: 'たべのこし',
    blacksludge: 'くろいヘドロ',
    sitrusberry: 'オボンのみ',
    lumberry: 'ラムのみ',
    rockyhelmet: 'ゴツゴツメット',
    assaultvest: 'とつげきチョッキ',
    focussash: 'きあいのタスキ',
    heavydutyboots: 'あつぞこブーツ',
    lightclay: 'ひかりのねんど',
    loadeddice: 'いかさまダイス',
    ironball: 'くろいてっきゅう',
    damprock: 'しめったいわ',
    heatrock: 'あついいわ',
    smoothrock: 'さらさらいわ',
    icyrock: 'つめたいいわ',
    terrainextender: 'グランドコート',
  };

  return labels[itemId] || itemId;
}

function heldFieldTurns(moveId, item) {
  const itemId = normalizeBattleEffect(item);

  if ((moveId === 'reflect' || moveId === 'lightscreen' || moveId === 'auroraveil') && itemId === 'lightclay') {
    return 8;
  }

  if ((moveId === 'raindance' || moveId === 'sunnyday' || moveId === 'sandstorm' || moveId === 'snowscape' || moveId === 'hail') && ['damprock', 'heatrock', 'smoothrock', 'icyrock'].includes(itemId)) {
    return 8;
  }

  if (String(moveId).endsWith('terrain') && itemId === 'terrainextender') {
    return 8;
  }

  return 5;
}

function getWeatherLabel(weather) {
  const labels = {
    rain: '雨',
    sun: '晴れ',
    sand: '砂嵐',
    snow: '雪',
    hail: 'あられ',
  };

  return labels[weather] ?? 'なし';
}

function getTerrainLabel(terrain) {
  const labels = {
    electric: 'エレキフィールド',
    grassy: 'グラスフィールド',
    psychic: 'サイコフィールド',
    misty: 'ミストフィールド',
  };

  return labels[terrain] ?? 'なし';
}

function formatRemainingTurns(duration) {
  if (duration === 0) {
    return '特性で継続';
  }

  if (typeof duration === 'number' && duration > 0) {
    return `残り${duration}`;
  }

  return null;
}

function labelWithTurns(label, duration) {
  const turns = formatRemainingTurns(duration);

  if (!turns) {
    return label;
  }

  return `${label}(${turns})`;
}

// 公開されている盤面だけを、対戦中の Showdown から写す。
// 相手の努力値・持ち物・特性はここでは読まない。
function syncFieldStateFromBattle() {
  const battle = stream?.battle;

  if (!battle?.field) {
    return;
  }

  const weatherLabels = {
    raindance: 'rain',
    primordialsea: 'rain',
    sunnyday: 'sun',
    desolateland: 'sun',
    sandstorm: 'sand',
    snowscape: 'snow',
    hail: 'hail',
  };

  const terrainLabels = {
    electricterrain: 'electric',
    grassyterrain: 'grassy',
    psychicterrain: 'psychic',
    mistyterrain: 'misty',
  };

  fieldState.weather = weatherLabels[battle.field.weather] ?? null;

  fieldState.weatherTurns = fieldState.weather ? battle.field.weatherState.duration : null;

  fieldState.terrain = terrainLabels[battle.field.terrain] ?? null;

  fieldState.terrainTurns = fieldState.terrain ? battle.field.terrainState.duration : null;

  const trickRoom = battle.field.pseudoWeather.trickroom;

  fieldState.trickRoom = Boolean(trickRoom);

  fieldState.trickRoomTurns = trickRoom?.duration ?? null;

  fieldState.gravity = Boolean(battle.field.pseudoWeather.gravity);

  for (const sideId of ['p1', 'p2']) {
    const liveSide = battle.sides[sideId === 'p1' ? 0 : 1];

    const side = fieldState.sides[sideId];

    if (!liveSide || !side) {
      continue;
    }

    const conditions = liveSide.sideConditions;

    side.stealthRock = Boolean(conditions.stealthrock);

    side.spikes = conditions.spikes?.layers ?? (conditions.spikes ? 1 : 0);

    side.toxicSpikes = conditions.toxicspikes?.layers ?? (conditions.toxicspikes ? 1 : 0);

    side.reflect = Boolean(conditions.reflect);

    side.lightScreen = Boolean(conditions.lightscreen);

    side.auroraVeil = Boolean(conditions.auroraveil);

    side.tailwind = Boolean(conditions.tailwind);

    side.stickyWeb = Boolean(conditions.stickyweb);
    side.safeguard = Boolean(conditions.safeguard);

    side.reflectTurns = conditions.reflect?.duration ?? null;

    side.lightScreenTurns = conditions.lightscreen?.duration ?? null;

    side.auroraVeilTurns = conditions.auroraveil?.duration ?? null;

    side.tailwindTurns = conditions.tailwind?.duration ?? null;

    const active = liveSide.active?.[0];

    battleState[sideId].smackDown = Boolean(active?.volatiles?.smackdown);

    battleState[sideId].magnetRise = Boolean(active?.volatiles?.magnetrise);

    // プロトコルに出た状態だけ。ねむりの残りターンは非公開なので写さない。
    const publicVolatileIds = ['focusenergy', 'laserfocus', 'taunt', 'encore', 'disable', 'attract', 'confusion', 'throatchop', 'saltcure', 'curse', 'leechseed', 'substitute', 'yawn', 'healblock', 'mustrecharge', 'torment', 'imprison', 'trapped', 'lockon'];

    const nextVolatiles = {};
    if (battleState[sideId].volatiles.stockpile) nextVolatiles.stockpile = battleState[sideId].volatiles.stockpile;

    for (const id of publicVolatileIds) {
      const volatile = active?.volatiles?.[id];

      if (!volatile) {
        continue;
      }

      nextVolatiles[id] = true;

      if (id === 'encore' || id === 'disable') {
        nextVolatiles[`${id}Move`] = volatile.move || null;
      }
    }

    battleState[sideId].volatiles = nextVolatiles;
  }
}

function getWeatherDamageMultiplier(moveType, weather = fieldState.weather) {
  if (weather === 'rain') {
    if (moveType === 'Water') {
      return 1.5;
    }

    if (moveType === 'Fire') {
      return 0.5;
    }
  }

  if (weather === 'sun') {
    if (moveType === 'Fire') {
      return 1.5;
    }

    if (moveType === 'Water') {
      return 0.5;
    }
  }

  return 1;
}

function getWeatherMoveTargetWeather(moveId) {
  if (moveId === 'raindance') {
    return 'rain';
  }

  if (moveId === 'sunnyday') {
    return 'sun';
  }

  return null;
}

function estimateActiveBestAttackScoreUnderWeather(request, ownSpeciesName, opponentSpeciesName, ownBoosts, opponentBoosts, defenderPlayer, weather) {
  const activePokemon = request.side.pokemon.find((pokemon) => pokemon.active);

  const activeRequest = request.active?.[0];

  if (!activePokemon || !activeRequest) {
    return 0;
  }

  const ownPokemon = battleDex.species.get(ownSpeciesName);

  const opponentPokemon = battleDex.species.get(opponentSpeciesName);

  if (!ownPokemon.exists || !opponentPokemon.exists) {
    return 0;
  }

  let bestScore = 0;

  for (const moveRequest of activeRequest.moves) {
    if (moveRequest.disabled) {
      continue;
    }

    const move = battleDex.moves.get(moveRequest.id);

    if (!isDamagingMove(move)) {
      continue;
    }

    const damageRange = estimateBattleDamage({
      move,
      attackerSpecies: ownPokemon,
      defenderSpecies: opponentPokemon,
      attackerPokemon: activePokemon,
      attackerBoosts: ownBoosts,
      defenderBoosts: opponentBoosts,
      defenderPlayer,
      weather,
    });

    if (damageRange.immune) {
      continue;
    }

    bestScore = Math.max(bestScore, damageRange.score - damageRange.recoilPercent);
  }

  return bestScore;
}

function evaluateWeatherSetupMove(moveId, request, ownSpeciesName, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer) {
  const targetWeather = getWeatherMoveTargetWeather(moveId);

  if (!targetWeather) {
    return null;
  }

  const currentAttackScore = estimateActiveBestAttackScoreUnderWeather(request, ownSpeciesName, opponentSpeciesName, ownBoosts, opponentBoosts, defenderPlayer, fieldState.weather);

  const futureAttackScore = estimateActiveBestAttackScoreUnderWeather(request, ownSpeciesName, opponentSpeciesName, ownBoosts, opponentBoosts, defenderPlayer, targetWeather);

  const ownAttackGain = futureAttackScore - currentAttackScore;

  const activePokemon = request.side.pokemon.find((pokemon) => pokemon.active);

  const revealedMoveIds = defenderPlayer ? getRevealedMoves(defenderPlayer, opponentSpeciesName) : [];

  let currentIncoming = 0;
  let futureIncoming = 0;

  if (activePokemon) {
    for (const revealedMoveId of revealedMoveIds) {
      const currentDamage = estimateIncomingDamage(activePokemon, opponentSpeciesName, revealedMoveId, opponentBoosts, attackerPlayer, fieldState.weather);

      const futureDamage = estimateIncomingDamage(activePokemon, opponentSpeciesName, revealedMoveId, opponentBoosts, attackerPlayer, targetWeather);

      currentIncoming = Math.max(currentIncoming, currentDamage?.expectedDamagePercent ?? 0);

      futureIncoming = Math.max(futureIncoming, futureDamage?.expectedDamagePercent ?? 0);
    }
  }

  const defensiveGain = currentIncoming - futureIncoming;

  let score = 8 + ownAttackGain * 0.65 + defensiveGain * 0.55;

  const condition = activePokemon ? parseCondition(activePokemon.condition) : null;

  if (condition?.hpPercent <= 30) {
    score *= 0.45;
  } else if (condition?.hpPercent <= 50) {
    score *= 0.7;
  }

  const duration = heldFieldTurns(moveId, activePokemon?.item);

  score *= duration / STANDARD_FIELD_TURNS;

  const weatherName = getWeatherLabel(targetWeather);

  const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

  return {
    score,
    reason: `${weatherName}展開価値 ` + `攻${signed(ownAttackGain)} ` + `防${signed(defensiveGain)} ` + `約${duration}ターン`,
  };
}

function getWeatherDamageReason(moveType) {
  const multiplier = getWeatherDamageMultiplier(moveType);

  if (multiplier === 1) {
    return null;
  }

  return `${getWeatherLabel(fieldState.weather)}` + `補正×${multiplier.toFixed(1)}`;
}

function getFieldMoveRepeatReason(moveId, attackerPlayer) {
  if (!attackerPlayer) {
    return null;
  }

  const defenderPlayer = attackerPlayer === 'p1' ? 'p2' : 'p1';

  const ownSide = fieldState.sides[attackerPlayer];

  const opponentSide = fieldState.sides[defenderPlayer];

  if (!ownSide || !opponentSide) {
    return null;
  }

  if (moveId === 'raindance' && fieldState.weather === 'rain') {
    return 'すでに雨';
  }

  if (moveId === 'sunnyday' && fieldState.weather === 'sun') {
    return 'すでに晴れ';
  }

  if (moveId === 'sandstorm' && fieldState.weather === 'sand') {
    return 'すでに砂嵐';
  }

  if ((moveId === 'snowscape' || moveId === 'hail') && (fieldState.weather === 'snow' || fieldState.weather === 'hail')) {
    return 'すでに雪系天候';
  }

  if (moveId === 'stealthrock' && opponentSide.stealthRock) {
    return 'ステルスロック設置済み';
  }

  if (moveId === 'spikes' && opponentSide.spikes >= 3) {
    return 'まきびし最大(3段階)';
  }

  if (moveId === 'toxicspikes' && opponentSide.toxicSpikes >= 2) {
    return 'どくびし最大(2段階)';
  }

  if (moveId === 'reflect' && ownSide.reflect) {
    return 'リフレクター展開中';
  }

  if (moveId === 'lightscreen' && ownSide.lightScreen) {
    return 'ひかりのかべ展開中';
  }

  if (moveId === 'auroraveil' && ownSide.auroraVeil) {
    return 'オーロラベール展開中';
  }

  if (moveId === 'electricterrain' && fieldState.terrain === 'electric') {
    return 'すでにエレキフィールド';
  }

  if (moveId === 'grassyterrain' && fieldState.terrain === 'grassy') {
    return 'すでにグラスフィールド';
  }

  if (moveId === 'psychicterrain' && fieldState.terrain === 'psychic') {
    return 'すでにサイコフィールド';
  }

  if (moveId === 'mistyterrain' && fieldState.terrain === 'misty') {
    return 'すでにミストフィールド';
  }

  return null;
}

function getScreenDamageMultiplier(defenderPlayer, category) {
  if (!defenderPlayer) {
    return 1;
  }

  const side = fieldState.sides[defenderPlayer];

  if (!side) {
    return 1;
  }

  if (side.auroraVeil) {
    return 0.5;
  }

  if (category === 'Physical' && side.reflect) {
    return 0.5;
  }

  if (category === 'Special' && side.lightScreen) {
    return 0.5;
  }

  return 1;
}

function isGroundedByTraits(types, abilityId, itemId, groundedState = {}) {
  if (fieldState.gravity || groundedState.smackDown || itemId === 'ironball') {
    return true;
  }

  if (groundedState.magnetRise) {
    return false;
  }

  if (types?.includes('Flying')) {
    return false;
  }

  if (abilityId === 'levitate') {
    return false;
  }

  if (itemId === 'airballoon') {
    return false;
  }

  return true;
}

function isPokemonGrounded(pokemon) {
  if (!pokemon) {
    return true;
  }

  const species = battleDex.species.get(getPokemonSpeciesName(pokemon));

  if (!species.exists) {
    return true;
  }

  let smackDown = false;

  let magnetRise = false;

  if (pokemon.active) {
    for (const sideId of ['p1', 'p2']) {
      const activeName = battleState[sideId].species;

      const activeSpecies = activeName ? battleDex.species.get(activeName) : null;

      if (activeSpecies?.exists && activeSpecies.name === species.name) {
        smackDown = Boolean(battleState[sideId].smackDown);

        magnetRise = Boolean(battleState[sideId].magnetRise);
      }
    }
  }

  return isGroundedByTraits(species.types, normalizeBattleEffect(pokemon.ability ?? pokemon.baseAbility), normalizeBattleEffect(pokemon.item), {
    smackDown,
    magnetRise,
  });
}

function isActiveGrounded(player, species) {
  if (!species?.exists) {
    return true;
  }

  let itemId = null;

  let abilityId = null;

  if (player && battleState[player]) {
    const activeName = battleState[player].species;

    const activeSpecies = activeName ? battleDex.species.get(activeName) : null;

    if (activeSpecies?.exists && activeSpecies.name === species.name) {
      itemId = battleState[player].item;

      abilityId = battleState[player].ability;
    }

    abilityId = abilityId || battleState[player].revealedAbilities?.[species.name] || null;
  }

  const sameActive = player && battleState[player]?.species && battleDex.species.get(battleState[player].species).name === species.name;

  return isGroundedByTraits(species.types, abilityId, itemId, {
    smackDown: Boolean(sameActive && battleState[player].smackDown),
    magnetRise: Boolean(sameActive && battleState[player].magnetRise),
  });
}

function isGroundedForHazards(pokemon) {
  return isPokemonGrounded(pokemon);
}

function getTerrainStatusBlockReason(move, userGrounded, targetGrounded) {
  const affectedGrounded = move.target === 'self' ? userGrounded : targetGrounded;

  if (!affectedGrounded || !move.status) {
    return null;
  }

  if (fieldState.terrain === 'misty') {
    return 'ミストフィールドで状態異常無効';
  }

  if (fieldState.terrain === 'electric' && move.status === 'slp') {
    return 'エレキフィールドでねむり無効';
  }

  return null;
}

function getTerrainDamageMultiplier(move, attackerGrounded, defenderGrounded) {
  if (!fieldState.terrain || move.id === 'struggle') {
    return 1;
  }

  if (fieldState.terrain === 'electric' && move.type === 'Electric' && attackerGrounded) {
    return 1.3;
  }

  if (fieldState.terrain === 'grassy' && move.type === 'Grass' && attackerGrounded) {
    return 1.3;
  }

  if (fieldState.terrain === 'psychic' && move.type === 'Psychic' && attackerGrounded) {
    return 1.3;
  }

  if (fieldState.terrain === 'misty' && move.type === 'Dragon' && defenderGrounded) {
    return 0.5;
  }

  if (fieldState.terrain === 'grassy' && (move.id === 'earthquake' || move.id === 'bulldoze' || move.id === 'magnitude')) {
    return 0.5;
  }

  return 1;
}

function getTerrainFailReason(move, defenderGrounded, attackerPlayer = null, attackerPokemon = null) {
  if (fieldState.terrain === 'psychic' && targetsOpponent(move) && defenderGrounded && effectiveMovePriority(move, attackerPlayer, attackerPokemon) > 0) {
    return 'サイコフィールドで優先度無効';
  }

  return null;
}

function getWeatherDefenseModifier(statName, defenderTypes, weather) {
  if (weather === 'sand' && statName === 'spd' && defenderTypes?.includes('Rock')) {
    return {
      multiplier: 1.5,
      reason: '砂嵐で特防×1.5',
    };
  }

  if ((weather === 'snow' || weather === 'hail') && statName === 'def' && defenderTypes?.includes('Ice')) {
    return {
      multiplier: 1.5,
      reason: '雪で防御×1.5',
    };
  }

  return null;
}

function getEntryHazardRisk(player, pokemon) {
  const side = fieldState.sides[player];

  const condition = parseCondition(pokemon.condition);

  if (!side) {
    return {
      damagePercent: 0,
      penalty: 0,
      statusRisk: null,
      koRisk: null,
    };
  }

  const speciesName = getPokemonSpeciesName(pokemon);

  const species = battleDex.species.get(speciesName);

  if (normalizeBattleEffect(pokemon.item) === 'heavydutyboots') {
    return {
      damagePercent: 0,
      penalty: 0,
      statusRisk: null,
      koRisk: null,
    };
  }

  let damagePercent = 0;

  if (side.stealthRock) {
    const rockMultiplier = getTypeMultiplier('Rock', species.types);

    damagePercent += 12.5 * rockMultiplier;
  }

  const grounded = isGroundedForHazards(pokemon);

  if (grounded && side.spikes > 0) {
    if (side.spikes === 1) {
      damagePercent += 12.5;
    } else if (side.spikes === 2) {
      damagePercent += 100 / 6;
    } else {
      damagePercent += 25;
    }
  }

  let statusRisk = null;

  if (grounded && side.toxicSpikes > 0 && species.types.includes('Poison')) {
    statusRisk = 'どくびし吸収';
  } else if (grounded && side.toxicSpikes > 0 && !condition.status && !species.types.includes('Steel')) {
    statusRisk = side.toxicSpikes >= 2 ? 'どくびし(猛毒)' : 'どくびし(毒)';
  }

  let penalty = damagePercent + (statusRisk === 'どくびし吸収' ? -6 : statusRisk ? 8 : 0);

  let koRisk = null;

  if (damagePercent >= condition.hpPercent && damagePercent > 0) {
    penalty += 40;

    koRisk = '場に出た時点で倒れる危険';
  }

  return {
    damagePercent,
    penalty,
    statusRisk,
    koRisk,
  };
}

function getEndOfTurnChange(speciesName, options = {}) {
  const species = battleDex.species.get(speciesName);

  const types = species.exists ? species.types : [];

  const abilityId = options.abilityId || null;

  const itemId = options.itemId || null;

  const status = options.status || null;

  const reasons = [];

  let percent = 0;

  const magicGuard = abilityId === 'magicguard';

  const overcoat = abilityId === 'overcoat';

  const goggles = itemId === 'safetygoggles';

  if (fieldState.weather === 'sand' && !magicGuard && !overcoat && !goggles && !types.includes('Rock') && !types.includes('Ground') && !types.includes('Steel') && abilityId !== 'sandveil' && abilityId !== 'sandrush' && abilityId !== 'sandforce') {
    const chip = 6.25;

    const turns = typeof fieldState.weatherTurns === 'number' ? fieldState.weatherTurns : 1;

    const total = chip + chip * Math.max(0, turns - 1) * 0.5;

    percent += total;

    reasons.push(turns > 1 ? `砂嵐残り${turns}` : '砂嵐');
  }

  if (fieldState.weather === 'hail' && !magicGuard && !overcoat && !goggles && !types.includes('Ice') && abilityId !== 'icebody' && abilityId !== 'snowcloak') {
    const chip = 6.25;

    const turns = typeof fieldState.weatherTurns === 'number' ? fieldState.weatherTurns : 1;

    const total = chip + chip * Math.max(0, turns - 1) * 0.5;

    percent += total;

    reasons.push(turns > 1 ? `あられ残り${turns}` : 'あられ');
  }

  if (fieldState.terrain === 'grassy' && options.grounded) {
    const heal = 6.25;

    const turns = typeof fieldState.terrainTurns === 'number' ? fieldState.terrainTurns : 1;

    const total = heal + heal * Math.max(0, turns - 1) * 0.5;

    percent -= total;

    reasons.push(turns > 1 ? `グラス回復残り${turns}` : 'グラス回復');
  }

  if (itemId === 'leftovers') {
    percent -= 6.25;

    reasons.push('たべのこし');
  }

  if (itemId === 'blacksludge') {
    if (types.includes('Poison')) {
      percent -= 6.25;

      reasons.push('くろいヘドロ');
    } else if (!magicGuard) {
      percent += 12.5;

      reasons.push('くろいヘドロ');
    }
  }

  if (itemId === 'sitrusberry' && (options.hpPercent ?? 100) <= 50) {
    percent -= 25;

    reasons.push('オボンのみ');
  }

  if (['figyberry', 'iapapaberry', 'wikiberry', 'aguavberry', 'magoberry'].includes(itemId) && (options.hpPercent ?? 100) <= 25) {
    percent -= 25;

    reasons.push('半分回復のみ');
  }

  const volatiles = options.volatiles;

  if (!magicGuard && volatiles?.saltcure) {
    const chip = types.includes('Water') || types.includes('Steel') ? 25 : 12.5;

    percent += chip;

    reasons.push('しおづけ');
  }

  if (!magicGuard && volatiles?.curse) {
    percent += 25;

    reasons.push('のろい');
  }

  if (!magicGuard && volatiles?.leechseed) {
    percent += 12.5;

    reasons.push('やどりぎ');
  }

  const lumBerry = itemId === 'lumberry' && status;

  if (!lumBerry && !magicGuard && status === 'brn') {
    percent += 6.25;

    reasons.push('やけど');
  }

  if (lumBerry) {
    reasons.push('ラムのみ');
  } else if (abilityId === 'poisonheal' && (status === 'psn' || status === 'tox')) {
    percent -= 12.5;

    reasons.push('ポイズンヒール');
  } else if (!magicGuard && status === 'psn') {
    percent += 12.5;

    reasons.push('どく');
  } else if (!magicGuard && status === 'tox') {
    const stacks = Math.min(Math.max(options.toxicCounter || 1, 1), 15);

    percent += stacks * 6.25;

    reasons.push(`もうどく${stacks}`);
  }

  return {
    percent,
    reason: reasons.join('+'),
  };
}

function trickRoomPositionScore(relation) {
  if (!fieldState.trickRoom || typeof fieldState.trickRoomTurns !== 'number') {
    return 0;
  }

  if (relation === 'opponent') {
    return fieldState.trickRoomTurns * 4;
  }

  if (relation === 'own') {
    return -(fieldState.trickRoomTurns * 4);
  }

  return 0;
}

function rememberStatus(player, status, preserveToxicWhenOmitted = false) {
  const state = battleState[player];

  if (!state) {
    return;
  }

  if (!status && preserveToxicWhenOmitted && state.status === 'tox') {
    return;
  }

  const previous = state.status;

  state.status = status || null;

  if (status === 'tox') {
    if (previous !== 'tox') {
      state.toxicCounter = 1;
    }
  } else {
    state.toxicCounter = 0;
  }

  if (status !== previous) {
    state.statusAge = 0;
    state.sleepSource = null;
    if (state.species) delete state.sleepHistory[baseSpeciesName(state.species)];
    if (state.species) delete state.freezeHistory[baseSpeciesName(state.species)];
  }
}

function rememberPublicSleep(player) {
  const state = battleState[player];
  if (state?.species && state.status === 'slp') {
    state.sleepHistory[baseSpeciesName(state.species)] = { source: state.sleepSource, age: state.statusAge };
  }
}

function rememberPublicFreeze(player) {
  const state = battleState[player];
  if (state?.species && state.status === 'frz') {
    state.freezeHistory[baseSpeciesName(state.species)] = state.statusAge;
  }
}

function publicSpeciesFor(player, ident) {
  return battleState[player]?.publicNames[ident] || battleState[player]?.species;
}

function rememberPublicPokemon(player) {
  const state = battleState[player];
  if (state?.species) state.publicPokemon[baseSpeciesName(state.species)] = { hpPercent: state.hpPercent, status: state.status };
}

// ========================================
// HP・状態異常
// ========================================

function parseCondition(condition) {
  if (!condition) {
    return {
      currentHp: null,
      maxHp: null,
      hpPercent: 100,
      status: null,
    };
  }

  if (condition.includes('fnt')) {
    return {
      currentHp: 0,
      maxHp: null,
      hpPercent: 0,
      status: null,
    };
  }

  const parts = condition.split(' ');

  const hpMatch = parts[0].match(/(\d+)\/(\d+)/);

  const status = parts[1] ?? null;

  if (!hpMatch) {
    return {
      currentHp: null,
      maxHp: null,
      hpPercent: 100,
      status,
    };
  }

  const currentHp = Number(hpMatch[1]);

  const maxHp = Number(hpMatch[2]);

  return {
    currentHp,
    maxHp,
    hpPercent: (currentHp / maxHp) * 100,
    status,
  };
}

// ========================================
// 能力ランクリセット
// ========================================

function resetBoosts(player) {
  battleState[player].boosts = createEmptyBoosts();
}

// ========================================
// 公開技記憶
// ========================================

function rememberRevealedMove(player, moveName) {
  const species = battleState[player].species;

  if (!species) {
    return;
  }

  const move = battleDex.moves.get(moveName);

  if (!move.exists) {
    return;
  }

  if (!battleState[player].revealedMoves[species]) {
    battleState[player].revealedMoves[species] = new Set();
  }

  const revealedMoves = battleState[player].revealedMoves[species];

  const alreadyKnown = revealedMoves.has(move.id);

  revealedMoves.add(move.id);

  if (!alreadyKnown) {
    console.log(`${player} 公開技記憶: ` + `${species} → ${move.name}`);
  }
}

function getRevealedMoves(player, species) {
  const revealed = battleState[player]?.revealedMoves[species];

  if (!revealed) {
    return [];
  }

  return [...revealed].filter((id) => isMoveAllowed(battleDex.moves.get(id)));
}

// ========================================
// 素早さ観測学習
// ========================================

function cloneBoosts(boosts) {
  return { ...boosts };
}

function getActivePokemonFromRequest(player) {
  const request = latestRequests[player];

  if (!request?.side?.pokemon) {
    return null;
  }

  return request.side.pokemon.find((pokemon) => pokemon.active) ?? null;
}

function createLegalBaseSpeedCandidates(speciesName) {
  const species = battleDex.species.get(speciesName);

  if (!species.exists) {
    return [];
  }

  const candidates = new Set();

  for (let statPoints = 0; statPoints <= 32; statPoints++) {
    const neutralSpeed = species.baseStats.spe + statPoints + 20;

    // 素早さ下降 / 補正なし / 上昇性格
    for (const natureMultiplier of [0.9, 1, 1.1]) {
      candidates.add(Math.floor(neutralSpeed * natureMultiplier));
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function ensureSpeedKnowledge(observer, speciesName) {
  if (!speedKnowledge[observer][speciesName]) {
    speedKnowledge[observer][speciesName] = {
      candidates: createLegalBaseSpeedCandidates(speciesName),
      observations: 0,
    };
  }

  return speedKnowledge[observer][speciesName];
}

function getEffectiveCandidateRange(candidates, boostStage, status, modifiers) {
  const effective = candidates.map((speed) => getEffectiveSpeed(speed, boostStage, status, modifiers));

  return {
    minSpeed: Math.min(...effective),
    maxSpeed: Math.max(...effective),
  };
}

function applySpeedObservation(observer, opponentSpeciesName, ownEffectiveSpeed, opponentMovedFirst, opponentBoosts, opponentStatus, ownSpeciesName) {
  const knowledge = ensureSpeedKnowledge(observer, opponentSpeciesName);

  if (!knowledge.candidates.length) {
    return;
  }

  const opponent = observer === 'p1' ? 'p2' : 'p1';

  const modifiers = getPublicSpeedModifiers(opponent);

  const before = getEffectiveCandidateRange(knowledge.candidates, opponentBoosts.spe, opponentStatus, modifiers);

  const filtered = knowledge.candidates.filter((baseSpeed) => {
    const opponentSpeed = getEffectiveSpeed(baseSpeed, opponentBoosts.spe, opponentStatus, modifiers);

    // 同速の場合はランダムで前後するため、
    // 境界値は残す。
    if (opponentMovedFirst) {
      return opponentSpeed >= ownEffectiveSpeed;
    }

    return opponentSpeed <= ownEffectiveSpeed;
  });

  // Quick Claw等の未対応要因で矛盾した可能性があるため、
  // 候補が0件になる観測は採用しない。
  if (!filtered.length) {
    console.log(`${observer} 素早さ観測保留: ` + `${opponentSpeciesName} ` + `（既存推定と矛盾）`);
    return;
  }

  const after = getEffectiveCandidateRange(filtered, opponentBoosts.spe, opponentStatus, modifiers);

  const relationText = opponentMovedFirst ? `${opponentSpeciesName}が先` : `${ownSpeciesName}が先`;

  if (filtered.length === knowledge.candidates.length) {
    console.log(`${observer} 素早さ観測: ` + `${opponentSpeciesName} ` + `${before.minSpeed}〜${before.maxSpeed}` + `（${relationText} / 絞り込みなし）`);
    return;
  }

  knowledge.candidates = filtered;
  knowledge.observations += 1;

  console.log(`${observer} 素早さ学習: ` + `${opponentSpeciesName} ` + `${before.minSpeed}〜${before.maxSpeed}` + ` → ` + `${after.minSpeed}〜${after.maxSpeed}` + `（${relationText}）`);
}

function learnFromObservedMoveOrder() {
  if (speedLearningState.moveEvents.length !== 2 || fieldState.trickRoom) {
    return;
  }

  const [first, second] = speedLearningState.moveEvents;

  if (first.player === second.player) {
    return;
  }

  const firstMove = battleDex.moves.get(first.moveName);

  const secondMove = battleDex.moves.get(second.moveName);

  // まずは誤推定を避けるため、
  // 優先度0の攻撃技同士だけを学習対象にする。
  if (!firstMove.exists || !secondMove.exists || firstMove.priority !== 0 || secondMove.priority !== 0 || firstMove.category === 'Status' || secondMove.category === 'Status') {
    return;
  }

  for (const observer of ['p1', 'p2']) {
    const opponent = observer === 'p1' ? 'p2' : 'p1';

    const ownEvent = speedLearningState.moveEvents.find((event) => event.player === observer);

    const opponentEvent = speedLearningState.moveEvents.find((event) => event.player === opponent);

    if (!ownEvent?.species || !opponentEvent?.species || ownEvent.baseSpeed == null) {
      continue;
    }

    const ownEffectiveSpeed = getEffectiveSpeed(ownEvent.baseSpeed, ownEvent.boosts.spe, ownEvent.status, getPublicSpeedModifiers(observer));

    const opponentMovedFirst = first.player === opponent;

    applySpeedObservation(observer, opponentEvent.species, ownEffectiveSpeed, opponentMovedFirst, opponentEvent.boosts, opponentEvent.status, ownEvent.species);
  }
}

function recordMoveForSpeedLearning(player, moveName) {
  // 同じプレイヤーのmoveが再び来たら、
  // 前ターンの観測が残っている可能性があるため
  // 新しい観測としてリセットする。
  if (speedLearningState.moveEvents.some((event) => event.player === player)) {
    speedLearningState.moveEvents = [];
  }

  const activePokemon = getActivePokemonFromRequest(player);

  speedLearningState.moveEvents.push({
    player,
    moveName,
    species: battleState[player].species,
    status: battleState[player].status,
    boosts: cloneBoosts(battleState[player].boosts),
    baseSpeed: activePokemon?.stats?.spe ?? null,
  });

  if (speedLearningState.moveEvents.length === 2) {
    learnFromObservedMoveOrder();
  }
}

// ========================================
// Showdownログ解析
// ========================================

function updateBattleState(output) {
  const lines = output.split('\n');

  for (const line of lines) {
    const parts = line.split('|');

    // 無効・回復・反動などの原因欄に現れた特性・持ち物も公開情報。
    for (const kind of ['ability', 'item']) {
      const cause = parts.find((part) => part.startsWith(`[from] ${kind}: `)) || (['-activate', 'cant', '-immune'].includes(parts[1]) ? parts.find((part) => part.startsWith(`${kind}: `)) : null);
      if (!cause) continue;
      const holder = parts.find((part) => part.startsWith('[of] '))?.slice(5) || parts[2];
      const player = holder?.slice(0, 2);
      const state = battleState[player];
      const species = publicSpeciesFor(player, holder);
      if (!state || !species) continue;
      const id = normalizeBattleEffect(cause.replace(/^\[from\] /, ''));
      if (kind === 'ability') {
        state.revealedAbilities[species] = id;
        if (species === state.species) state.ability = id;
      } else {
        state.revealedItems[baseSpeciesName(species)] = id;
        if (species === state.species) state.item = id;
      }
    }

    // ====================================
    // Team Preview の公開情報
    // ====================================

    if (parts[1] === 'clearpoke') {
      battleState.p1.previewSpecies = [];
      battleState.p2.previewSpecies = [];
      battleState.p1.faintedSpecies.clear();
      battleState.p2.faintedSpecies.clear();
      battleState.p1.selectedSpecies.clear();
      battleState.p2.selectedSpecies.clear();
      for (const state of Object.values(battleState)) {
        state.sleepHistory = {};
        state.freezeHistory = {};
        state.publicPokemon = {};
        state.publicNames = {};
        state.yawnDueTurn = null;
        state.revealedMoves = {};
        state.revealedAbilities = {};
        state.revealedItems = {};
        state.ability = null;
        state.item = null;
        state.volatiles = {};
        state.sleepSource = null;
        state.statusAge = 0;
        state.ppUsed = {};
        state.consumedItems = {};
        state.statsRaisedThisTurn = false;
        state.transformed = false;
        state.protectionChain = null;
      }
      publicEffectHistory.lastMove = null;
      fieldState.fairyLockUntil = null;
    }

    if (parts[1] === 'poke') {
      const previewPlayer = parts[2]?.slice(0, 2);

      if (battleState[previewPlayer]) {
        const rawSpecies = parts[3]?.split(',')[0].trim();

        if (rawSpecies) {
          const normalized = rawSpecies.replace(/-\*$/, '');

          const speciesData = battleDex.species.get(normalized);

          const speciesName = speciesData.exists ? speciesData.name : normalized;

          if (!battleState[previewPlayer].previewSpecies.includes(speciesName)) {
            battleState[previewPlayer].previewSpecies.push(speciesName);
          }
        }
      }
    }

    // 新しいターンでは行動順観測をリセット
    if (parts[1] === 'turn') {
      speedLearningState.turn = Number(parts[2]);
      speedLearningState.moveEvents = [];

      for (const sideId of ['p1', 'p2']) {
        battleState[sideId].statsRaisedThisTurn = false;
        if (battleState[sideId].status === 'tox') {
          battleState[sideId].toxicCounter = Math.min((battleState[sideId].toxicCounter || 1) + 1, 15);
        }
      }
    }

    if (parts[1] === 'cant') {
      const player = parts[2]?.slice(0, 2);
      const reason = normalizeBattleEffect(parts[3]);
      rememberPublicMoveAction(player);
      if (battleState[player]) battleState[player].protectionChain = null;

      if (battleState[player] && (reason === 'slp' || reason === 'frz' || reason === 'par')) {
        battleState[player].statusAge = (battleState[player].statusAge || 0) + 1;
        if (reason === 'slp') rememberPublicSleep(player);
        if (reason === 'frz') rememberPublicFreeze(player);
      }
    }

    if ((parts[1] === '-start' || parts[1] === '-end') && normalizeBattleEffect(parts[3]) === 'yawn') {
      const state = battleState[parts[2]?.slice(0, 2)];
      if (state) {
        if (parts[1] === '-start') {
          state.volatiles.yawn = true;
          state.yawnDueTurn = speedLearningState.turn + 1;
        } else {
          delete state.volatiles.yawn;
          state.yawnDueTurn = null;
        }
      }
    }

    if (parts[1] === '-start' || parts[1] === '-end') {
      const state = battleState[parts[2]?.slice(0, 2)];
      const id = normalizeBattleEffect(parts[3]);
      if (state && /^stockpile[123]$/.test(id)) {
        const old = state.volatiles.stockpile;
        state.volatiles.stockpile = { layers: Number(id.slice(-1)), def: old?.def || 0, spd: old?.spd || 0, pending: { def: true, spd: true } };
      } else if (state && id === 'stockpile') {
        delete state.volatiles.stockpile;
      } else if (state && ['torment', 'imprison', 'trapped', 'lockon', 'taunt', 'leechseed', 'yawn', 'confusion', 'attract', 'saltcure', 'curse', 'throatchop'].includes(id)) {
        if (parts[1] === '-start') state.volatiles[id] = true;
        else delete state.volatiles[id];
      }
    }
    if (parts[1] === '-singleturn') {
      const state = battleState[parts[2]?.slice(0, 2)];
      if (state && battleDex.moves.get(normalizeBattleEffect(parts[3])).stallingMove) {
        const previous = state.protectionChain;
        if (previous?.turn !== speedLearningState.turn) state.protectionChain = {
          count: previous?.turn === speedLearningState.turn - 1 ? previous.count + 1 : 1, turn: speedLearningState.turn,
        };
      }
    }
    if (parts[1] === '-fail') {
      const state = battleState[parts[2]?.slice(0, 2)];
      if (state && battleDex.moves.get(state.lastMove).stallingMove) state.protectionChain = null;
    }
    if (parts[1] === '-transform') {
      const state = battleState[parts[2]?.slice(0, 2)];
      if (state) state.transformed = true;
    }
    if (parts[1] === '-fieldactivate' && normalizeBattleEffect(parts[2]) === 'fairylock') fieldState.fairyLockUntil = speedLearningState.turn + 1;
    if (parts[1] === '-activate' && ['spite', 'eeriespell'].includes(normalizeBattleEffect(parts[3]))) {
      const state = battleState[parts[2]?.slice(0, 2)];
      const id = battleDex.moves.get(parts[4]).id;
      if (state && id) {
        const key = baseSpeciesName(state.species);
        state.ppUsed[key] ||= {};
        state.ppUsed[key][id] = (state.ppUsed[key][id] || 0) + (Number(parts[5]) || 0);
      }
    }
    if (parts[1] === '-activate' && normalizeBattleEffect(parts[3]) === 'leppaberry') {
      const state = battleState[parts[2]?.slice(0, 2)];
      const id = battleDex.moves.get(parts[4]).id;
      if (state?.ppUsed[baseSpeciesName(state.species)] && id) {
        const used = state.ppUsed[baseSpeciesName(state.species)];
        used[id] = Math.max(0, (used[id] || 0) - (state.ability === 'ripen' ? 20 : 10));
      }
    }

    // ====================================
    // 天候
    // ====================================

    if (parts[1] === '-weather') {
      const weatherId = normalizeBattleEffect(parts[2]);

      let nextWeather = null;

      if (weatherId === 'raindance' || weatherId === 'primordialsea') {
        nextWeather = 'rain';
      } else if (weatherId === 'sunnyday' || weatherId === 'desolateland') {
        nextWeather = 'sun';
      } else if (weatherId === 'sandstorm') {
        nextWeather = 'sand';
      } else if (weatherId === 'snow' || weatherId === 'snowscape') {
        nextWeather = 'snow';
      } else if (weatherId === 'hail') {
        nextWeather = 'hail';
      }

      if (fieldState.weather !== nextWeather) {
        fieldState.weather = nextWeather;

        console.log(`場の状態: 天候=${getWeatherLabel(nextWeather)}`);
      }
    }

    // ====================================
    // フィールド / トリックルーム
    // ====================================

    if (parts[1] === '-fieldstart') {
      const effectId = normalizeBattleEffect(parts[2]);

      if (effectId === 'trickroom') {
        fieldState.trickRoom = true;

        console.log('場の状態: トリックルーム開始');
      }

      const terrainMap = {
        electricterrain: 'electric',
        grassyterrain: 'grassy',
        psychicterrain: 'psychic',
        mistyterrain: 'misty',
      };

      if (terrainMap[effectId]) {
        fieldState.terrain = terrainMap[effectId];

        console.log(`場の状態: ${getTerrainLabel(fieldState.terrain)}開始`);
      }
    }

    if (parts[1] === '-fieldend') {
      const effectId = normalizeBattleEffect(parts[2]);

      if (effectId === 'trickroom') {
        fieldState.trickRoom = false;

        console.log('場の状態: トリックルーム終了');
      }

      if (['electricterrain', 'grassyterrain', 'psychicterrain', 'mistyterrain'].includes(effectId)) {
        fieldState.terrain = null;

        console.log('場の状態: フィールド終了');
      }
    }

    // ====================================
    // 設置技・壁
    // ====================================

    if (parts[1] === '-sidestart') {
      const player = parts[2]?.slice(0, 2);

      const side = fieldState.sides[player];

      const effectId = normalizeBattleEffect(parts[3]);

      if (side) {
        if (effectId === 'stealthrock') {
          side.stealthRock = true;
        } else if (effectId === 'spikes') {
          side.spikes = Math.min(3, side.spikes + 1);
        } else if (effectId === 'toxicspikes') {
          side.toxicSpikes = Math.min(2, side.toxicSpikes + 1);
        } else if (effectId === 'reflect') {
          side.reflect = true;
        } else if (effectId === 'lightscreen') {
          side.lightScreen = true;
        } else if (effectId === 'auroraveil') {
          side.auroraVeil = true;
        } else if (effectId === 'stickyweb') {
          side.stickyWeb = true;
        } else if (effectId === 'safeguard') {
          side.safeguard = true;
        }

        console.log(`${player} 場の状態更新: ` + `岩${side.stealthRock ? '有' : '無'} ` + `まきびし${side.spikes} ` + `どくびし${side.toxicSpikes} ` + `ねばねば${side.stickyWeb ? '有' : '無'} ` + `リフレクター${side.reflect ? '有' : '無'} ` + `光の壁${side.lightScreen ? '有' : '無'} ` + `オーロラベール${side.auroraVeil ? '有' : '無'}`);
      }
    }

    if (parts[1] === '-sideend') {
      const player = parts[2]?.slice(0, 2);

      const side = fieldState.sides[player];

      const effectId = normalizeBattleEffect(parts[3]);

      if (side) {
        if (effectId === 'stealthrock') {
          side.stealthRock = false;
        } else if (effectId === 'spikes') {
          side.spikes = 0;
        } else if (effectId === 'toxicspikes') {
          side.toxicSpikes = 0;
        } else if (effectId === 'reflect') {
          side.reflect = false;
        } else if (effectId === 'lightscreen') {
          side.lightScreen = false;
        } else if (effectId === 'auroraveil') {
          side.auroraVeil = false;
        } else if (effectId === 'stickyweb') {
          side.stickyWeb = false;
        } else if (effectId === 'safeguard') {
          side.safeguard = false;
        }

        console.log(`${player} 場の状態更新: ` + `岩${side.stealthRock ? '有' : '無'} ` + `まきびし${side.spikes} ` + `どくびし${side.toxicSpikes} ` + `ねばねば${side.stickyWeb ? '有' : '無'} ` + `リフレクター${side.reflect ? '有' : '無'} ` + `光の壁${side.lightScreen ? '有' : '無'} ` + `オーロラベール${side.auroraVeil ? '有' : '無'}`);
      }
    }

    if (parts[1] === '-swapsideconditions') {
      const oldP1 = fieldState.sides.p1;

      fieldState.sides.p1 = fieldState.sides.p2;

      fieldState.sides.p2 = oldP1;

      console.log('場の状態: 両サイドの設置技・壁を入れ替え');
    }

    if (parts[1] === 'faint') {
      const player = parts[2]?.slice(0, 2);
      const state = battleState[player];

      // ログの表示名はニックネームの場合があるため、登場時の種族を使う。
      if (state?.species) {
        state.faintedSpecies.add(baseSpeciesName(state.species));
        state.hpPercent = 0;
        rememberPublicPokemon(player);
      }
    }

    if (parts[1] === 'switch' || parts[1] === 'drag') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const condition = parseCondition(parts[4]);

      rememberPublicSleep(player);
      rememberPublicFreeze(player);
      if (Object.values(battleState[player].publicNames).includes(battleState[player].species)) rememberPublicPokemon(player);
      const outgoing = battleState[player].publicPokemon[baseSpeciesName(battleState[player].species)];
      if (outgoing && outgoing.hpPercent > 0) outgoing.switchedOut = true;
      battleState[player].species = parts[3]?.split(',')[0].trim();
      battleState[player].publicNames[parts[2]] = battleState[player].species;
      const sleep = battleState[player].sleepHistory[baseSpeciesName(battleState[player].species)];
      const frozenAge = battleState[player].freezeHistory[baseSpeciesName(battleState[player].species)];
      battleState[player].selectedSpecies.add(baseSpeciesName(battleState[player].species));
      battleState[player].activeMoveActions = 0;
      battleState[player].lastActionTurn = null;

      battleState[player].gender = genderOf(parts[3]);

      battleState[player].volatiles = {};
      battleState[player].statsRaisedThisTurn = false;
      battleState[player].transformed = false;
      battleState[player].yawnDueTurn = null;

      // 復活して再登場した場合は、再び交代候補にできる。
      if (condition.hpPercent > 0) {
        battleState[player].faintedSpecies.delete(baseSpeciesName(battleState[player].species));
      }

      battleState[player].hpPercent = condition.hpPercent;

      battleState[player].ability = battleState[player].revealedAbilities[battleState[player].species] || null;

      battleState[player].unburden = false;

      rememberStatus(player, condition.status);
      battleState[player].statusAge = condition.status === 'slp' ? sleep?.age || 0 : condition.status === 'frz' ? frozenAge || 0 : 0;
      battleState[player].sleepSource = condition.status === 'slp' ? sleep?.source || null : null;
      rememberPublicSleep(player);
      rememberPublicFreeze(player);

      resetBoosts(player);
      battleState[player].lastMove = null;
      battleState[player].protectionChain = null;
      battleState[player].item = battleState[player].revealedItems[baseSpeciesName(battleState[player].species)] || null;
      rememberPublicPokemon(player);
    }

    if (parts[1] === '-item' || parts[1] === '-enditem') {
      const player = parts[2]?.slice(0, 2);

      const itemId = normalizeBattleEffect(parts[3]);

      const state = battleState[player];

      if (state && itemId) {
        if (parts[1] === '-item') {
          if (parts.includes('[from] move: Recycle')) delete state.consumedItems[baseSpeciesName(state.species)];
          state.revealedItems[baseSpeciesName(state.species)] = itemId;
          if (state.item !== itemId) {
            state.item = itemId;

            console.log(`${player} 持ち物公開: ${itemLabel(itemId)}`);
          }
        } else {
          if (parts.includes('[eat]') || !parts.some((part) => part.startsWith('[from]'))) state.consumedItems[baseSpeciesName(state.species)] = itemId;
          state.revealedItems[baseSpeciesName(state.species)] = null;
          state.item = null;

          if (itemId === 'airballoon') {
            console.log(`${player} ふうせんが割れた`);
          }

          if (state.ability === 'unburden') {
            state.unburden = true;

            console.log(`${player} かるわざ`);
          }
        }
      }
    }

    if (parts[1] === '-mega') {
      const state = battleState[parts[2]?.slice(0, 2)];
      const item = normalizeBattleEffect(parts[4]);
      if (state && item) {
        state.item = item;
        state.revealedItems[baseSpeciesName(state.species)] = item;
      }
    }

    if (parts[1] === '-ability') {
      const player = parts[2]?.slice(0, 2);

      const state = battleState[player];

      const abilityId = normalizeBattleEffect(parts[3]);

      if (state && abilityId) {
        const species = state.species;

        state.ability = abilityId;

        if (species && state.revealedAbilities[species] !== abilityId) {
          state.revealedAbilities[species] = abilityId;

          console.log(`${player} 特性公開: ${parts[3]}`);
        }

        if (abilityId === 'unburden' && !state.item) {
          state.unburden = true;
        }
      }
    }

    if (parts[1] === '-damage' || parts[1] === '-heal') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const condition = parseCondition(parts[3]);
      const species = publicSpeciesFor(player, parts[2]);
      if (species && species !== battleState[player].species) {
        battleState[player].publicPokemon[baseSpeciesName(species)] = { hpPercent: condition.hpPercent, status: condition.status };
        continue;
      }
      battleState[player].hpPercent = condition.hpPercent;

      rememberStatus(player, condition.status, true);
      rememberPublicPokemon(player);
    }

    if (parts[1] === '-status') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      rememberStatus(player, parts[3]);
      if (parts[3] === 'slp') {
        battleState[player].sleepSource = parts.includes('[from] move: Rest') ? 'rest' : null;
        rememberPublicSleep(player);
      }
      if (parts[3] === 'frz') rememberPublicFreeze(player);
      rememberPublicPokemon(player);

      console.log(`${player} 状態異常: ${parts[3]}`);
    }

    if (parts[1] === '-curestatus') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const species = publicSpeciesFor(player, parts[2]);
      if (species && species !== battleState[player].species) {
        const key = baseSpeciesName(species);
        if (battleState[player].publicPokemon[key]) battleState[player].publicPokemon[key].status = null;
        delete battleState[player].sleepHistory[key];
        delete battleState[player].freezeHistory[key];
        continue;
      }
      rememberStatus(player, null);
      rememberPublicPokemon(player);

      console.log(`${player} 状態異常が治りました`);
    }

    if (parts[1] === 'move') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const move = battleDex.moves.get(parts[3]);
      if (!move.stallingMove) battleState[player].protectionChain = null;
      for (const state of Object.values(battleState)) if (state.volatiles.stockpile) state.volatiles.stockpile.pending = {};
      if (!parts.some((part) => part.startsWith('[from]'))) rememberPublicMoveAction(player);

      recordMoveForSpeedLearning(player, parts[3]);

      battleState[player].lastMove = move.id;
      publicEffectHistory.lastMove = { id: move.id, player, turn: speedLearningState.turn };
      if (!parts.some((part) => part.startsWith('[from]')) || parts.includes('[from] move: Instruct')) {
        const state = battleState[player];
        const key = baseSpeciesName(state.species);
        state.ppUsed[key] ||= {};
        const foe = player === 'p1' ? 'p2' : 'p1';
        const pressure = battleState[foe].ability === 'pressure' && targetsOpponent(move) ? 2 : 1;
        state.ppUsed[key][move.id] = (state.ppUsed[key][move.id] || 0) + pressure;
      }

      rememberRevealedMove(player, parts[3]);
    }

    if (parts[1] === '-boost') {
      const player = parts[2]?.slice(0, 2);

      const stat = parts[3];

      const amount = Number(parts[4]);

      if (!battleState[player] || !(stat in battleState[player].boosts)) {
        continue;
      }

      battleState[player].boosts[stat] = clampBoost(battleState[player].boosts[stat] + amount);
      if (amount > 0) battleState[player].statsRaisedThisTurn = true;
      if (battleState[player].volatiles.stockpile?.pending?.[stat]) {
        battleState[player].volatiles.stockpile[stat]--;
        battleState[player].volatiles.stockpile.pending[stat] = false;
      }

      console.log(`${player} 能力変化: ` + `${stat} +${amount} → ` + `${battleState[player].boosts[stat]}`);
    }

    if (parts[1] === '-unboost') {
      const player = parts[2]?.slice(0, 2);

      const stat = parts[3];

      const amount = Number(parts[4]);

      if (!battleState[player] || !(stat in battleState[player].boosts)) {
        continue;
      }

      battleState[player].boosts[stat] = clampBoost(battleState[player].boosts[stat] - amount);
      if (battleState[player].volatiles.stockpile?.pending?.[stat]) {
        battleState[player].volatiles.stockpile[stat]--;
        battleState[player].volatiles.stockpile.pending[stat] = false;
      }

      console.log(`${player} 能力変化: ` + `${stat} -${amount} → ` + `${battleState[player].boosts[stat]}`);
    }

    if (parts[1] === '-setboost') {
      const player = parts[2]?.slice(0, 2);

      const stat = parts[3];

      const amount = Number(parts[4]);

      if (!battleState[player] || !(stat in battleState[player].boosts)) {
        continue;
      }

      if (amount > battleState[player].boosts[stat]) battleState[player].statsRaisedThisTurn = true;
      battleState[player].boosts[stat] = clampBoost(amount);
    }

    if (parts[1] === '-clearboost') {
      const player = parts[2]?.slice(0, 2);

      if (battleState[player]) {
        resetBoosts(player);
      }
    }

    if (parts[1] === '-clearallboost') {
      resetBoosts('p1');
      resetBoosts('p2');
    }

    if (parts[1] === '-clearpositiveboost') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      for (const stat of Object.keys(battleState[player].boosts)) {
        if (battleState[player].boosts[stat] > 0) {
          battleState[player].boosts[stat] = 0;
        }
      }
    }

    if (parts[1] === '-clearnegativeboost') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      for (const stat of Object.keys(battleState[player].boosts)) {
        if (battleState[player].boosts[stat] < 0) {
          battleState[player].boosts[stat] = 0;
        }
      }
    }

    if (parts[1] === '-invertboost') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      for (const stat of Object.keys(battleState[player].boosts)) {
        battleState[player].boosts[stat] *= -1;
      }
    }

    if (parts[1] === '-formechange' || parts[1] === 'detailschange') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const oldSpecies = battleState[player].species;

      const newSpecies = parts[3]?.split(',')[0].trim();

      if (oldSpecies && battleState[player].revealedMoves[oldSpecies]) {
        battleState[player].revealedMoves[newSpecies] = battleState[player].revealedMoves[oldSpecies];
      }

      battleState[player].species = newSpecies;
      for (const ident of Object.keys(battleState[player].publicNames)) {
        if (battleState[player].publicNames[ident] === oldSpecies) battleState[player].publicNames[ident] = newSpecies;
      }
      rememberPublicPokemon(player);

      // メガシンカ後の特性は公開されたフォルムから一意に決まる。
      const form = battleDex.species.get(newSpecies);
      if (form.isMega) {
        const ability = normalizeBattleEffect(form.abilities[0]);
        battleState[player].ability = ability;
        battleState[player].revealedAbilities[newSpecies] = ability;
        battleState[player].previewSpecies = battleState[player].previewSpecies.map((name) => baseSpeciesName(name) === form.baseSpecies ? newSpecies : name);
      }
    }
  }
}

// ========================================
// ダメージ割合の幅
//
// 数値は Showdown の getDamage を使う。
// 自分の能力・特性・持ち物は request の実数値。
// 相手は公開情報だけを使い、努力値の端は
// 0ポイント下降性格と32ポイント上昇性格。
// HP32と防御32は同時に合法なので、
// 与ダメージの端は「最も硬い」「最も柔らかい」
// の2点で足りる。
// 最小は85%乱数、最大は100%乱数。
// わるあがきはタイプなし。反動は評価点からだけ引く。
// ========================================

const STAT_POINT_MAX = 32;

const NATURE_UP = {
  atk: 'Adamant',
  def: 'Bold',
  spa: 'Modest',
  spd: 'Calm',
  spe: 'Jolly',
};

const NATURE_DOWN = {
  atk: 'Modest',
  def: 'Lonely',
  spa: 'Adamant',
  spd: 'Naughty',
  spe: 'Brave',
};

const SIM_WEATHER_ID = {
  rain: 'raindance',
  sun: 'sunnyday',
  sand: 'sandstorm',
  snow: 'snowscape',
  hail: 'hail',
};

function getStruggleRecoilPercent(maxHp) {
  if (!maxHp) {
    return 25;
  }

  return (Math.floor(maxHp / 4) / maxHp) * 100;
}

function currentBattleLevel() {
  const level = stream?.battle?.sides?.[0]?.pokemon?.[0]?.level;

  return level || BATTLE_LEVEL;
}

function emptyEvs() {
  return {
    hp: 0,
    atk: 0,
    def: 0,
    spa: 0,
    spd: 0,
    spe: 0,
  };
}

function spreadForEndpoint(statName, endpoint) {
  const evs = emptyEvs();

  if (endpoint === 'max') {
    evs.hp = STAT_POINT_MAX;

    if (statName && statName !== 'hp') {
      evs[statName] = STAT_POINT_MAX;
    }

    return {
      evs,
      nature: NATURE_UP[statName] || 'Serious',
    };
  }

  return {
    evs,
    nature: NATURE_DOWN[statName] || 'Serious',
  };
}

function knownCombatant(pokemon, boosts) {
  const condition = parseCondition(pokemon.condition);

  const stats = pokemon.stats;

  return {
    species: getPokemonSpeciesName(pokemon),
    ability: normalizeBattleEffect(pokemon.ability),
    item: normalizeBattleEffect(pokemon.item),
    status: condition.status,
    boosts: {
      ...createEmptyBoosts(),
      ...(boosts ?? {}),
    },
    hpPercent: condition.hpPercent,
    level: pokemon.level || Number(pokemon.details?.match(/(?:^|, )L(\d+)/)?.[1]) || currentBattleLevel(),
    moves: pokemon.moves,
    active: pokemon.active,
    exact:
      stats && condition.maxHp
        ? {
            hp: condition.maxHp,
            atk: stats.atk,
            def: stats.def,
            spa: stats.spa,
            spd: stats.spd,
            spe: stats.spe,
          }
        : null,
    evs: emptyEvs(),
    nature: 'Serious',
  };
}

function revealedAbilityFor(player, speciesName) {
  const state = player ? battleState[player] : null;

  if (!state) {
    return '';
  }

  const activeName = state.species ? battleDex.species.get(state.species).name : null;

  if (activeName === speciesName && state.ability) {
    return state.ability;
  }

  return state.revealedAbilities?.[speciesName] || '';
}

function revealedItemFor(player, speciesName) {
  const state = player ? battleState[player] : null;

  if (!state) {
    return '';
  }

  if (state.species && battleDex.species.get(state.species).name === speciesName) {
    return state.item || '';
  }
  return state.revealedItems[baseSpeciesName(speciesName)] || '';
}

function rangedCombatant(species, statName, endpoint, boosts, player) {
  const spread = spreadForEndpoint(statName, endpoint);

  const state = player ? battleState[player] : null;
  const isActive = state?.species === species.name;

  return {
    species: species.name,
    ability: revealedAbilityFor(player, species.name),
    item: revealedItemFor(player, species.name),
    status: isActive ? state.status : state?.publicPokemon[baseSpeciesName(species.name)]?.status || null,
    boosts: {
      ...createEmptyBoosts(),
      ...(boosts ?? {}),
    },
    hpPercent: isActive ? state.hpPercent : state?.publicPokemon[baseSpeciesName(species.name)]?.hpPercent ?? 100,
    canRegenerate: !isActive && !!state?.publicPokemon[baseSpeciesName(species.name)]?.switchedOut,
    exact: null,
    evs: spread.evs,
    nature: spread.nature,
  };
}

function toCalcSet(combatant) {
  return {
    species: combatant.species,
    ability: combatant.ability || '',
    item: combatant.item || '',
    moves: combatant.moves?.length ? combatant.moves : ['Tackle'],
    nature: combatant.nature || 'Serious',
    evs: combatant.evs || emptyEvs(),
    level: combatant.level || currentBattleLevel(),
  };
}

function applyCombatant(mon, combatant) {
  mon.status = combatant.status || '';

  mon.boosts = {
    ...createEmptyBoosts(),
    ...combatant.boosts,
  };

  if (combatant.exact) {
    mon.maxhp = combatant.exact.hp;
    mon.baseMaxhp = combatant.exact.hp;

    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
      mon.storedStats[stat] = combatant.exact[stat];
    }
  } else {
    mon.set.evs = {
      ...emptyEvs(),
      ...combatant.evs,
    };
    mon.set.nature = combatant.nature;
    mon.maxhp = 0;
    mon.setSpecies(mon.species, null);
  }

  // 最後に見えたHPを保持し、交代時の再生力は候補の特性ごとに適用する。
  const percent = Math.min(100, (combatant.hpPercent ?? 100) + (combatant.canRegenerate && combatant.ability === 'regenerator' ? 100 / 3 : 0));

  mon.hp = Math.max(1, Math.round((mon.maxhp * percent) / 100));
}

function copyLiveField(calc, source, publicOnly = false) {
  const live = publicOnly ? null : stream?.battle;

  if (!live?.field) {
    useWeather(calc, fieldState.weather, source);
    if (fieldState.terrain) calc.field.setTerrain(`${fieldState.terrain}terrain`, source);
    if (fieldState.gravity) calc.field.addPseudoWeather('gravity', source);
    return;
  }

  if (live.field.weather) {
    calc.field.setWeather(live.field.weather, source);
  }

  if (live.field.terrain) {
    calc.field.setTerrain(live.field.terrain, source);
  }
  if (fieldState.gravity) calc.field.addPseudoWeather('gravity', source);

  for (let i = 0; i < 2; i++) {
    const from = live.sides[i];
    const to = calc.sides[i];

    if (!from || !to) {
      continue;
    }

    for (const id of Object.keys(from.sideConditions)) {
      to.addSideCondition(id, source);

      const fromState = from.sideConditions[id];
      const toState = to.sideConditions[id];

      if (fromState?.layers && toState) {
        toState.layers = fromState.layers;
      }
    }
  }
}

function useWeather(calc, weatherLabel, source) {
  const liveLabels = {
    raindance: 'rain',
    primordialsea: 'rain',
    sunnyday: 'sun',
    desolateland: 'sun',
    sandstorm: 'sand',
    snowscape: 'snow',
    hail: 'hail',
  };

  if (liveLabels[calc.field.weather] === weatherLabel) {
    return;
  }

  if (calc.field.weather) {
    calc.field.clearWeather();
  }

  const desired = SIM_WEATHER_ID[weatherLabel];

  if (desired) {
    calc.field.setWeather(desired, source);
  }
}

function hitSpread(move, attacker, hitChance = move.accuracy === true ? 1 : move.accuracy / 100) {
  const spec = move.multihit;

  if (!spec) {
    return [
      {
        hits: 1,
        probability: 1,
      },
    ];
  }

  const max = typeof spec === 'number' ? spec : spec[1];
  const min = typeof spec === 'number' ? spec : spec[0];

  const skillLink = attacker?.hasAbility ? attacker.hasAbility('skilllink') : attacker?.ability === 'skilllink';
  const loadedDice = attacker?.hasItem ? attacker.hasItem('loadeddice') : attacker?.item === 'loadeddice';
  if (typeof spec === 'number' && spec === 10 && loadedDice) {
    return [4, 5, 6, 7, 8, 9, 10].map((hits) => ({ hits, probability: 1 / 7 }));
  }
  if (skillLink) {
    return [
      {
        hits: max,
        probability: 1,
      },
    ];
  }

  if (move.multiaccuracy && !loadedDice) {
    const accuracy = hitChance;
    const rows = [];
    let reached = 1;

    for (let hits = 1; hits < max; hits++) {
      rows.push({
        hits,
        probability: reached * (1 - accuracy),
      });

      reached *= accuracy;
    }

    rows.push({
      hits: max,
      probability: reached,
    });

    return rows;
  }

  if (min === 2 && max === 5) {
    if (loadedDice) {
      return [
        { hits: 4, probability: 0.5 },
        { hits: 5, probability: 0.5 },
      ];
    }

    return [
      { hits: 2, probability: 0.35 },
      { hits: 3, probability: 0.35 },
      { hits: 4, probability: 0.15 },
      { hits: 5, probability: 0.15 },
    ];
  }

  if (typeof spec === 'number') {
    return [
      {
        hits: spec,
        probability: 1,
      },
    ];
  }

  const span = max - min + 1;

  return Array.from({ length: span }, (_, index) => ({
    hits: min + index,
    probability: 1 / span,
  }));
}

function hitBounds(move, attacker) {
  const spread = hitSpread(move, attacker);
  const counts = spread.map((row) => row.hits);

  return {
    min: Math.min(...counts),
    max: Math.max(...counts),
    expected: spread.reduce((sum, row) => sum + row.hits * row.probability, 0),
  };
}

function resistBerryHalve(item, moveType, defenderTypes) {
  const berries = {
    occaberry: 'Fire',
    passhoberry: 'Water',
    wacanberry: 'Electric',
    rindoberry: 'Grass',
    yacheberry: 'Ice',
    chopleberry: 'Fighting',
    kebiaberry: 'Poison',
    shucaberry: 'Ground',
    cobaberry: 'Flying',
    payapaberry: 'Psychic',
    tangaberry: 'Bug',
    chartiberry: 'Rock',
    kasibberry: 'Ghost',
    habanberry: 'Dragon',
    colburberry: 'Dark',
    babiriberry: 'Steel',
    chilanberry: 'Normal',
  };

  const berryType = berries[item];

  if (!berryType || berryType !== moveType) {
    return false;
  }

  if (item === 'chilanberry') {
    return true;
  }

  return battleDex.getEffectiveness(moveType, defenderTypes) > 0;
}

function readCritChance(calc, attacker, defender, move) {
  // 固定・割合ダメージは急所によって増えない。
  if (usesFixedDamage(move)) {
    return 0;
  }

  if (move.willCrit || attacker.volatiles?.laserfocus) {
    return 1;
  }

  const activeMove = calc.dex.getActiveMove(move.id);
  let ratio = calc.runEvent('ModifyCritRatio', attacker, defender, activeMove, activeMove.critRatio || 0);

  ratio = Math.max(0, Math.min(4, ratio | 0));

  return [0, 1 / 24, 1 / 8, 1 / 2, 1][ratio] || 0;
}

function prepareDamageMove(calc, attacker, defender, move) {
  let activeMove = calc.dex.getActiveMove(move.id);
  calc.setActiveMove(activeMove, attacker, defender);
  calc.singleEvent('ModifyType', activeMove, null, attacker, defender, activeMove, activeMove);
  calc.singleEvent('ModifyMove', activeMove, null, attacker, defender, activeMove, activeMove);
  activeMove = calc.runEvent('ModifyType', attacker, defender, activeMove, activeMove);
  if (!activeMove) return false;
  activeMove = calc.runEvent('ModifyMove', attacker, defender, activeMove, activeMove);
  if (!activeMove) return false;
  if (move.id === 'struggle') activeMove.type = '???';
  calc.setActiveMove(activeMove, attacker, defender);
  return activeMove;
}

function readMoveHitChance(calc, attacker, defender, activeMove) {
  if (!activeMove) return 0;
  const randomChance = calc.randomChance;
  let chance = 1;
  try {
    calc.randomChance = (numerator, denominator) => {
      chance = Math.max(0, Math.min(1, numerator / denominator));
      return true;
    };
    return calc.actions.hitStepAccuracy([defender], attacker, activeMove)[0] ? chance : 0;
  } finally {
    calc.randomChance = randomChance;
  }
}

function applyPublicCalcState(mon, player, spec, substituteEndpoint = 'max') {
  const state = battleState[player];
  if (!state || state.species !== spec.species || spec.active === false) return;
  mon.activeMoveActions = state.activeMoveActions + 1;
  applyPublicCritVolatiles(mon, player);
  if (state.magnetRise) mon.addVolatile('magnetrise');
  if (state.smackDown) mon.addVolatile('smackdown');
  if (state.volatiles.healblock) mon.addVolatile('healblock');
  if (state.volatiles.substitute) {
    mon.addVolatile('substitute');
    // みがわりの残りHPは非公開。1HPから最大HPの1/4の間で幅を持たせる。
    mon.volatiles.substitute.hp = substituteEndpoint === 'min' ? 1 : Math.max(1, Math.floor(mon.maxhp / 4));
  }
}

function showdownDamagePercent(calc, attacker, defender, move, roll, createSession, exchangeMove = null) {
  calc.randomChance = () => false;

  calc.random = (n = 2) => (n === 16 ? roll : 0);

  function collect(willCrit) {
    // 通常・急所は独立した盤面で計算する。実の消費やHP減少を共有しない。
    const session = createSession();
    const { calc, attacker, defender } = session;
    try {
      calc.randomChance = () => false;
      calc.random = (n = 2) => (n === 16 ? roll : 0);
      let triggerHitChance = 1;
      if (exchangeMove) {
        // 反撃技を先に構え、相手の攻撃を実行する。生存・最後の打撃・みがわりもエンジンで判定。
        attacker.addVolatile(move.id);
        const incoming = prepareDamageMove(calc, defender, attacker, exchangeMove);
        triggerHitChance = readMoveHitChance(calc, defender, attacker, incoming);
        if (!triggerHitChance) return null;
        calc.randomChance = (n, d) => d === 100 || n >= d;
        calc.random = (n = 2) => n === 16 ? roll : n === 100 ? 99 : 0;
        if (exchangeMove.beforeTurnCallback) exchangeMove.beforeTurnCallback.call(calc, defender, attacker, incoming);
        calc.queue.push({ choice: 'move', pokemon: attacker, move: calc.dex.getActiveMove(move.id) });
        calc.actions.useMove(exchangeMove.id, defender, attacker);
        if (attacker.hp <= 0 || defender.hp <= 0) return null;
        calc.randomChance = () => false;
        calc.random = (n = 2) => n === 16 ? roll : 0;
      }
      const activeMove = prepareDamageMove(calc, attacker, defender, move);
      if (!activeMove || !calc.runEvent('TryHit', defender, attacker, activeMove)) return null;
      if (['fakeout', 'firstimpression', 'counter', 'mirrorcoat'].includes(move.id) && !calc.singleEvent('Try', activeMove, null, attacker, defender, activeMove)) return null;
      const hitChance = readMoveHitChance(calc, attacker, defender, activeMove) * triggerHitChance;
      if (hitChance === 0) return null;
      const spreadMove = activeMove.multihitType === 'parentalbond' ? { ...activeMove, multihit: move.multihit } : activeMove;
      const spread = hitSpread(spreadMove, attacker, hitChance);
      const maxHits = Math.max(...spread.map((row) => row.hits));
      const minHits = Math.min(...spread.map((row) => row.hits));
      const damages = [];
      const actualDamages = [];
      const drainChanges = [];
      const substituteDamages = [];
      const bodyHits = [];
      const breaks = [];

      function hitDamage(hit, parentalBond = false) {
        if (defender.hp <= 0 || attacker.hp <= 0) return 0;
        activeMove.hit = parentalBond ? 2 : hit;
        activeMove.willCrit = willCrit;
        if (parentalBond) activeMove.multihitType = 'parentalbond';
        const substituteHp = defender.volatiles.substitute?.hp || 0;
        const beforeHeal = attacker.hp;
        // みがわりの処理はエンジンへ委ねる。反動だけは全打撃の合計から別途計算する。
        const recoil = activeMove.recoil;
        activeMove.recoil = undefined;
        let primary;
        try {
          primary = calc.runEvent('TryPrimaryHit', defender, attacker, activeMove);
        } finally {
          activeMove.recoil = recoil;
        }
        if (primary === calc.HIT_SUBSTITUTE) {
          const dealt = substituteHp - (defender.volatiles.substitute?.hp || 0);
          actualDamages.push(dealt);
          substituteDamages.push(dealt);
          bodyHits.push(0);
          breaks.push(defender.volatiles.substitute ? 0 : 1);
          drainChanges.push(attacker.hp - beforeHeal);
          return 0;
        }
        if (!primary) return null;
        const raw = calc.actions.getDamage(attacker, defender, activeMove, true);
        if (raw === false || raw == null) return null;
        // Damageイベントでがんじょう・タスキなどを適用し、連続技の次の一撃にHPを引き継ぐ。
        const adjusted = calc.runEvent('Damage', defender, attacker, activeMove, raw, true);
        const actual = Math.max(0, Math.min(defender.hp, Number(adjusted) || 0));
        defender.hp -= actual;
        actualDamages.push(actual);
        substituteDamages.push(0);
        bodyHits.push(1);
        breaks.push(0);
        if (activeMove.drain && actual > 0) {
          calc.heal(Math.round(actual * activeMove.drain[0] / activeMove.drain[1]), attacker, defender, 'drain');
        }
        drainChanges.push(attacker.hp - beforeHeal);
        return adjusted === false || adjusted == null ? 0 : adjusted;
      }

      for (let hit = 1; hit <= maxHits; hit++) {
        const damage = hitDamage(hit);

        if (damage == null) {
          if (hit === 1) {
            return null;
          }

          break;
        }

        damages.push(damage);
      }

      let bond = 0;

      if (attacker.ability === 'parentalbond' && !move.multihit && damages.length) {
        bond = hitDamage(1, true) || 0;
      }

      const sumTo = (hits) => damages.slice(0, hits).reduce((sum, damage) => sum + damage, 0) + bond;

      const expected = spread.reduce((sum, row) => sum + sumTo(Math.min(row.hits, damages.length)) * row.probability, 0);
      const expectedActual = (amounts) => spread.reduce((sum, row) => {
        const primary = amounts.slice(0, row.hits).reduce((a, b) => a + b, 0);
        return sum + (primary + (bond ? amounts[damages.length] || 0 : 0)) * row.probability;
      }, 0);

      return {
        expected,
        min: sumTo(Math.min(minHits, damages.length)),
        max: sumTo(damages.length),
        actual: expectedActual(actualDamages),
        drain: expectedActual(drainChanges),
        substitute: expectedActual(substituteDamages),
        breaks: expectedActual(breaks),
        bodyHits: expectedActual(bodyHits),
        bodyHitChance: spread.reduce((sum, row) => sum + (bodyHits.slice(0, row.hits + (bond ? 1 : 0)).some(Boolean) ? row.probability : 0), 0),
        expectedHits: spread.reduce((sum, row) => sum + row.hits * row.probability, 0),
        hitChance,
      };
    } finally {
      calc.destroy();
    }
  }

  const normal = collect(false);

  if (!normal) {
    return {
      immune: true,
      percent: 0,
      minPercent: 0,
      maxPercent: 0,
      critPercent: 0,
      critMinPercent: 0,
      critMaxPercent: 0,
      critChance: 0,
      recoilPercent: 0,
    };
  }

  const critChance = readCritChance(calc, attacker, defender, move);
  const crit = critChance > 0 ? collect(true) || normal : normal;

  const expected = normal.expected;
  const actualExpected = normal.actual * (1 - critChance) + crit.actual * critChance;

  let recoilHp = 0;

  if (move.struggleRecoil || move.id === 'struggle') {
    recoilHp = Math.floor(attacker.maxhp / 4);
  } else if (move.mindBlownRecoil || move.chloroblastRecoil) {
    recoilHp = Math.round(attacker.maxhp / 2);
  } else if (move.recoil && attacker.ability !== 'rockhead' && attacker.ability !== 'magicguard') {
    recoilHp = Math.max(1, Math.round((actualExpected * move.recoil[0]) / move.recoil[1]));
  }

  // 各一撃の実回復量。HP上限、おおきなねっこ、ヘドロえきもエンジンで処理済み。
  const drainHp = normal.drain * (1 - critChance) + crit.drain * critChance;

  if (attacker.item === 'lifeorb' && attacker.ability !== 'magicguard' && attacker.ability !== 'sheerforce' && expected > 0) {
    recoilHp += Math.round(attacker.maxhp / 10);
  }

  const crashHp = move.hasCrashDamage && attacker.ability !== 'magicguard' ? (1 - normal.hitChance) * attacker.maxhp / 2 : 0;

  return {
    immune: false,
    percent: (expected / defender.maxhp) * 100,
    minPercent: (normal.min / defender.maxhp) * 100,
    maxPercent: (normal.max / defender.maxhp) * 100,
    critPercent: (crit.expected / defender.maxhp) * 100,
    critMinPercent: (crit.min / defender.maxhp) * 100,
    critMaxPercent: (crit.max / defender.maxhp) * 100,
    critChance,
    hitChance: normal.hitChance,
    substituteScore: ((normal.substitute * (1 - critChance) + crit.substitute * critChance) / defender.maxhp * 60 + (normal.breaks * (1 - critChance) + crit.breaks * critChance) * 10) * normal.hitChance,
    bodyHitChance: normal.bodyHitChance * (1 - critChance) + crit.bodyHitChance * critChance,
    bodyHits: normal.bodyHits * (1 - critChance) + crit.bodyHits * critChance,
    expectedHits: normal.expectedHits,
    recoilPercent: (((recoilHp - drainHp) * normal.hitChance + crashHp) / attacker.maxhp) * 100,
  };
}

function createDamageBattle(attackerSpec, defenderSpec, defenderPlayer, publicOnly = false) {
  const calc = new Battle({
    formatid: FORMAT,
    send() {},
  });

  const defenderIndex = defenderPlayer === 'p1' ? 0 : 1;

  const attackerIndex = defenderIndex === 0 ? 1 : 0;

  const sets = [];
  sets[attackerIndex] = toCalcSet(publicOnly ? { ...attackerSpec, level: attackerSpec.level || BATTLE_LEVEL } : attackerSpec);
  sets[defenderIndex] = toCalcSet(publicOnly ? { ...defenderSpec, level: defenderSpec.level || BATTLE_LEVEL } : defenderSpec);

  calc.sides[0] = new Side('Calc1', calc, 0, [sets[0]]);

  calc.sides[1] = new Side('Calc2', calc, 1, [sets[1]]);

  calc.sides[0].foe = calc.sides[1];
  calc.sides[1].foe = calc.sides[0];

  const mons = [calc.sides[0].pokemon[0], calc.sides[1].pokemon[0]];

  for (const mon of mons) {
    mon.isActive = true;
    mon.position = 0;
    mon.side.active[0] = mon;
  }

  const specs = [];
  specs[attackerIndex] = attackerSpec;
  specs[defenderIndex] = defenderSpec;

  applyCombatant(mons[0], specs[0]);
  applyCombatant(mons[1], specs[1]);

  const source = !mons[attackerIndex].ability ? mons[attackerIndex] : mons[defenderIndex];

  copyLiveField(calc, source, publicOnly);

  return {
    calc,
    attacker: mons[attackerIndex],
    defender: mons[defenderIndex],
    source,
  };
}

function applyPublicCritVolatiles(mon, player) {
  const volatiles = player ? battleState[player]?.volatiles : null;

  if (!volatiles || !mon) {
    return;
  }

  try {
    if (volatiles.focusenergy && !mon.volatiles.focusenergy) {
      mon.addVolatile('focusenergy');
    }

    if (volatiles.laserfocus && !mon.volatiles.laserfocus) {
      mon.addVolatile('laserfocus');
    }
  } catch {
    // 計算用の対戦で急所状態を載せられないときは、通常の急所率のままにする。
  }
}

function measureShowdownDamage(attackerSpec, defenderSpec, move, weather, defenderPlayer, roll, attackerPlayer = null, exchangeMove = null) {
  const createSession = () => {
    const session = createDamageBattle(attackerSpec, defenderSpec, defenderPlayer);
    useWeather(session.calc, weather, session.source);
    applyPublicCalcState(session.attacker, attackerPlayer, attackerSpec);
    applyPublicCalcState(session.defender, defenderPlayer, defenderSpec, roll === 0 ? 'min' : 'max');
    return session;
  };
  const session = createSession();
  try {
    return showdownDamagePercent(session.calc, session.attacker, session.defender, move, roll, createSession, exchangeMove);
  } finally {
    session.calc.destroy?.();
  }
}

function describeSimDamage(move, attackerStatus, attackerGrounded, defenderGrounded, defenderPlayer) {
  const weatherReason = move.id === 'struggle' ? null : getWeatherDamageReason(move.type);

  const parts = [];

  if (move.id !== 'struggle') {
    const terrain = getTerrainDamageMultiplier(move, attackerGrounded, defenderGrounded);

    if (terrain !== 1) {
      parts.push(getTerrainLabel(fieldState.terrain));
    }

    const screen = getScreenDamageMultiplier(defenderPlayer, move.category);

    if (screen !== 1) {
      parts.push('壁');
    }
  }

  if (move.category === 'Physical' && attackerStatus === 'brn') {
    parts.push('やけどで攻撃×0.5');
  }

  return {
    weatherReason,
    fieldReason: parts.join(' / ') || null,
  };
}

function publicActionModel(player, speciesName, pokemon = null) {
  const state = battleState[player];
  const active = state?.species === speciesName;
  const locked = active ? state.volatiles.encoreMove || choiceLockedMove(player) : null;
  if (active && state.volatiles.mustrecharge) return [{ move: null, weight: 1, unable: true }];
  if (locked && !isMoveAllowed(battleDex.moves.get(locked))) return [{ move: null, weight: 1, unable: true }];
  if (locked) return [{ move: publicPPExhausted(player, speciesName, battleDex.moves.get(locked)) ? battleDex.moves.get('struggle') : battleDex.moves.get(locked), weight: 1 }];
  const known = pokemon?.moves?.length ? pokemon.moves : null;
  const ids = known || (player ? getRevealedMoves(player, speciesName) : []);
  const moves = [...new Set(ids)].map((id) => battleDex.moves.get(id))
    .filter((move) => move.exists && isMoveAllowed(move) && !publicPPExhausted(player, speciesName, move) && !(active && moveBlockedByVolatile(player, move)));
  const slots = known ? moves.length : Math.max(4 - ids.length, 0) + moves.length;
  if (!slots) return ids.length ? [{ move: battleDex.moves.get('struggle'), weight: 1 }] : [{ move: null, weight: 1, unable: true }];
  const model = moves.map((move) => ({ move, weight: 1 / slots }));
  if (!known && ids.length < 4) model.push({ move: null, weight: (4 - ids.length) / slots });
  return model;
}

function publicPPExhausted(player, speciesName, move) {
  const maxpp = move.noPPBoosts ? move.pp : Math.floor(move.pp * 8 / 5);
  return (battleState[player]?.ppUsed?.[baseSpeciesName(speciesName)]?.[move.id] || 0) >= maxpp;
}

function publicMoveOrder(move, response, context) {
  const { attackerPokemon, defenderPokemon, attackerSpecies, defenderSpecies, attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer } = context;
  if (attackerPokemon?.stats && defenderPokemon?.stats) {
    const ownSpeed = getEffectiveSpeed(attackerPokemon.stats.spe, attackerBoosts.spe, parseCondition(attackerPokemon.condition).status, getPublicSpeedModifiers(attackerPlayer, attackerPokemon));
    const foeSpeed = getEffectiveSpeed(defenderPokemon.stats.spe, defenderBoosts.spe, parseCondition(defenderPokemon.condition).status, getPublicSpeedModifiers(defenderPlayer, defenderPokemon));
    return compareEstimatedMoveOrder(move, response, ownSpeed, foeSpeed, foeSpeed, attackerPlayer, attackerPokemon);
  }
  if (attackerPokemon?.stats) {
    const speed = getSpeedEstimate(attackerPlayer, attackerPokemon, attackerBoosts, parseCondition(attackerPokemon.condition).status, defenderSpecies.name, defenderBoosts, battleState[defenderPlayer]?.status, false, context.defenderAssumption);
    return compareEstimatedMoveOrder(move, response, speed.ownSpeed, speed.opponentMinSpeed, speed.opponentMaxSpeed, attackerPlayer, attackerPokemon, context.defenderAssumption);
  }
  if (defenderPokemon?.stats) {
    const speed = getSpeedEstimate(defenderPlayer, defenderPokemon, defenderBoosts, parseCondition(defenderPokemon.condition).status, attackerSpecies.name, attackerBoosts, battleState[attackerPlayer]?.status);
    const order = compareEstimatedMoveOrder(response, move, speed.ownSpeed, speed.opponentMinSpeed, speed.opponentMaxSpeed, defenderPlayer, defenderPokemon);
    return order === 'own' ? 'opponent' : order === 'opponent' ? 'own' : order;
  }
  // 両側の実数値が不明な選出評価でも、優先度が異なれば順序を確定できる。
  const ownPriority = effectiveMovePriority(move, attackerPlayer, attackerPokemon);
  const foePriority = effectiveMovePriority(response, defenderPlayer, defenderPokemon);
  return ownPriority > foePriority ? 'own' : ownPriority < foePriority ? 'opponent' : 'uncertain';
}

function responseActions(context) {
  return context.responseMove
    ? [{ move: battleDex.moves.get(context.responseMove), weight: 1 }]
    : publicActionModel(context.defenderPlayer, context.defenderSpecies.name, context.defenderPokemon);
}

function suckerPunchChance(context) {
  return responseActions(context).reduce((sum, action) => {
    if (action.unable || action.move?.category === 'Status' && action.move.id !== 'mefirst') return sum;
    const response = action.move || battleDex.moves.get('tackle');
    const order = publicMoveOrder(context.move, response, context);
    const before = order === 'own' ? 1 : order === 'uncertain' ? 0.5 : 0;
    // 未公開枠は攻撃/変化を半々と仮定し、成功を確定とは扱わない。
    return sum + action.weight * (action.move ? 1 : 0.5) * before;
  }, 0);
}

function estimateCounterDamage(context, empty) {
  const category = context.move.id === 'counter' ? 'Physical' : 'Special';
  const model = responseActions(context);
  const scenarios = [];
  for (const action of model) {
    if (action.unable) continue;
    if (action.move) { scenarios.push(action); continue; }
    // 相手の構築・requestは参照しない。未公開枠は公開の習得可能技から推定する。
    const learned = getLearnedDamagingMoveIds(context.defenderSpecies.name).map((id) => battleDex.moves.get(id))
      .filter((move) => !['counter', 'mirrorcoat', 'suckerpunch'].includes(move.id))
      .sort((a, b) => b.basePower - a.basePower);
    const candidates = ['Physical', 'Special'].flatMap((kind) => learned.filter((move) => move.category === kind).slice(0, 2));
    for (const move of candidates) scenarios.push({ move, weight: action.weight * 0.5 / candidates.length });
  }
  const outcomes = scenarios.filter((action) => action.move.category === category && isDamagingMove(action.move)).map((action) => {
    const order = publicMoveOrder(context.move, action.move, context);
    const after = order === 'opponent' ? 1 : order === 'uncertain' ? 0.5 : 0;
    const status = context.defenderPokemon ? parseCondition(context.defenderPokemon.condition).status : battleState[context.defenderPlayer]?.status;
    const canAct = cantMoveFactor(status, context.defenderPlayer, context.defenderPokemon?.ability || battleState[context.defenderPlayer]?.ability);
    const weight = action.weight * after * canAct;
    const damage = weight ? estimateBattleDamage({ ...context, exchangeMove: action.move }) : empty;
    return { weight, damage: damage.immune ? empty : damage };
  });
  const weighted = (key) => outcomes.reduce((sum, row) => sum + row.weight * (row.damage[key] || 0), 0);
  const chance = weighted('hitChance');
  const min = outcomes.length && outcomes.reduce((sum, row) => sum + row.weight, 0) >= 1 - 1e-9
    ? Math.min(...outcomes.map((row) => row.damage.minDamagePercent)) : 0;
  return {
    ...empty,
    minDamagePercent: min,
    maxDamagePercent: Math.max(0, ...outcomes.map((row) => row.weight ? row.damage.maxDamagePercent : 0)),
    score: weighted('score'),
    hitChance: chance,
    recoilPercent: weighted('recoilPercent'),
    substituteScore: weighted('substituteScore'),
    bodyHitChance: 1,
    bodyHits: 1,
    critChance: 0,
    conditionalChance: chance,
    fieldReason: `反撃成立見込み${Math.round(chance * 100)}%${model.some((row) => !row.move && !row.unable) ? ' / 未公開技を推定' : ''}`,
    failReason: chance ? null : '対応する攻撃を受けて生存する条件を満たさない',
  };
}

function estimateBattleDamage({ move, attackerSpecies, defenderSpecies, attackerPokemon = null, defenderPokemon = null, attackerBoosts = null, defenderBoosts = null, attackerPlayer = null, defenderPlayer = null, weather = fieldState.weather, responseMove = null, exchangeMove = null, attackerAssumption = null, defenderAssumption = null, shellRangeChecked = false }) {
  if (move.id === 'shellsidearm' && !shellRangeChecked) {
    const outcomes = ['Physical', 'Special'].map((category) => estimateBattleDamage({ ...arguments[0], move: { ...move, category }, shellRangeChecked: true }));
    const result = { ...outcomes[0], immune: outcomes.every((row) => row.immune) };
    result.minDamagePercent = Math.min(...outcomes.map((row) => row.minDamagePercent));
    result.maxDamagePercent = Math.max(...outcomes.map((row) => row.maxDamagePercent));
    for (const field of ['score', 'recoilPercent', 'hitChance', 'critChance', 'critFactor', 'substituteScore', 'bodyHitChance', 'bodyHits', 'critMaxDamagePercent']) {
      if (outcomes.some((row) => typeof row[field] === 'number')) result[field] = outcomes.reduce((sum, row) => sum + (row[field] || 0), 0) / outcomes.length;
    }
    result.fieldReason = [result.fieldReason, 'シェルアームズの分類をエンジンで選択'].filter(Boolean).join(' / ');
    return result;
  }
  const empty = {
    immune: false,
    minDamagePercent: 0,
    maxDamagePercent: 0,
    score: 0,
    recoilPercent: 0,
    weatherReason: null,
    fieldReason: null,
    failReason: null,
    critChance: 0,
    critFactor: 1,
    critMaxDamagePercent: 0,
  };

  if (!isDamagingMove(move)) {
    return empty;
  }

  const physical = move.category === 'Physical';

  const attackStatName = physical ? 'atk' : 'spa';

  const defenseStatName = physical ? 'def' : 'spd';

  const attackBoostTable = attackerBoosts ?? createEmptyBoosts();

  const defenderIsActive = defenderPokemon?.active !== false && defenderPlayer && battleState[defenderPlayer].species === defenderSpecies.name;
  const defenseBoostTable = defenderBoosts ?? (defenderIsActive ? battleState[defenderPlayer].boosts : createEmptyBoosts());

  const resolvedAttacker = attackerPlayer ?? (defenderPlayer === 'p1' ? 'p2' : defenderPlayer === 'p2' ? 'p1' : null);

  const assumedAttackerPokemon = attackerAssumption ? { details: attackerSpecies.name, active: battleState[resolvedAttacker]?.species === attackerSpecies.name, condition: `${battleState[resolvedAttacker]?.hpPercent ?? 100}/100`, ...attackerAssumption } : attackerPokemon;
  const assumedDefenderPokemon = defenderAssumption ? { details: defenderSpecies.name, active: battleState[defenderPlayer]?.species === defenderSpecies.name, ...defenderAssumption } : defenderPokemon;
  const attackerGrounded = assumedAttackerPokemon ? isPokemonGrounded(assumedAttackerPokemon) : isActiveGrounded(resolvedAttacker, attackerSpecies);

  const defenderGrounded = assumedDefenderPokemon ? isPokemonGrounded(assumedDefenderPokemon) : isActiveGrounded(defenderPlayer, defenderSpecies);

  const failReason = getTerrainFailReason(move, defenderGrounded, resolvedAttacker, assumedAttackerPokemon);

  if (failReason) {
    return {
      ...empty,
      immune: true,
      failReason,
    };
  }

  const conditionalContext = { move, attackerSpecies, defenderSpecies, attackerPokemon, defenderPokemon, attackerBoosts: attackBoostTable, defenderBoosts: defenseBoostTable, attackerPlayer: resolvedAttacker, defenderPlayer, weather, responseMove };
  if (['counter', 'mirrorcoat'].includes(move.id) && !exchangeMove) return estimateCounterDamage(conditionalContext, empty);

  const lowAttacker = { ...(attackerPokemon ? knownCombatant(attackerPokemon, attackBoostTable) : rangedCombatant(attackerSpecies, exchangeMove ? defenseStatName : attackStatName, exchangeMove ? 'max' : 'min', attackBoostTable, resolvedAttacker)), ...attackerAssumption };

  const highAttacker = attackerPokemon ? lowAttacker : { ...rangedCombatant(attackerSpecies, exchangeMove ? defenseStatName : attackStatName, exchangeMove ? 'min' : 'max', attackBoostTable, resolvedAttacker), ...attackerAssumption };

  const bulkyDefender = { ...(defenderPokemon ? knownCombatant(defenderPokemon, defenseBoostTable) : rangedCombatant(defenderSpecies, exchangeMove ? attackStatName : defenseStatName, exchangeMove ? 'min' : 'max', defenseBoostTable, defenderPlayer)), ...defenderAssumption };

  const frailDefender = defenderPokemon ? bulkyDefender : { ...rangedCombatant(defenderSpecies, exchangeMove ? attackStatName : defenseStatName, exchangeMove ? 'max' : 'min', defenseBoostTable, defenderPlayer), ...defenderAssumption };

  let low = measureShowdownDamage(lowAttacker, bulkyDefender, move, weather, defenderPlayer, 15, resolvedAttacker, exchangeMove);

  let high = measureShowdownDamage(highAttacker, frailDefender, move, weather, defenderPlayer, 0, resolvedAttacker, exchangeMove);

  if (exchangeMove && !(low.immune && high.immune)) {
    const failed = { percent: 0, minPercent: 0, maxPercent: 0, critPercent: 0, critMinPercent: 0, critMaxPercent: 0, critChance: 0, hitChance: 0, recoilPercent: 0 };
    if (low.immune) low = failed;
    if (high.immune) high = failed;
  } else if (low.immune || high.immune) {
    return {
      ...empty,
      immune: true,
    };
  }

  const hitChance = exchangeMove ? ((low.hitChance || 0) + (high.hitChance || 0)) / 2 : low.hitChance ?? (move.accuracy === true ? 1 : move.accuracy / 100);

  const context = describeSimDamage(move, lowAttacker.status, attackerGrounded, defenderGrounded, defenderPlayer);

  const critChance = low.critChance || 0;
  const alwaysCrit = critChance >= 1;
  const expectedLow = low.percent * (1 - critChance) + low.critPercent * critChance;
  const expectedHigh = high.percent * (1 - critChance) + high.critPercent * critChance;
  const critFactor = high.percent > 0 ? high.critPercent / high.percent : 1.5;

  const hits = { expected: low.expectedHits || 1 };

  const fieldParts = [context.fieldReason, move.ohko ? `一撃必殺 命中${Math.round(hitChance * 100)}%` : null, hits.expected > 1 ? `連続${hits.expected.toFixed(1)}回` : null, critChance >= 1 / 8 ? `急所${Math.round(critChance * 100)}%` : null].filter(Boolean);

  const result = {
    immune: false,
    minDamagePercent: exchangeMove ? Math.min(low.minPercent, high.minPercent) : move.ohko && hitChance < 1 ? 0 : alwaysCrit ? low.critMinPercent : low.minPercent,
    maxDamagePercent: exchangeMove ? Math.max(low.maxPercent, high.maxPercent) : alwaysCrit ? high.critMaxPercent : high.maxPercent,
    score: exchangeMove ? (expectedLow * (low.hitChance || 0) + expectedHigh * (high.hitChance || 0)) / 2 : ((expectedLow + expectedHigh) / 2) * hitChance,
    substituteScore: ((low.substituteScore || 0) + (high.substituteScore || 0)) / 2,
    bodyHitChance: ((low.bodyHitChance ?? 1) + (high.bodyHitChance ?? 1)) / 2,
    bodyHits: ((low.bodyHits ?? 1) + (high.bodyHits ?? 1)) / 2,
    hitChance,
    recoilPercent: (low.recoilPercent + high.recoilPercent) / 2,
    weatherReason: context.weatherReason,
    fieldReason: fieldParts.join(' / ') || null,
    failReason: null,
    critChance,
    critFactor,
    critMaxDamagePercent: high.critMaxPercent,
  };
  if (move.id === 'suckerpunch') {
    const chance = suckerPunchChance(conditionalContext);
    result.conditionalChance = chance;
    result.score *= chance;
    result.hitChance *= chance;
    result.substituteScore *= chance;
    result.recoilPercent *= chance;
    if (chance < 1) result.minDamagePercent = 0;
    if (!chance) { result.maxDamagePercent = 0; result.critMaxDamagePercent = 0; result.failReason = '相手の攻撃より先に動く条件を満たさない'; }
    result.fieldReason = [result.fieldReason, `ふいうち成立見込み${Math.round(chance * 100)}%`].filter(Boolean).join(' / ');
  }
  return result;
}

// ========================================
// ねむり・まもる
// ========================================

function evaluateSleepStatusMove(move, activePokemon, opponentSpecies, opponentBoosts, defenderPlayer, attackerPlayer) {
  if (move.status !== 'slp' || move.target === 'self') {
    return null;
  }

  if (move.flags.powder && !battleDex.getImmunity('powder', opponentSpecies.types)) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: '粉技無効',
    };
  }

  const revealedMoveIds = defenderPlayer ? getRevealedMoves(defenderPlayer, opponentSpecies.name) : [];

  const risk = evaluateIncomingRisk(activePokemon, opponentSpecies.name, revealedMoveIds, opponentBoosts, attackerPlayer);

  const accuracy = move.accuracy === true ? 100 : move.accuracy;

  const avoided = risk.damage?.expectedDamagePercent ?? 0;

  const score = avoided * (accuracy / 100);

  const reason = risk.damage ? `ねむりで次の${formatIncomingMoveName(risk.damage)}を回避 命中${accuracy}%` : `ねむり 公開技なし 命中${accuracy}%`;

  return {
    score,
    minDamagePercent: 0,
    maxDamagePercent: 0,
    reason,
  };
}

function evaluateProtectMove(move, pokemon, ownPlayer, foePlayer, speciesName, foeBoosts, ownBoosts, request, assumption = null) {
  if (!ownPlayer) return { score: 0, reason: '相手の行動を判断できない' };
  const responses = publicEffectResponses(move, pokemon, ownBoosts, foeBoosts, ownPlayer, foePlayer, speciesName, assumption);
  const session = createPublicMoveSession(pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, 'max', assumption);
  try {
    const { calc, attacker, defender } = session;
    applyEffectPublicField(session, ownPlayer, foePlayer);
    seedPublicEffectState(session, pokemon, ownPlayer, foePlayer, request);
    const chain = battleState[ownPlayer].protectionChain;
    if (chain?.count && chain.turn === speedLearningState.turn - 1) {
      const condition = calc.dex.conditions.get('stall');
      attacker.addVolatile('stall');
      for (let i = 1; i < chain.count && attacker.volatiles.stall.counter < (condition.counterMax || Infinity); i++) attacker.addVolatile('stall');
    }
    let successChance = 1;
    // 成功率も同梱フォーマットのStallMoveイベントから取得する。
    calc.randomChance = (n, d) => { successChance *= n / d; return true; };
    calc.runEvent('StallMove', attacker);
    const initial = snapshotEffectSession(session);
    const branchValue = (action, protectedTurn) => {
      restoreEffectSession(session, snapshotEffectCopy(initial));
      calc.queue.clear();
      calc.faintQueue = [];
      calc.randomChance = (n, d) => d === 100 || n >= d;
      calc.random = (n = 2) => n === 16 ? 7 : n === 100 ? 99 : 0;
      calc.sample = (values) => values[Math.floor(values.length / 2)];
      const prepared = prepareDamageMove(calc, defender, attacker, action.move);
      const hitChance = readMoveHitChance(calc, defender, attacker, prepared);
      if (protectedTurn) {
        calc.queue.push({ choice: 'move', pokemon: defender, move: calc.dex.getActiveMove(action.move) });
        // 成功した分岐。連続使用の確率は最後に一度だけ掛ける。
        calc.randomChance = () => true;
        calc.setActiveMove(move, attacker, attacker);
        if (!calc.actions.useMove(move, attacker, { target: attacker })) return null;
      }
      calc.randomChance = (n, d) => d === 100 || n >= d;
      prepared.accuracy = true;
      prepared.willCrit = false;
      calc.setActiveMove(prepared, defender, attacker);
      calc.actions.useMove(prepared, defender, { target: attacker });
      calc.runEvent('Update', attacker);
      calc.runEvent('Update', defender);
      const hpValue = (attacker.hp - initial[0].hp) / attacker.maxhp * 100 - (defender.hp - initial[1].hp) / defender.maxhp * 100;
      const residual = projectedResidualBalance(session);
      // 一回の被害と将来の能力・状態異常の損益を重複して数えないよう、HPを揃える。
      attacker.hp = initial[0].hp; defender.hp = initial[1].hp;
      for (const mon of [attacker, defender]) {
        for (const id of Object.keys(mon.volatiles)) if (calc.dex.moves.get(id).stallingMove) delete mon.volatiles[id];
        delete mon.volatiles.stall;
      }
      const position = projectedAilmentPosition(session, pokemon, speciesName, foePlayer, pokemon.moves, false);
      return { value: hpValue + residual + position.value, hitChance };
    };
    let score = 0;
    for (const action of responses) {
      if (!action.move || !action.actionChance || action.beforeOrder === 1) continue;
      const baseline = branchValue(action, false);
      const protectedResult = branchValue(action, true);
      if (!protectedResult) continue;
      score += action.weight * action.actionChance * (1 - action.beforeOrder) * baseline.hitChance * (protectedResult.value - baseline.value);
    }
    return { score: score * successChance, failed: false, successChance, minDamagePercent: 0, maxDamagePercent: 0,
      reason: `防げる被害・接触時の効果・継続効果を比較 / 成功${Math.round(successChance * 100)}%` };
  } finally { session.calc.destroy(); }
}

const STANDARD_FIELD_TURNS = 5;

function baseSpeciesName(name) {
  const species = battleDex.species.get(name);

  return species.exists ? species.baseSpecies : name;
}

function benchSpeciesNames(defenderPlayer) {
  const state = battleState[defenderPlayer];
  const active = state?.species ? baseSpeciesName(state.species) : null;

  const pickedSize = battleDex.formats.getRuleTable(battleDex.formats.get(FORMAT)).pickedTeamSize || 3;
  const selectionKnown = state?.selectedSpecies.size >= pickedSize;
  return (state?.previewSpecies ?? []).filter((name) => name && baseSpeciesName(name) !== active && !state.faintedSpecies.has(baseSpeciesName(name)) && (!selectionKnown || state.selectedSpecies.has(baseSpeciesName(name))));
}

function rememberPublicMoveAction(player) {
  const state = battleState[player];
  if (!state || state.lastActionTurn === speedLearningState.turn) return;
  state.activeMoveActions++;
  state.lastActionTurn = speedLearningState.turn;
}

function resistSwitchIn(opponentPlayer, move) {
  const currentName = battleState[opponentPlayer]?.species;
  const currentSpecies = currentName ? battleDex.species.get(currentName) : null;
  const currentMultiplier = currentSpecies?.exists ? moveTypeMultiplier(move, currentSpecies.types) : 1;
  let best = null;

  for (const name of benchSpeciesNames(opponentPlayer)) {
    const species = battleDex.species.get(name);

    if (!species.exists) {
      continue;
    }

    const multiplier = moveTypeMultiplier(move, species.types);

    if (multiplier >= currentMultiplier) {
      continue;
    }

    if (!best || multiplier < best.multiplier) {
      best = {
        name,
        species,
        multiplier,
      };
    }
  }

  return best;
}

function hazardChipForSpecies(speciesName, player, stealthRock, spikes) {
  const species = battleDex.species.get(speciesName);

  if (!species.exists) {
    return 0;
  }

  const abilityId = battleState[player]?.revealedAbilities?.[speciesName] ?? null;

  let damage = 0;

  if (stealthRock) {
    damage += 12.5 * getTypeMultiplier('Rock', species.types);
  }

  if (spikes > 0 && isGroundedByTraits(species.types, abilityId, null)) {
    if (spikes === 1) {
      damage += 12.5;
    } else if (spikes === 2) {
      damage += 100 / 6;
    } else {
      damage += 25;
    }
  }

  return damage;
}

function evaluateHazardSetupMove(move, defenderPlayer) {
  if (!defenderPlayer) {
    return null;
  }

  const side = fieldState.sides[defenderPlayer];

  const bench = benchSpeciesNames(defenderPlayer);

  if (move.id !== 'stealthrock' && move.id !== 'spikes' && move.id !== 'toxicspikes') {
    return null;
  }

  if (!bench.length) {
    return {
      score: 12,
      reason: '控えが分からないので設置は低め',
    };
  }

  if (move.id === 'stealthrock') {
    const chips = bench.map((name) => hazardChipForSpecies(name, defenderPlayer, true, 0)).sort((a, b) => b - a);

    const score = chips.slice(0, 2).reduce((sum, value) => sum + value, 0);

    return {
      score: Math.max(score, 8),
      reason: `ステルスロック 控え上位${Math.min(2, chips.length)}匹`,
    };
  }

  if (move.id === 'spikes') {
    const next = Math.min((side?.spikes ?? 0) + 1, 3);

    const chips = bench.map((name) => hazardChipForSpecies(name, defenderPlayer, false, next) - hazardChipForSpecies(name, defenderPlayer, false, side?.spikes ?? 0)).sort((a, b) => b - a);

    const score = chips.slice(0, 2).reduce((sum, value) => sum + value, 0);

    return {
      score: Math.max(score, 8),
      reason: `まきびし${next}段階 控え上位${Math.min(2, chips.length)}匹`,
    };
  }

  const next = Math.min((side?.toxicSpikes ?? 0) + 1, 2);

  let absorb = false;

  let targets = 0;

  for (const name of bench) {
    const species = battleDex.species.get(name);

    if (!species.exists) {
      continue;
    }

    const abilityId = battleState[defenderPlayer]?.revealedAbilities?.[name] ?? null;

    if (!isGroundedByTraits(species.types, abilityId, null)) {
      continue;
    }

    if (species.types.includes('Poison')) {
      absorb = true;
      continue;
    }

    if (species.types.includes('Steel')) {
      continue;
    }

    targets += 1;
  }

  if (absorb && targets === 0) {
    return {
      score: -20,
      reason: 'どくタイプがどくびしを吸収',
    };
  }

  const perTarget = next >= 2 ? 16 : 10;

  return {
    score: Math.min(targets, 2) * perTarget + (absorb ? -12 : 0),
    reason: absorb ? `どくびし${next}段階 吸収あり 対象${targets}` : `どくびし${next}段階 対象${targets}`,
  };
}

function evaluateScreenSetupMove(move, activePokemon, opponentSpecies, opponentBoosts, attackerPlayer, defenderPlayer) {
  if (move.id !== 'reflect' && move.id !== 'lightscreen' && move.id !== 'auroraveil') {
    return null;
  }

  if (move.id === 'auroraveil' && fieldState.weather !== 'snow' && fieldState.weather !== 'hail') {
    return {
      score: -100,
      reason: '雪がないのでオーロラベール失敗',
    };
  }

  const revealedMoveIds = defenderPlayer ? getRevealedMoves(defenderPlayer, opponentSpecies.name) : [];

  const risk = activePokemon ? evaluateIncomingRisk(activePokemon, opponentSpecies.name, revealedMoveIds, opponentBoosts, attackerPlayer) : null;

  const incomingMove = risk?.damage?.moveName ? battleDex.moves.get(risk.damage.moveName) : null;

  const expected = risk?.damage?.expectedDamagePercent ?? 0;

  const category = incomingMove?.exists ? incomingMove.category : null;

  let saved = expected * 0.15;

  if (move.id === 'auroraveil' || (move.id === 'reflect' && category !== 'Special') || (move.id === 'lightscreen' && category !== 'Physical')) {
    saved = expected * 0.5;
  }

  const turns = heldFieldTurns(move.id, activePokemon?.item);

  const label = move.id === 'reflect' ? 'リフレクター' : move.id === 'lightscreen' ? 'ひかりのかべ' : 'オーロラベール';

  return {
    score: Math.max(Math.round(saved), 12) * (turns / STANDARD_FIELD_TURNS),
    reason: `${label}で被ダメ半減 約${turns}ターン`,
  };
}

function evaluateTerrainSetupMove(move, activePokemon, attackerPlayer) {
  const terrainByMove = {
    electricterrain: 'electric',
    grassyterrain: 'grassy',
    psychicterrain: 'psychic',
    mistyterrain: 'misty',
  };

  const terrain = terrainByMove[move.id];

  if (!terrain) {
    return null;
  }

  const turns = heldFieldTurns(move.id, activePokemon?.item);

  let score = 8;

  const reasons = [`フィールド 約${turns}ターン`];

  const species = battleDex.species.get(getPokemonSpeciesName(activePokemon));

  const grounded = attackerPlayer ? isActiveGrounded(attackerPlayer, species) : isPokemonGrounded(activePokemon);

  if (terrain === 'grassy' && grounded) {
    score += 6.25 * turns;

    reasons.push('毎ターン回復');
  }

  const boostedType = {
    electric: 'Electric',
    grassy: 'Grass',
    psychic: 'Psychic',
  }[terrain];

  if (
    boostedType &&
    grounded &&
    activePokemon?.moves?.some((moveId) => {
      const known = battleDex.moves.get(moveId);

      return known.exists && known.category !== 'Status' && known.type === boostedType;
    })
  ) {
    score += 12;

    reasons.push('一致技を強化');
  }

  if (terrain === 'misty' || terrain === 'electric') {
    score += 8;

    reasons.push('状態異常を防ぐ');
  }

  return {
    score: Math.round(score),
    reason: reasons.join(' '),
  };
}

function evaluateTrickRoomMove(attackerPlayer, activePokemon, opponentSpeciesName, opponentBoosts, opponentStatus) {
  if (!attackerPlayer || !activePokemon) {
    return {
      score: 10,
      reason: 'トリックルーム',
    };
  }

  const estimate = getSpeedEstimate(attackerPlayer, activePokemon, battleState[attackerPlayer]?.boosts ?? createEmptyBoosts(), battleState[attackerPlayer]?.status ?? null, opponentSpeciesName, opponentBoosts, opponentStatus);

  const setting = !fieldState.trickRoom;

  const turns = setting ? STANDARD_FIELD_TURNS : fieldState.trickRoomTurns || 1;

  if (setting && estimate.relation === 'opponent') {
    return {
      score: 14 * turns,
      reason: `トリックルームで後攻を先に 約${turns}ターン`,
    };
  }

  if (setting && estimate.relation === 'own') {
    return {
      score: -6 * turns,
      reason: `自分が速いのでトリックルームは不利 約${turns}ターン`,
    };
  }

  if (setting) {
    return {
      score: 10,
      reason: `トリックルーム 速度不明 約${turns}ターン`,
    };
  }

  if (estimate.relation === 'own') {
    return {
      score: 12 * turns,
      reason: `トリックルーム解除 残り${turns}ターン`,
    };
  }

  if (estimate.relation === 'opponent') {
    return {
      score: -12 * turns,
      reason: `トリックルーム解除は不利 残り${turns}ターン`,
    };
  }

  return {
    score: 8,
    reason: `トリックルーム解除 残り${turns}ターン 速度不明`,
  };
}

function evaluateSandSnowSetup(move, pokemon, speciesName, ownBoosts, foeBoosts, request, ownPlayer, foePlayer, assumption = null) {
  if (!['sandstorm', 'snowscape', 'hail'].includes(move.id)) return null;
  const weather = move.id === 'sandstorm' ? 'sand' : 'snow';
  const turns = heldFieldTurns(move.id, pokemon.item);
  const compare = (mon, boosts) => {
    const session = createPublicMoveSession(mon, speciesName, boosts, foeBoosts, ownPlayer, foePlayer, 'max', assumption);
    try {
      applyEffectPublicField(session, ownPlayer, foePlayer);
      const before = projectedEffectPosition(session, mon, speciesName, foePlayer, mon.moves);
      const residualBefore = projectedResidualBalance(session, before);
      useWeather(session.calc, weather, session.attacker);
      const after = projectedEffectPosition(session, mon, speciesName, foePlayer, mon.moves);
      const residualAfter = projectedResidualBalance(session, after);
      // 将来の居座りは確定しないため、2ターン目以降を半分の重みで見積もる。
      return after.value - before.value + (residualAfter - residualBefore) * (1 + (turns - 1) * 0.5);
    } finally { session.calc.destroy(); }
  };
  const activeScore = compare(pokemon, ownBoosts);
  const bench = (request?.side?.pokemon || []).filter((mon) => !mon.active && !mon.condition.includes('fnt'));
  const benchScore = bench.length ? bench.reduce((sum, mon) => sum + compare(mon, createEmptyBoosts()), 0) / bench.length : 0;
  return { score: activeScore + benchScore * 0.35,
    reason: `${weather === 'sand' ? '砂嵐' : '雪'}の火力・防御・速度・継続効果を比較 約${turns}ターン${bench.length ? ' / 控えも考慮' : ''}` };
}

function evaluateFieldSetupMove(move, activePokemon, opponentSpecies, opponentBoosts, opponentStatus, attackerPlayer, defenderPlayer, ownBoosts, request, defenderAssumption) {
  if (move.id === 'trickroom') {
    return evaluateTrickRoomMove(attackerPlayer, activePokemon, opponentSpecies.name, opponentBoosts, opponentStatus);
  }

  return evaluateHazardSetupMove(move, defenderPlayer) || evaluateScreenSetupMove(move, activePokemon, opponentSpecies, opponentBoosts, attackerPlayer, defenderPlayer) || evaluateTerrainSetupMove(move, activePokemon, attackerPlayer) || evaluateSandSnowSetup(move, activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, defenderAssumption);
}

// ========================================
// 技評価
// ========================================

function choiceLockedMove(player) {
  const item = battleState[player]?.item;

  if (!['choiceband', 'choicespecs', 'choicescarf'].includes(item)) {
    return null;
  }

  return battleState[player].lastMove || null;
}

function evaluateUtilityStatusMove(move, activePokemon, opponentSpecies, ownBoosts, defenderPlayer = null, attackerPlayer = null, opponentBoosts = null, opponentStatus = null, request = null, defenderAssumption = null) {
  if (!isMoveAllowed(move)) return { score: -100, reason: moveRestriction(move) };
  const accuracy = move.accuracy === true ? 100 : move.accuracy;

  const opponentAbility = defenderPlayer ? battleState[defenderPlayer]?.ability : null;

  if (move.id === 'batonpass') {
    const stages = Object.values(ownBoosts)
      .filter((value) => value > 0)
      .reduce((sum, value) => sum + value, 0);

    if (!stages) {
      return {
        score: 4,
        reason: 'バトンタッチする上昇がない',
      };
    }

    return {
      score: 12 * stages,
      reason: 'バトンタッチ',
    };
  }

  if (move.id === 'substitute') {
    const hp = parseCondition(activePokemon.condition).hpPercent;

    if (attackerPlayer && battleState[attackerPlayer].volatiles.substitute) {
      return { score: -100, reason: 'すでにみがわりがある' };
    }

    if (hp <= 25) {
      return {
        score: -30,
        reason: 'みがわりの体力が足りない',
      };
    }

    return {
      score: 22,
      reason: 'みがわり',
    };
  }

  if (['taunt', 'leechseed', 'yawn'].includes(move.id)) return evaluatePersistentStatusMove(move, activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, defenderAssumption);

  if (move.id === 'tailwind') {
    return evaluateTailwindMove(activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, request, defenderAssumption);
  }

  if (['encore', 'disable'].includes(move.id)) return evaluateControlMove(move, activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, defenderAssumption);
  if (['trick', 'switcheroo'].includes(move.id)) return evaluateProjectedStateEffect(move, activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, null, 7, 'max', false, defenderAssumption);

  if (move.id === 'whirlwind' || move.id === 'roar' || move.id === 'dragontail') {
    const boosted = Object.values(opponentBoosts ?? {}).some((value) => value > 0);

    return {
      score: boosted ? 28 : 12,
      reason: 'ふきとばし',
    };
  }

  if (move.id === 'destinybond') {
    const hp = parseCondition(activePokemon.condition).hpPercent;

    return {
      score: hp <= 40 ? 30 : 12,
      reason: 'みちづれ',
    };
  }

  if (move.id === 'haze') {
    const boosted = Object.values(opponentBoosts ?? {}).some((value) => value > 0);

    return {
      score: boosted ? 24 : 8,
      reason: 'くろいきり',
    };
  }

  if (move.id === 'perishsong') {
    return {
      score: 16,
      reason: 'ほろびのうた',
    };
  }

  if (move.id === 'stickyweb') {
    const grounded = benchSpeciesNames(defenderPlayer).filter((name) => {
      const species = battleDex.species.get(name);

      return species.exists && isGroundedByTraits(species.types, battleState[defenderPlayer]?.revealedAbilities?.[name] ?? null, null);
    }).length;

    return {
      score: Math.max(12, Math.min(grounded, 2) * 14),
      reason: `ねばねばネット 対象${grounded}`,
    };
  }

  if (move.status && move.target !== 'self') {
    return evaluateAilmentMove(move, activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, defenderAssumption);
  }

  if (move.id === 'attract') {
    if (opponentAbility === 'oblivious') {
      return {
        score: -100,
        reason: 'どんかん',
      };
    }

    const ownGender = genderOf(activePokemon.details);
    const foeGender = defenderPlayer ? battleState[defenderPlayer].gender : null;

    if (ownGender && foeGender && ownGender === foeGender) {
      return {
        score: -100,
        reason: 'メロメロの性別が同じ',
      };
    }

    return {
      score: ownGender && foeGender ? 22 * (accuracy / 100) : 8,
      reason: ownGender && foeGender ? 'メロメロ' : 'メロメロ 性別不明',
    };
  }

  if (move.id === 'curse') {
    const ownTypes = battleDex.species.get(getPokemonSpeciesName(activePokemon)).types ?? [];

    if (!ownTypes.includes('Ghost')) {
      return {
        score: 18,
        reason: 'のろいで攻撃と防御上昇',
      };
    }

    const hp = parseCondition(activePokemon.condition).hpPercent;

    return {
      score: hp > 50 ? 22 : -10,
      reason: 'ゴーストののろい',
    };
  }

  if (move.id === 'painsplit' && defenderPlayer) {
    return evaluatePainSplit(activePokemon, opponentSpecies.name, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer);
  }

  if (move.id === 'strengthsap') {
    if (opponentAbility === 'liquidooze') {
      return {
        score: -30,
        reason: 'ヘドロえき',
      };
    }

    const stage = opponentBoosts?.atk ?? 0;
    const ownHp = parseCondition(activePokemon.condition).hpPercent;
    const heal = Math.min(Math.max(20, 35 * getBoostMultiplier(stage)), 100 - ownHp);

    return {
      score: heal * 0.7 + Math.max(stage, 0) * 8,
      reason: 'ちからを吸いとる',
    };
  }

  if (move.id === 'courtchange' && attackerPlayer && defenderPlayer) {
    const hazardValue = (side) => (side?.stealthRock ? 20 : 0) + (side?.spikes || 0) * 12 + (side?.toxicSpikes || 0) * 10 + (side?.stickyWeb ? 14 : 0);
    const screenValue = (side) => (side?.reflect ? 12 : 0) + (side?.lightScreen ? 12 : 0) + (side?.auroraVeil ? 16 : 0) + (side?.tailwind ? 10 : 0);
    const ownSide = fieldState.sides[attackerPlayer];
    const foeSide = fieldState.sides[defenderPlayer];
    const delta = hazardValue(ownSide) - hazardValue(foeSide) + screenValue(foeSide) - screenValue(ownSide);

    return {
      score: delta,
      reason: 'コートチェンジ',
    };
  }

  return null;
}

function addedEffectScore(move, activePokemon, opponentStatus, attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName, ownMoveIds = null, defenderAssumption = null) {
  if (normalizeBattleEffect(activePokemon?.ability) === 'sheerforce') {
    return {
      score: 0,
      reason: null,
    };
  }

  if (!move.secondary && !move.secondaries?.length && !move.status) return { score: 0, selfScore: 0, reason: null };
  const session = createPublicMoveSession(activePokemon, opponentSpeciesName, attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer, 'max', defenderAssumption);
  try {
    const { calc, attacker, defender } = session;
    const prepared = prepareDamageMove(calc, attacker, defender, move);
    const secondaryEffects = prepared.secondaries ?? (prepared.secondary ? [prepared.secondary] : []);
    const effects = calc.runEvent('ModifySecondaries', defender, attacker, prepared, secondaryEffects.slice());

    if (move.status && move.category !== 'Status') {
      effects.push({
        chance: 100,
        status: move.status,
      });
    }

    if (!effects.length) {
      return {
        score: 0,
        reason: null,
      };
    }

    let score = 0;
    let selfScore = 0;
    const reasons = [];

    for (const effect of effects) {
      // ModifyMoveでてんのめぐみ等を適用済み。状態異常・一時効果の可否もエンジンに問い合わせる。
      const chance = Math.min(100, effect.chance ?? 100) / 100;
      const statusEffect = effect.status && !opponentStatus
        ? projectedStatusEffect(session, prepared, activePokemon, opponentSpeciesName, defenderPlayer, ownMoveIds,
          () => defender.setStatus(effect.status, attacker, prepared)) : { applied: false, score: 0 };
      let volatileAllowed = false;
      if (effect.volatileStatus && !defender.volatiles[effect.volatileStatus]) {
        volatileAllowed = !!defender.addVolatile(effect.volatileStatus, attacker, prepared);
        if (volatileAllowed) defender.removeVolatile(effect.volatileStatus);
      }

      if (statusEffect.applied && statusEffect.score) {
        score += chance * statusEffect.score;
        reasons.push({ brn: 'やけど', par: 'まひ', tox: 'もうどく', psn: 'どく', frz: 'こおり', slp: 'ねむり' }[effect.status] || '状態異常');
      }

      const volatileValue = {
        confusion: [16, 'こんらん'],
        attract: [18, 'メロメロ'],
        saltcure: [22, 'しおづけ'],
        curse: [16, 'のろい'],
        throatchop: [14, 'じごくづき'],
        yawn: [12, 'あくび'],
        healblock: [10, 'かいふくふうじ'],
      };

      if (volatileAllowed && volatileValue[effect.volatileStatus]) {
        const [value, label] = volatileValue[effect.volatileStatus];

        score += chance * value;
        reasons.push(label);
      }

      if (volatileAllowed && (effect.volatileStatus === 'partiallytrapped' || effect.volatileStatus === 'leechseed')) {
        score += chance * 14;
        reasons.push(effect.volatileStatus === 'leechseed' ? 'やどりぎ' : 'まきつく');
      }

      if (volatileAllowed && effect.volatileStatus === 'syrupbomb') {
        const snapshot = snapshotEffectSession(session);
        const before = projectedEffectPosition(session, activePokemon, opponentSpeciesName, defenderPlayer, ownMoveIds);
        defender.addVolatile('syrupbomb', attacker, prepared);
        calc.singleEvent('Residual', calc.dex.conditions.get('syrupbomb'), defender.volatiles.syrupbomb, defender);
        const after = projectedEffectPosition(session, activePokemon, opponentSpeciesName, defenderPlayer, ownMoveIds);
        score += chance * (after.value - before.value);
        if (after.value !== before.value) reasons.push('みずあめで素早さ変化');
        restoreEffectSession(session, snapshot);
      }

      if (volatileAllowed && effect.volatileStatus === 'flinch' && attackerPlayer) {
        const context = {
          attackerPokemon: activePokemon, defenderPokemon: null,
          attackerSpecies: battleDex.species.get(getPokemonSpeciesName(activePokemon)), defenderSpecies: battleDex.species.get(opponentSpeciesName),
          attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer,
        };
        const before = publicActionModel(defenderPlayer, opponentSpeciesName).reduce((sum, action) => {
          if (action.unable) return sum;
          const order = publicMoveOrder(move, action.move || battleDex.moves.get('tackle'), context);
          return sum + action.weight * (order === 'own' ? 1 : order === 'uncertain' ? 0.5 : 0);
        }, 0);
        if (before > 0) {
          score += chance * 24 * before;
          reasons.push('ひるみ');
        }
      }

      if (effect.onHit) {
        const value = callbackEffectScore(session, prepared, effect, move, activePokemon, attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName);
        score += chance * value;
        if (value) reasons.push(move.id === 'eeriespell' ? '相手のPP減少（公開履歴から推定）' : '追加効果');
      }

      // boostイベントを通すことで反射・無効・あまのじゃく・まけんき・上限も反映する。
      for (const [target, boosts, label] of [[defender, effect.boosts, '能力変化'], [attacker, effect.self?.boosts, '追加で能力上昇']]) {
        if (!boosts) continue;
        const snapshot = snapshotEffectSession(session);
        const before = projectedEffectPosition(session, activePokemon, opponentSpeciesName, defenderPlayer, ownMoveIds);
        calc.setActiveMove(prepared, attacker, defender);
        calc.boost(boosts, target, attacker, prepared);
        const after = projectedEffectPosition(session, activePokemon, opponentSpeciesName, defenderPlayer, ownMoveIds);
        const delta = after.value - before.value;
        score += chance * delta;
        if (target === attacker) selfScore += chance * delta;
        if (Math.abs(delta) > 0.01) reasons.push(label);
        restoreEffectSession(session, snapshot);
      }
    }

    return {
      score,
      selfScore,
      reason: reasons.length ? reasons[0] : null,
    };
  } finally { session.calc.destroy(); }
}

function sleepWakeChance(player, ability = battleState[player]?.ability) {
  const age = battleState[player]?.statusAge || 0;
  const earlyBird = normalizeBattleEffect(ability) === 'earlybird';
  const decrement = earlyBird ? 2 : 1;
  // 公開された睡眠行動数の時点で、既に起きているはずの初期カウントを除く。
  const initialTimes = battleState[player]?.sleepSource === 'rest' ? [3] : [2, 3, 3];
  const remaining = initialTimes.map((time) => time - age * decrement).filter((time) => time > 0);
  return remaining.length ? remaining.filter((time) => time <= decrement).length / remaining.length : 1;
}

function cantMoveFactor(status, player = null, ability = battleState[player]?.ability) {
  let factor = 1;

  // Championsの状態異常。内部カウントは参照せず、公開された行動不能回数だけを使う。
  if (status === 'slp') {
    factor = sleepWakeChance(player, ability);
  } else if (status === 'frz') {
    factor = (battleState[player]?.statusAge || 0) >= 2 ? 1 : 1 / 4;
  } else if (status === 'par') {
    factor = 7 / 8;
  }

  const volatiles = player ? battleState[player]?.volatiles : null;

  if (volatiles?.attract) {
    factor *= 0.5;
  }

  if (volatiles?.confusion) {
    factor *= 2 / 3;
  }

  return factor;
}

function dieFirstPenalty(order, guaranteedKo, possibleKo, expectedPercent, statusFactor) {
  const threatened = Math.max(expectedPercent || 0, guaranteedKo ? 100 : 50);

  let penalty = 0;

  if (order === 'opponent' && guaranteedKo) {
    penalty = threatened + 70;
  } else if (order === 'opponent' && possibleKo) {
    penalty = threatened * 0.65 + 25;
  } else if (order === 'uncertain' && guaranteedKo) {
    penalty = threatened * 0.55 + 35;
  } else if (order === 'uncertain' && possibleKo) {
    penalty = threatened * 0.4 + 15;
  }

  return Math.round(penalty * statusFactor);
}

function effectiveMovePriority(move, player, pokemon) {
  if (!move?.exists && !move?.id) {
    return 0;
  }

  let priority = move.priority || 0;
  const ability = normalizeBattleEffect(pokemon?.ability) || (player ? battleState[player]?.ability : null);
  const hp = pokemon ? parseCondition(pokemon.condition).hpPercent : player ? battleState[player]?.hpPercent ?? 100 : 100;

  if (ability === 'prankster' && move.category === 'Status') {
    priority += 1;
  }

  if (ability === 'galewings' && move.type === 'Flying' && hp >= 100) {
    priority += 1;
  }

  if (ability === 'triage' && (move.flags?.heal || move.drain || move.heal)) {
    priority += 3;
  }

  return priority;
}

function fractionalMovePriority(move, player, pokemon) {
  const item = normalizeBattleEffect(pokemon?.item) || (player ? battleState[player]?.item : null);
  const ability = normalizeBattleEffect(pokemon?.ability) || (player ? battleState[player]?.ability : null);
  const hp = pokemon ? parseCondition(pokemon.condition).hpPercent : player ? battleState[player]?.hpPercent ?? 100 : 100;

  if (move.category === 'Status' && ability === 'myceliummight') {
    return 0;
  }

  // イバンは同じ優先度の中で先行する。先制技の優先度には届かない。
  return item === 'custapberry' && hp <= 25 ? 0.1 : 0;
}

function targetsOpponent(move) {
  return ['normal', 'adjacentFoe', 'any', 'randomNormal', 'allAdjacent', 'allAdjacentFoes'].includes(move?.target);
}

function priorityBlocked(targetPlayer, move) {
  if (fieldState.terrain !== 'psychic' || !targetPlayer || !targetsOpponent(move)) {
    return false;
  }

  const speciesName = battleState[targetPlayer]?.species;
  const species = speciesName ? battleDex.species.get(speciesName) : null;

  return isActiveGrounded(targetPlayer, species);
}

function moveBlockedByVolatile(player, move) {
  const volatiles = player ? battleState[player]?.volatiles : null;

  if (!volatiles || !move?.exists) {
    return false;
  }

  if (volatiles.taunt && move.category === 'Status') {
    return true;
  }

  if (volatiles.disable && volatiles.disableMove === move.id) {
    return true;
  }

  if (volatiles.throatchop && move.flags?.sound) {
    return true;
  }

  if (volatiles.encore && volatiles.encoreMove && move.id !== volatiles.encoreMove) {
    return true;
  }
  if (volatiles.torment && battleState[player].lastMove === move.id && move.id !== 'struggle') return true;
  const foe = player === 'p1' ? 'p2' : 'p1';
  if (battleState[foe]?.volatiles.imprison && getRevealedMoves(foe, battleState[foe].species).includes(move.id) && move.id !== 'struggle') return true;

  return false;
}

function createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, hpEndpoint = 'max', defenderAssumption = null, publicOnly = false) {
  const spec = knownCombatant(publicOnly ? { ...activePokemon, level: activePokemon.level || BATTLE_LEVEL } : activePokemon, ownBoosts);
  const defenderSpec = { ...rangedCombatant(battleDex.species.get(opponentSpeciesName), 'def', hpEndpoint, opponentBoosts, defenderPlayer), ...defenderAssumption };
  const session = createDamageBattle(spec, defenderSpec, defenderPlayer, publicOnly);
  session.effectAssumption = defenderAssumption;
  useWeather(session.calc, fieldState.weather, session.source);
  applyPublicCalcState(session.attacker, attackerPlayer, spec);
  applyPublicCalcState(session.defender, defenderPlayer, defenderSpec);
  seedPublicEffectState(session, activePokemon, attackerPlayer, defenderPlayer);
  return session;
}

function seedPublicEffectState(session, pokemon, attackerPlayer, defenderPlayer, request = null) {
  for (const [mon, player, own] of [[session.attacker, attackerPlayer, true], [session.defender, defenderPlayer, false]]) {
    const state = battleState[player];
    const species = own ? getPokemonSpeciesName(pokemon) : mon.species.name;
    const active = state?.species === species && (!own || pokemon.active !== false);
    const ids = !own && session.effectAssumption?.moves ? session.effectAssumption.moves : own ? pokemon.moves || request?.active?.[0]?.moves?.map((entry) => entry.id) || mon.moveSlots.map((slot) => slot.id)
      : !state ? mon.moveSlots.map((slot) => slot.id) : getRevealedMoves(player, species).length >= 4 ? getRevealedMoves(player, species) : predictOpponentSets(player, species)[0]?.moves || getRevealedMoves(player, species);
    mon.moveSlots = [...new Set(ids)].map((id) => {
      const move = battleDex.moves.get(id);
      const maxpp = session.calc.calculatePP(move, move.noPPBoosts ? 0 : 3);
      const exact = own && request?.active?.[0]?.moves?.find((slot) => slot.id === id);
      const used = state?.ppUsed?.[baseSpeciesName(species)]?.[id] || 0;
      return { id: move.id, move: move.name, target: move.target, pp: exact?.pp ?? Math.max(0, maxpp - used), maxpp: exact?.maxpp ?? maxpp, disabled: !!exact?.disabled, disabledSource: '', used: !!used };
    });
    if (active) {
      mon.lastMove = state.lastMove ? session.calc.dex.getActiveMove(state.lastMove) : null;
      mon.lastItem = state.consumedItems?.[baseSpeciesName(species)] || '';
      mon.statsRaisedThisTurn = !!state.statsRaisedThisTurn;
      mon.transformed = !!state.transformed;
      const source = mon === session.attacker ? session.defender : session.attacker;
      for (const id of ['torment', 'imprison', 'trapped', 'taunt', 'leechseed', 'yawn', 'confusion', 'attract', 'saltcure', 'curse', 'throatchop']) {
        if (state.volatiles[id] && !mon.volatiles[id]) {
          // 公開された既存状態を復元。onStartの再実行や非公開の残りターンの参照はしない。
          mon.volatiles[id] = { id, target: mon, source, sourceSlot: source.getSlot(), duration: 2 };
        }
      }
      if (mon.status === 'tox') mon.statusState.stage = state.toxicCounter || 1;
      for (const id of ['encore', 'disable']) {
        if (state.volatiles[id]) mon.volatiles[id] = { id, target: mon, source: mon === session.attacker ? session.defender : session.attacker, move: state.volatiles[`${id}Move`], duration: 2 };
      }
      if (state.volatiles.stockpile) {
        const condition = state.volatiles.stockpile;
        // onStartの能力上昇は公開ランクに含まれるので再実行しない。
        mon.volatiles.stockpile = { id: 'stockpile', target: mon, source: mon, ...condition };
      }
      if (state.volatiles.lockon) mon.addVolatile('lockon', mon === session.attacker ? session.defender : session.attacker);
    }
  }
}

// 推定用バトルの変更だけを保存する。実戦の非公開情報は読み込まない。
function snapshotEffectSession(session) {
  return [session.attacker, session.defender].map((mon) => ({
    hp: mon.hp, boosts: { ...mon.boosts }, storedStats: { ...mon.storedStats },
    types: mon.types.slice(), addedType: mon.addedType,
    status: mon.status, statusState: { ...mon.statusState },
    item: mon.item, itemState: { ...mon.itemState }, ability: mon.ability, abilityState: { ...mon.abilityState },
    volatiles: Object.fromEntries(Object.entries(mon.volatiles).map(([id, state]) => [id, { ...state }])),
    switchFlag: mon.switchFlag, forceSwitchFlag: mon.forceSwitchFlag,
    moveSlots: mon.moveSlots.map((slot) => ({ ...slot })), lastMove: mon.lastMove, lastItem: mon.lastItem,
    statsRaisedThisTurn: mon.statsRaisedThisTurn, transformed: mon.transformed, species: mon.species,
    trapped: mon.trapped, fainted: mon.fainted,
  }));
}

function snapshotEffectCopy(snapshot) {
  return snapshot.map((state) => ({ ...state, boosts: { ...state.boosts }, storedStats: { ...state.storedStats },
    types: state.types.slice(), moveSlots: state.moveSlots.map((slot) => ({ ...slot })), statusState: { ...state.statusState }, itemState: { ...state.itemState }, abilityState: { ...state.abilityState },
    volatiles: Object.fromEntries(Object.entries(state.volatiles).map(([id, value]) => [id, { ...value }])) }));
}

function effectStatusValue(mon) {
  return ({ brn: 28, par: 22, tox: 18, psn: 12, frz: 20, slp: 40 })[mon.status] || 0;
}

function effectConditionValue(mon) {
  const volatile = { confusion: 16, attract: 18, saltcure: 22, curse: 16, throatchop: 14, yawn: 12, healblock: 10,
    trapped: 14, partiallytrapped: 14, leechseed: 14, octolock: 18 };
  return effectStatusValue(mon) + Object.entries(volatile).reduce((sum, [id, value]) => sum + (mon.volatiles[id] ? value : 0), 0);
}

function projectedResidualBalance(session, nextAttack = null) {
  const snapshot = snapshotEffectSession(session);
  const faintQueue = session.calc.faintQueue.slice();
  const randomChance = session.calc.randomChance;
  try {
    const { calc, attacker, defender } = session;
    if (nextAttack) {
      // 満タンでも次の攻撃後に回復が働く。倒される見込みなら回復は付けない。
      attacker.hp = Math.max(0, attacker.hp - Math.floor(attacker.maxhp * nextAttack.incoming / 100));
      defender.hp = Math.max(0, defender.hp - Math.floor(defender.maxhp * nextAttack.outgoing / 100));
    }
    const ownHp = attacker.hp;
    const foeHp = defender.hp;
    calc.randomChance = (n, d) => n >= d;
    // ターン終了時の実際のHP増減を一回分比較する。状態の残り時間は進めない。
    if (calc.field.weather) calc.eachEvent('Weather');
    for (const mon of [attacker, defender]) {
      if (mon.hp <= 0) continue;
      calc.singleEvent('Residual', mon.getStatus(), mon.statusState, mon);
      for (const id of ['saltcure', 'curse', 'leechseed', 'partiallytrapped', 'aquaring', 'ingrain']) {
        if (mon.volatiles[id]) calc.singleEvent('Residual', calc.dex.conditions.get(id), mon.volatiles[id], mon);
      }
      calc.singleEvent('Residual', mon.getAbility(), mon.abilityState, mon);
      if (!mon.ignoringItem()) calc.singleEvent('Residual', mon.getItem(), mon.itemState, mon);
      calc.runEvent('Update', mon);
    }
    return (attacker.hp - ownHp) / attacker.maxhp * 100 - (defender.hp - foeHp) / defender.maxhp * 100;
  } finally {
    restoreEffectSession(session, snapshot);
    session.calc.faintQueue = faintQueue;
    session.calc.randomChance = randomChance;
  }
}

function projectedAilmentPosition(session, pokemon, speciesName, foePlayer, ownMoves, includeResidual = true) {
  const position = projectedEffectPosition(session, pokemon, speciesName, foePlayer, ownMoves);
  const ownPlayer = foePlayer === 'p1' ? 'p2' : 'p1';
  const chance = (mon, player, moveId) => {
    if (mon.status === 'slp') {
      // 新規の眠りは初回行動を止める。既存の眠りだけ公開履歴から起床を予測する。
      const wake = battleState[player]?.status === 'slp' ? sleepWakeChance(player, mon.ability) : 0;
      const usable = mon.moveSlots.some((slot) => slot.pp > 0 && (slot.id === 'snore' || slot.id === 'sleeptalk'));
      return usable ? 1 : wake;
    }
    if (mon.status === 'frz') {
      if (session.calc.dex.moves.get(moveId).flags.defrost) return 1;
      return battleState[player]?.status === 'frz' ? cantMoveFactor('frz', player, mon.ability) : 1 / 4;
    }
    return mon.status === 'par' ? 7 / 8 : 1;
  };
  const ownChance = chance(session.attacker, ownPlayer, position.outgoingMove);
  const foeChance = chance(session.defender, foePlayer, position.incomingMove);
  const orderValue = position.value - position.outgoing + position.incoming;
  return { ...position, value: position.outgoing * ownChance - position.incoming * foeChance
    + orderValue * Math.min(ownChance, foeChance) + (includeResidual ? projectedResidualBalance(session, position) : 0) };
}

function projectedStatusEffect(session, prepared, pokemon, speciesName, foePlayer, ownMoves, apply) {
  const snapshot = snapshotEffectSession(session);
  try {
    const before = projectedAilmentPosition(session, pokemon, speciesName, foePlayer, ownMoves);
    const applied = !!apply();
    if (!applied) return { applied: false, score: 0 };
    session.calc.runEvent('Update', session.attacker);
    session.calc.runEvent('Update', session.defender);
    const after = projectedAilmentPosition(session, pokemon, speciesName, foePlayer, ownMoves);
    return { applied: true, score: after.value - before.value };
  } finally { restoreEffectSession(session, snapshot); }
}

function evaluateAilmentMove(move, pokemon, speciesName, ownBoosts, foeBoosts, request, ownPlayer, foePlayer, assumption) {
  const session = createPublicMoveSession(pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, 'max', assumption);
  try {
    applyEffectPublicField(session, ownPlayer, foePlayer);
    const prepared = session.calc.dex.getActiveMove(move);
    prepared.accuracy = true;
    session.calc.randomChance = (n, d) => d === 100 || n >= d;
    const result = projectedStatusEffect(session, prepared, pokemon, speciesName, foePlayer, pokemon.moves,
      () => session.calc.actions.useMove(prepared, session.attacker, { target: session.defender }));
    return { score: result.applied ? result.score * (move.accuracy === true ? 1 : move.accuracy / 100) : -100,
      failed: !result.applied, reason: result.applied ? '状態異常後の火力・速度・行動可能性・継続効果を比較' : '状態異常技が失敗' };
  } finally { session.calc.destroy(); }
}

function evaluatePersistentStatusMove(move, pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, assumption) {
  const session = createPublicMoveSession(pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, 'max', assumption);
  try {
    applyEffectPublicField(session, ownPlayer, foePlayer);
    const prepared = session.calc.dex.getActiveMove(move);
    prepared.accuracy = true;
    session.calc.randomChance = (n, d) => d === 100 || n >= d;
    const acted = session.calc.actions.useMove(prepared, session.attacker, { target: session.defender });
    session.calc.runEvent('Update', session.defender);
    const persists = !!session.defender.volatiles[move.volatileStatus];
    return { score: !acted ? -100 : !persists ? 0 : { taunt: 22, leechseed: 26, yawn: 24 }[move.id],
      failed: !acted, reason: !acted ? '既存状態・無効化などで効果が失敗' : !persists ? '持ち物などで効果が解除' : { taunt: 'ちょうはつ', leechseed: 'やどりぎのタネ', yawn: 'あくび' }[move.id] };
  } finally { session.calc.destroy(); }
}

function effectPPRemovalValue(session, beforeSlots, mon, source) {
  return beforeSlots.reduce((score, old) => {
    const remaining = mon.getMoveData(old.id)?.pp ?? old.pp;
    const removed = Math.max(0, old.pp - remaining);
    if (!removed) return score;
    const move = battleDex.moves.get(old.id);
    const threat = isDamagingMove(move) ? projectedEffectDamage(session, mon, source, move) || 10
      : move.heal || ['synthesis', 'rest', 'wish'].includes(move.id) ? 30 : move.status ? 25 : move.boosts ? 25 : 12;
    return score + removed / Math.max(1, old.pp) * Math.min(60, threat);
  }, 0);
}

function publicEffectResponses(move, pokemon, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, speciesName, assumption = null) {
  const model = publicActionModel(defenderPlayer, speciesName, assumption?.moves ? { moves: assumption.moves } : null);
  const expanded = [];
  for (const action of model) {
    if (action.move || action.unable) expanded.push(action);
    else {
      for (const profile of predictOpponentSets(defenderPlayer, speciesName)) {
        const unknown = profile.moves.filter((id) => !getRevealedMoves(defenderPlayer, speciesName).includes(id));
        for (const id of unknown) expanded.push({ move: battleDex.moves.get(id), weight: action.weight * profile.weight / unknown.length });
      }
    }
  }
  const context = { attackerPokemon: pokemon, defenderPokemon: null,
    attackerSpecies: battleDex.species.get(getPokemonSpeciesName(pokemon)), defenderSpecies: battleDex.species.get(speciesName),
    attackerBoosts: { ...createEmptyBoosts(), ...ownBoosts }, defenderBoosts: { ...createEmptyBoosts(), ...foeBoosts }, attackerPlayer, defenderPlayer, defenderAssumption: assumption };
  return expanded.map((action) => {
    const order = action.move ? publicMoveOrder(move, action.move, context) : 'own';
    const beforeOrder = order === 'opponent' ? 1 : order === 'uncertain' ? 0.5 : 0;
    const actionChance = action.unable ? 0 : action.move?.sleepUsable && battleState[defenderPlayer]?.status === 'slp' ? 1 : cantMoveFactor(battleState[defenderPlayer]?.status, defenderPlayer);
    return { ...action, beforeOrder, actionChance, beforeOwn: beforeOrder * actionChance };
  });
}

function rememberProjectedAction(session, action, player, speciesName) {
  const { calc, defender } = session;
  defender.lastMove = calc.dex.getActiveMove(action.id);
  let slot = defender.getMoveData(action.id);
  if (!slot) {
    const maxpp = calc.calculatePP(action, action.noPPBoosts ? 0 : 3);
    const used = battleState[player]?.ppUsed?.[baseSpeciesName(speciesName)]?.[action.id] || 0;
    slot = { id: action.id, move: action.name, target: action.target, pp: Math.max(0, maxpp - used), maxpp, disabled: false, disabledSource: '', used: !!used };
    defender.moveSlots.push(slot);
  }
  const pressureTargets = defender.getMoveTargets(action, session.attacker).pressureTargets;
  const extraPP = pressureTargets.reduce((sum, target) => {
    const value = calc.runEvent('DeductPP', target, defender, action);
    return sum + (value === true ? 0 : Number(value) || 0);
  }, 0);
  slot.pp = Math.max(0, slot.pp - 1 - extraPP);
}

function evaluateControlMove(move, pokemon, speciesName, ownBoosts, foeBoosts, request, ownPlayer, foePlayer, assumption = null) {
  const responses = publicEffectResponses(move, pokemon, ownBoosts, foeBoosts, ownPlayer, foePlayer, speciesName, assumption);
  const outcomes = [];
  for (const action of responses) {
    for (const [foeFirst, probability] of [[false, 1 - action.beforeOwn], [true, action.beforeOwn]]) {
      if (!probability) continue;
      const session = createPublicMoveSession(pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, 'max', assumption);
      try {
        const { calc, attacker, defender } = session;
        applyEffectPublicField(session, ownPlayer, foePlayer);
        seedPublicEffectState(session, pokemon, ownPlayer, foePlayer, request);
        if (foeFirst && action.move) rememberProjectedAction(session, action.move, foePlayer, speciesName);
        if (!foeFirst && action.move) calc.queue.push({ choice: 'move', pokemon: defender, move: calc.dex.getActiveMove(action.move), targetLoc: defender.getLocOf(attacker) });
        const before = projectedEffectPosition(session, pokemon, speciesName, foePlayer, pokemon.moves);
        const prepared = calc.dex.getActiveMove(move);
        prepared.accuracy = true;
        calc.randomChance = (n, d) => d === 100 || n >= d;
        const acted = calc.actions.useMove(prepared, attacker, { target: defender });
        calc.runEvent('Update', defender);
        const applied = !!acted && !!defender.volatiles[move.id];
        const after = projectedEffectPosition(session, pokemon, speciesName, foePlayer, pokemon.moves);
        outcomes.push({ weight: action.weight * probability, result: { score: applied ? after.value - before.value : -100,
          failed: !applied, hitChance: applied ? 1 : 0, successChance: applied ? 1 : 0,
          reason: applied ? `${move.name}で${defender.volatiles[move.id].move}を制限` : `${move.name}が失敗（直前技・PP・禁止技・重複・無効を確認）` } });
      } finally { session.calc.destroy(); }
    }
  }
  return averageEffectResults(outcomes, '公開された直前技と行動順から成功見込みを評価');
}

function evaluateTailwindMove(pokemon, speciesName, ownBoosts, foeBoosts, ownPlayer, foePlayer, request = null, assumption = null) {
  if (fieldState.sides[ownPlayer]?.tailwind) return { score: -100, failed: true, reason: 'すでにおいかぜ' };
  if (!ownPlayer || !pokemon?.stats) return { score: 0, reason: 'おいかぜ後の速度を判断できない' };
  const own = { ...createEmptyBoosts(), ...ownBoosts };
  const foe = { ...createEmptyBoosts(), ...foeBoosts };
  const speed = getSpeedEstimate(ownPlayer, pokemon, own, parseCondition(pokemon.condition).status, speciesName, foe, battleState[foePlayer]?.status, false, assumption);
  const session = createPublicMoveSession(pokemon, speciesName, own, foe, ownPlayer, foePlayer, 'max', assumption);
  try {
    applyEffectPublicField(session, ownPlayer, foePlayer);
    seedPublicEffectState(session, pokemon, ownPlayer, foePlayer, request);
    const attacks = effectProjectionMoves(pokemon, getPokemonSpeciesName(pokemon), null, pokemon.moves);
    const chance = (order) => order === 'own' ? 1 : order === 'uncertain' ? 0.5 : 0;
    const values = attacks.map((attack) => {
      const outgoing = projectedEffectDamage(session, session.attacker, session.defender, attack);
      if (!outgoing) return 0;
      return publicEffectResponses(attack, pokemon, own, foe, ownPlayer, foePlayer, speciesName, assumption).reduce((sum, action) => {
        if (!action.move) return sum;
        const incoming = projectedEffectDamage(session, session.defender, session.attacker, action.move);
        const order = (ownSpeed) => compareEstimatedMoveOrder(attack, action.move, ownSpeed, speed.opponentMinSpeed, speed.opponentMaxSpeed, ownPlayer, pokemon, assumption);
        return sum + action.weight * action.actionChance * (chance(order(speed.ownSpeed * 2)) - chance(order(speed.ownSpeed))) * Math.min(36, Math.max(outgoing, incoming) * 0.5);
      }, 0);
    });
    const score = values.length ? Math.max(...values) : 0;
    return { score, beforeSpeed: speed.ownSpeed, afterSpeed: speed.ownSpeed * 2,
      reason: `おいかぜ後の素早さ${speed.ownSpeed * 2} / 相手${speed.opponentMinSpeed}～${speed.opponentMaxSpeed} / ${score > 0 ? '攻撃の先手見込みが上昇' : score < 0 ? '行動順の変化が不利' : '攻撃の行動順は改善しない'}` };
  } finally { session.calc.destroy(); }
}

function projectedAttackBoostBranches(session, move) {
  if (!move || move.category === 'Status') return [{ weight: 1, boosts: [] }];
  const snapshot = snapshotEffectSession(session);
  try {
    const { calc, attacker, defender } = session;
    const prepared = prepareDamageMove(calc, defender, attacker, move);
    if (!calc.actions.hitStepTryHitEvent([attacker], defender, prepared)[0] || !calc.actions.hitStepTypeImmunity([attacker], defender, prepared)[0] || !calc.actions.hitStepTryImmunity([attacker], defender, prepared)[0]) return [{ weight: 1, boosts: [] }];
    const accuracy = readMoveHitChance(calc, defender, attacker, prepared);
    const effects = prepared.hasSheerForce ? [] : calc.runEvent('ModifySecondaries', attacker, defender, prepared, prepared.secondaries || (prepared.secondary ? [prepared.secondary] : [])) || [];
    let branches = [{ weight: 1, boosts: prepared.self?.boosts ? [prepared.self.boosts] : [] }];
    for (const effect of effects) {
      if (!effect.self?.boosts) continue;
      const chance = Math.min(100, effect.chance ?? 100) / 100;
      branches = branches.flatMap((branch) => [
        { weight: branch.weight * (1 - chance), boosts: branch.boosts },
        { weight: branch.weight * chance, boosts: [...branch.boosts, effect.self.boosts] },
      ]).filter((branch) => branch.weight);
    }
    return [{ weight: 1 - accuracy, boosts: [] }, ...branches.map((branch) => ({ ...branch, weight: branch.weight * accuracy }))].filter((branch) => branch.weight);
  } finally { restoreEffectSession(session, snapshot); }
}

function callbackEffectScore(session, prepared, effect, move, pokemon, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, speciesName) {
  const { calc, attacker, defender } = session;
  const snapshot = snapshotEffectSession(session);
  const sample = calc.sample;
  const contextual = ['burningjealousy', 'alluringvoice', 'eeriespell'].includes(move.id);
  const scenarios = contextual ? publicEffectResponses(move, pokemon, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, speciesName, session.effectAssumption)
    : [{ weight: 1, beforeOwn: 0 }];
  let score = 0;
  try {
    for (const action of scenarios) {
      for (const [foeActsFirst, orderWeight] of [[false, 1 - action.beforeOwn], [true, action.beforeOwn]]) {
        if (!orderWeight) continue;
        let choices = 1;
        const values = [];
        restoreEffectSession(session, snapshotEffectCopy(snapshot));
        const boostBranches = foeActsFirst ? projectedAttackBoostBranches(session, action.move) : [{ weight: 1, boosts: [] }];
        for (let index = 0; index < choices; index++) {
          let value = 0;
          for (const branch of boostBranches) {
            restoreEffectSession(session, snapshotEffectCopy(snapshot));
            if (foeActsFirst && action.move) {
              rememberProjectedAction(session, action.move, defenderPlayer, speciesName);
              const selfBoost = action.move.target === 'self' && action.move.boosts || action.move.self?.boosts;
              if (action.move.category === 'Status' && (selfBoost || ['bellydrum', 'stockpile', 'stuffcheeks'].includes(action.move.id))) {
                const foeMove = calc.dex.getActiveMove(action.move.id);
                const target = ['self', 'allySide', 'allyTeam', 'allies', 'adjacentAllyOrSelf'].includes(foeMove.target) ? defender : attacker;
                calc.setActiveMove(foeMove, defender, target);
                calc.actions.useMove(foeMove, defender, { target });
              }
              for (const boosts of branch.boosts) calc.boost(boosts, defender, defender, action.move);
            }
            calc.sample = (items) => { choices = Math.max(choices, items.length); return items[index % items.length]; };
            const before = effectConditionValue(defender) - effectConditionValue(attacker);
            const statusBefore = effectStatusValue(defender) - effectStatusValue(attacker);
            const oldStatuses = [attacker.status, defender.status];
            const statusPosition = projectedAilmentPosition(session, pokemon, speciesName, defenderPlayer, pokemon.moves);
            const ppBefore = defender.moveSlots.map((slot) => ({ ...slot }));
            calc.setActiveMove(prepared, attacker, defender);
            calc.singleEvent('Hit', effect, {}, defender, attacker, prepared);
            let delta = effectConditionValue(defender) - effectConditionValue(attacker) - before;
            if (attacker.status !== oldStatuses[0] || defender.status !== oldStatuses[1]) {
              calc.runEvent('Update', attacker); calc.runEvent('Update', defender);
              delta -= effectStatusValue(defender) - effectStatusValue(attacker) - statusBefore;
              delta += projectedAilmentPosition(session, pokemon, speciesName, defenderPlayer, pokemon.moves).value - statusPosition.value;
            }
            value += branch.weight * (delta + effectPPRemovalValue(session, ppBefore, defender, attacker));
          }
          values.push(value);
        }
        score += action.weight * orderWeight * values.reduce((sum, value) => sum + value, 0) / values.length;
      }
    }
    return score;
  } finally { calc.sample = sample; restoreEffectSession(session, snapshot); }
}

function restoreEffectSession(session, snapshot) {
  [session.attacker, session.defender].forEach((mon, index) => Object.assign(mon, snapshot[index]));
}

function effectProjectionMoves(pokemon, speciesName, player = null, ownMoveIds = null) {
  let ids = ownMoveIds || pokemon?.moves;
  if (!ids && player) {
    const revealed = getRevealedMoves(player, speciesName);
    ids = [...revealed];
    if (revealed.length < 4) ids.push(...predictOpponentSets(player, speciesName).flatMap((set) => set.moves || []));
  }
  if (!ids || !ids.length) ids = getLearnedDamagingMoveIds(speciesName);
  const candidates = [...new Set(ids)].map((id) => battleDex.moves.get(id)).filter((move) => isMoveAllowed(move) && isDamagingMove(move));
  // 技が不明な場合も物理・特殊を両方残す。実際の4技が分かっていればその4技だけを使う。
  if (!ownMoveIds && !pokemon?.moves && !player) {
    return ['Physical', 'Special'].flatMap((category) => candidates.filter((move) => move.category === category)
      .sort((a, b) => b.basePower - a.basePower).slice(0, 3));
  }
  return candidates;
}

function projectedEffectDamage(session, source, target, move) {
  const snapshot = snapshotEffectSession(session);
  try {
    const { calc } = session;
    if (source.getMoveData(move.id)?.pp === 0) return 0;
    if (source.volatiles.disable?.move === move.id) return 0;
    if (source.volatiles.encore?.move && source.volatiles.encore.move !== move.id && move.id !== 'struggle') return 0;
    if (source.volatiles.choicelock?.move && source.volatiles.choicelock.move !== move.id && source.getItem().isChoice && !source.ignoringItem() && move.id !== 'struggle') return 0;
    if (source.volatiles.torment && source.lastMove?.id === move.id) return 0;
    if (target.volatiles.imprison && target.hasMove(move.id) && move.id !== 'struggle') return 0;
    const prepared = prepareDamageMove(calc, source, target, move);
    if (!prepared) return 0;
    if (!calc.actions.hitStepTryHitEvent([target], source, prepared)[0] ||
        !calc.actions.hitStepTypeImmunity([target], source, prepared)[0] ||
        !calc.actions.hitStepTryImmunity([target], source, prepared)[0]) return 0;
    const accuracy = readMoveHitChance(calc, source, target, prepared);
    const critChance = readCritChance(calc, source, target, prepared);
    prepared.willCrit = false;
    calc.random = (n = 2) => n === 16 ? 7 : 0;
    const normalMove = { ...prepared, allies: prepared.allies?.slice() };
    const normal = Number(calc.actions.getDamage(source, target, normalMove, true)) || 0;
    prepared.willCrit = true;
    const criticalMove = { ...prepared, allies: prepared.allies?.slice() };
    const critical = critChance ? Number(calc.actions.getDamage(source, target, criticalMove, true)) || 0 : normal;
    const damage = normal * (1 - critChance) + critical * critChance;
    const hits = hitBounds(prepared, source).expected;
    return Math.min(target.hp, Math.max(0, Number(damage) || 0) * hits) / target.maxhp * 100 * accuracy;
  } finally { restoreEffectSession(session, snapshot); }
}

function projectedEffectPosition(session, pokemon, opponentSpeciesName, defenderPlayer, ownMoveIds = null) {
  const { attacker, defender, calc } = session;
  const own = attacker.moveSlots.length && attacker.moveSlots.every((slot) => !slot.pp) ? [battleDex.moves.get('struggle')] : effectProjectionMoves(pokemon, getPokemonSpeciesName(pokemon), null, ownMoveIds);
  const foe = defender.moveSlots.length && defender.moveSlots.every((slot) => !slot.pp) ? [battleDex.moves.get('struggle')] : effectProjectionMoves(null, opponentSpeciesName, defenderPlayer, session.effectAssumption?.moves);
  const best = (source, target, list) => list.map((move) => ({ move, damage: projectedEffectDamage(session, source, target, move) }))
    .sort((a, b) => b.damage - a.damage)[0] || { move: battleDex.moves.get('tackle'), damage: 0 };
  const outgoing = best(attacker, defender, own);
  const incoming = best(defender, attacker, foe);
  if (!ownMoveIds && !pokemon.moves) {
    const categories = ['Physical', 'Special'].filter((category) => own.some((move) => move.category === category));
    if (categories.length) outgoing.damage = categories.reduce((sum, category) =>
      sum + best(attacker, defender, own.filter((move) => move.category === category)).damage, 0) / categories.length;
  }
  const priority = (mon, target, move) => {
    calc.setActiveMove(move, mon, target);
    return calc.runEvent('ModifyPriority', mon, target, move, move.priority);
  };
  const priorityDelta = priority(attacker, defender, outgoing.move) - priority(defender, attacker, incoming.move);
  const speedDelta = attacker.getActionSpeed() - defender.getActionSpeed();
  const order = priorityDelta ? Math.sign(priorityDelta) : Math.sign(speedDelta);
  // 先手の価値は、その対面で実際に攻撃できる量に応じる。同速は中間。
  const orderValue = order * Math.min(15, Math.max(outgoing.damage, incoming.damage) / 4);
  return { outgoing: outgoing.damage, incoming: incoming.damage, outgoingMove: outgoing.move.id, incomingMove: incoming.move.id,
    order, value: outgoing.damage - incoming.damage + orderValue };
}

const STATE_EFFECT_MOVES = new Set([
  'psychup', 'haze', 'clearsmog', 'heartswap', 'powerswap', 'guardswap', 'speedswap',
  'powertrick', 'powersplit', 'guardsplit', 'topsyturvy', 'spectralthief',
  'defog', 'rapidspin', 'mortalspin', 'tidyup', 'courtchange', 'strengthsap',
  'soak', 'magicpowder', 'reflecttype', 'conversion', 'conversion2', 'camouflage',
  'simplebeam', 'worryseed', 'entrainment', 'skillswap', 'roleplay', 'gastroacid',
  'bellydrum', 'stockpile', 'stuffcheeks', 'acupressure', 'focusenergy', 'laserfocus', 'magnetrise',
  'confuseray', 'sweetkiss', 'teeterdance', 'meanlook', 'block', 'octolock',
  'trickortreat', 'forestscurse', 'gravity', 'magicroom', 'wonderroom',
  'aquaring', 'ingrain', 'wish', 'healbell', 'aromatherapy', 'refresh', 'purify',
  'corrosivegas', 'thief', 'covet', 'pluck', 'bugbite', 'stoneaxe', 'ceaselessedge',
  'icespinner', 'steelroller', 'burnup', 'doubleshock', 'sparklingaria',
  'transform', 'spite', 'lockon', 'safeguard', 'swallow', 'torment', 'recycle', 'imprison',
  'healingwish', 'electrify', 'fairylock', 'magneticflux', 'teatime', 'instruct', 'healpulse',
  'wideguard', 'quickguard', 'jawlock', 'fellstinger',
  'trick', 'switcheroo',
]);

function moveEffectEvaluationKind(move, pokemon = null) {
  if (!isMoveAllowed(move)) return 'シングルの利用制限で登録・選択対象外';
  if (move.category === 'Status' && move.status && targetsOpponent(move)) return '状態異常後の火力・速度・行動可能性・継続効果を比較';
  if (['taunt', 'leechseed', 'yawn'].includes(move.id)) return '公開された既存状態を復元し実際の成功・即時解除を評価';
  if (['sandstorm', 'snowscape', 'hail'].includes(move.id)) return '天候前後の対面・継続効果と自分の控えを比較';
  if (move.stallingMove) return '連続成功率・防げる被害・接触時の効果を評価';
  if (['encore', 'disable'].includes(move.id)) return '直前技・PP・行動順から成功と制限の利益を評価';
  if (move.id === 'tailwind') return '使用後の速度・優先度・トリックルームを比較';
  if (move.id === 'copycat') return '公開された直前の技を呼び出して評価';
  if (hasProjectedStateEffect(move, pokemon)) return '効果前後の対面を比較';
  if (['pollenpuff', 'shellsidearm'].includes(move.id)) return 'シングルの対象・分類変化をエンジンで計算';
  return null;
}

function hasHandledAdditionalEffect(move) {
  return ['fellstinger', 'pollenpuff', 'jawlock', 'shellsidearm', 'burningjealousy', 'eeriespell', 'alluringvoice'].includes(move.id);
}

function shellSideArmContactChance(pokemon, opponentSpeciesName, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer) {
  let chance = 0;
  for (const stat of ['def', 'spd']) {
    for (const endpoint of ['min', 'max']) {
      for (const physicalTie of [false, true]) {
        const assumed = rangedCombatant(battleDex.species.get(opponentSpeciesName), stat, endpoint, foeBoosts, defenderPlayer);
        const session = createPublicMoveSession(pokemon, opponentSpeciesName, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, endpoint, assumed);
        try {
          session.calc.randomChance = (n, d) => d === 2 ? physicalTie : n >= d;
          const prepared = prepareDamageMove(session.calc, session.attacker, session.defender, battleDex.moves.get('shellsidearm'));
          if (prepared.flags.contact) chance += 1 / 8;
        } finally { session.calc.destroy(); }
      }
    }
  }
  return chance;
}

function hasProjectedStateEffect(move, pokemon = null) {
  return !!(move.boosts || move.self?.boosts || move.selfSwitch || move.forceSwitch || STATE_EFFECT_MOVES.has(move.id) ||
    (move.id === 'curse' && pokemon && !battleDex.species.get(getPokemonSpeciesName(pokemon)).types.includes('Ghost')));
}

function applyEffectPublicField(session, attackerPlayer, defenderPlayer) {
  const ids = { stealthRock: 'stealthrock', spikes: 'spikes', toxicSpikes: 'toxicspikes', stickyWeb: 'stickyweb',
    reflect: 'reflect', lightScreen: 'lightscreen', auroraVeil: 'auroraveil', tailwind: 'tailwind', safeguard: 'safeguard', mist: 'mist' };
  for (const [mon, player] of [[session.attacker, attackerPlayer], [session.defender, defenderPlayer]]) {
    if (!player) continue;
    for (const [key, id] of Object.entries(ids)) {
      mon.side.removeSideCondition(id);
      const value = fieldState.sides[player]?.[key];
      if (!value) continue;
      mon.side.addSideCondition(id, session.attacker);
      if (typeof value === 'number' && mon.side.sideConditions[id]) mon.side.sideConditions[id].layers = value;
    }
  }
  if (fieldState.trickRoom) session.calc.field.addPseudoWeather('trickroom', session.attacker);
  if (fieldState.fairyLockUntil != null && fieldState.fairyLockUntil >= speedLearningState.turn) session.calc.field.addPseudoWeather('fairylock', session.attacker);
}

function effectHazardBurden(side, pokemon) {
  if (!pokemon || pokemon.hasItem('heavydutyboots') || pokemon.hasAbility('magicguard')) return 0;
  const conditions = side.sideConditions;
  let value = conditions.stealthrock ? 12.5 * getTypeMultiplier('Rock', pokemon.getTypes()) : 0;
  if (pokemon.isGrounded()) {
    if (conditions.spikes) value += [0, 12.5, 100 / 6, 25][conditions.spikes.layers || 1];
    if (conditions.toxicspikes && !pokemon.hasType('Poison') && !pokemon.hasType('Steel') && !pokemon.status) value += 12;
    if (conditions.stickyweb) value += 10;
  }
  return value;
}

function effectOwnHazardBurden(side, active, bench) {
  const values = [effectHazardBurden(side, active)];
  for (const pokemon of bench) {
    const species = battleDex.species.get(getPokemonSpeciesName(pokemon));
    const ability = normalizeBattleEffect(pokemon.ability);
    const item = normalizeBattleEffect(pokemon.item);
    values.push(effectHazardBurden(side, {
      status: parseCondition(pokemon.condition).status,
      hasItem: (id) => item === id, hasAbility: (id) => ability === id,
      hasType: (type) => species.types.includes(type), getTypes: () => species.types,
      isGrounded: () => isPokemonGrounded(pokemon),
    }));
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function projectedStatusThreat(session, pokemon, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, speciesName) {
  const { calc, attacker, defender } = session;
  let score = 0;
  for (const action of publicEffectResponses(battleDex.moves.get('safeguard'), pokemon, ownBoosts, foeBoosts, attackerPlayer, defenderPlayer, speciesName, session.effectAssumption)) {
    if (!action.move || action.unable) continue;
    const snapshot = snapshotEffectSession(session);
    try {
      const prepared = prepareDamageMove(calc, defender, attacker, action.move);
      if (!calc.actions.hitStepTryHitEvent([attacker], defender, prepared)[0] || !calc.actions.hitStepTryImmunity([attacker], defender, prepared)[0] || calc.runEvent('TryPrimaryHit', attacker, defender, prepared) !== true) continue;
      const accuracy = readMoveHitChance(calc, defender, attacker, prepared);
      const effects = action.move.category === 'Status'
        ? [{ chance: 100, status: prepared.status, volatileStatus: prepared.volatileStatus }]
        : calc.runEvent('ModifySecondaries', attacker, defender, prepared, prepared.secondaries || (prepared.secondary ? [prepared.secondary] : []));
      for (const effect of effects || []) {
        const before = effectConditionValue(attacker);
        if (effect.status) attacker.trySetStatus(effect.status, defender, prepared);
        if (effect.volatileStatus) attacker.addVolatile(effect.volatileStatus, defender, prepared);
        if (effect.onHit) calc.singleEvent('Hit', effect, {}, attacker, defender, prepared);
        score += action.weight * accuracy * Math.min(100, effect.chance ?? 100) / 100 * Math.max(0, effectConditionValue(attacker) - before);
        restoreEffectSession(session, snapshotEffectCopy(snapshot));
      }
    } finally { restoreEffectSession(session, snapshot); }
  }
  return score;
}

function projectedTrapValue(session, pokemon, speciesName, ownMoves, ownBench, foeBench, attackerPlayer, defenderPlayer, position) {
  const { calc, attacker, defender } = session;
  calc.runEvent('TrapPokemon', attacker);
  calc.runEvent('TrapPokemon', defender);
  let score = 0;
  if (attacker.trapped && ownBench.length) {
    const values = ownBench.map((bench) => {
      const next = createPublicMoveSession(bench, speciesName, {}, defender.boosts, attackerPlayer, defenderPlayer);
      try { applyEffectPublicField(next, attackerPlayer, defenderPlayer); return projectedEffectPosition(next, bench, speciesName, defenderPlayer, bench.moves).value - effectHazardBurden(next.attacker.side, next.attacker); }
      finally { next.calc.destroy(); }
    });
    score -= Math.max(0, Math.max(...values) - position.value);
  }
  if (defender.trapped && foeBench.length) {
    const values = foeBench.map((name) => {
      const next = createPublicMoveSession(pokemon, name, attacker.boosts, {}, attackerPlayer, defenderPlayer);
      try { applyEffectPublicField(next, attackerPlayer, defenderPlayer); return projectedEffectPosition(next, pokemon, name, defenderPlayer, ownMoves).value + effectHazardBurden(next.defender.side, next.defender); }
      finally { next.calc.destroy(); }
    });
    score += Math.max(0, position.value - Math.min(...values));
  }
  return score;
}

function projectedItemSupport(session, mon, position, own) {
  if (mon.ignoringItem()) return 0;
  const snapshot = snapshotEffectSession(session);
  const incoming = own ? position.incoming : position.outgoing;
  try {
    // 次の一撃後の回復・きのみ・状態付与をエンジンに問い合わせる。
    mon.hp = Math.max(1, mon.hp - Math.floor(mon.maxhp * incoming / 100));
    const hp = mon.hp;
    const condition = effectConditionValue(mon);
    session.calc.singleEvent('Residual', mon.getItem(), mon.itemState, mon);
    session.calc.runEvent('Update', mon);
    let score = (mon.hp - hp) / mon.maxhp * 80 + condition - effectConditionValue(mon);
    if (mon.getItem().isChoice || mon.hasItem('assaultvest')) {
      const lostOptions = mon.moveSlots.filter((slot) => slot.pp > 0).map((slot) => session.calc.dex.moves.get(slot.id)).filter((move) => move.category === 'Status').map((move) => {
        if (move.heal || move.id === 'rest') return Math.min(50, (mon.maxhp - hp) / mon.maxhp * 100) * 0.8;
        if (move.boosts) return Object.entries(move.boosts).some(([stat, amount]) => amount > 0 && mon.boosts[stat] < 6) ? Math.min(30, incoming) : 0;
        if (move.status) return Math.min(30, incoming);
        return 0;
      });
      if (lostOptions.length) score -= Math.max(...lostOptions) / Math.max(1, mon.moveSlots.length);
    }
    return score;
  } finally { restoreEffectSession(session, snapshot); }
}

function evaluateProjectedStateEffect(move, pokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, sampleIndex = null, damageRoll = 7, hpEndpoint = 'max', forceCrit = false, defenderAssumption = null) {
  const session = createPublicMoveSession(pokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, hpEndpoint, defenderAssumption);
  try {
    const { calc, attacker, defender } = session;
    applyEffectPublicField(session, attackerPlayer, defenderPlayer);
    seedPublicEffectState(session, pokemon, attackerPlayer, defenderPlayer, request);
    const ownMoves = request?.active?.[0]?.moves?.map((entry) => entry.id) || pokemon.moves;
    const ownBench = (request?.side?.pokemon || []).filter((mon) => !mon.active && !mon.condition.includes('fnt'));
    const foeBench = benchSpeciesNames(defenderPlayer);
    attacker.side.pokemonLeft = 1 + ownBench.length;
    defender.side.pokemonLeft = 1 + foeBench.length;
    if (move.id === 'healingwish' && !ownBench.length) return { score: -100, reason: 'いやしのねがいで交代できる控えがいない' };
    calc.canSwitch = (side) => side === attacker.side ? ownBench.length : foeBench.length;
    const before = projectedEffectPosition(session, pokemon, opponentSpeciesName, defenderPlayer, ownMoves);
    const itemBefore = ['trick', 'switcheroo'].includes(move.id) ? projectedItemSupport(session, attacker, before, true) - projectedItemSupport(session, defender, before, false) : 0;
    const statusThreatBefore = move.id === 'safeguard' ? projectedStatusThreat(session, pokemon, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName) : 0;
    const trapBefore = ['jawlock', 'fairylock'].includes(move.id) ? projectedTrapValue(session, pokemon, opponentSpeciesName, ownMoves, ownBench, foeBench, attackerPlayer, defenderPlayer, before) : 0;
    const ownHazards = effectOwnHazardBurden(attacker.side, attacker, ownBench);
    const foeHazards = effectHazardBurden(defender.side, defender);
    const hpBefore = attacker.hp;
    const foeHpBefore = defender.hp;
    const conditionsBefore = effectConditionValue(defender) - effectConditionValue(attacker);
    const ownVolatilesBefore = new Set(Object.keys(attacker.volatiles));
    const transformedBefore = attacker.transformed;
    const ppBefore = defender.moveSlots.map((slot) => ({ ...slot }));
    const pending = publicEffectResponses(move, pokemon, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName, defenderAssumption).find((action) => action.move && action.actionChance);
    if (['wideguard', 'quickguard', 'electrify', 'instruct'].includes(move.id) && pending) {
      calc.queue.push({ choice: 'move', pokemon: defender, move: calc.dex.getActiveMove(pending.move), targetLoc: defender.getLocOf(attacker) });
    }
    // 条件付き成功時を一度実行し、命中率は呼び出し側で一度だけ掛ける。
    calc.randomChance = (n, d) => d === 100 || n >= d;
    calc.random = (n = 2) => n === 16 ? damageRoll : n === 100 ? 99 : 0;
    const prepared = calc.dex.getActiveMove(move);
    prepared.accuracy = true;
    prepared.willCrit = forceCrit;
    prepared.secondary = move.id === 'sparklingaria' ? prepared.secondary : null;
    prepared.secondaries = move.id === 'sparklingaria' ? prepared.secondaries : [];
    let sampleChoices = 1;
    calc.sample = (values) => { sampleChoices = Math.max(sampleChoices, values.length); return values[(sampleIndex || 0) % values.length]; };
    const target = ['self', 'adjacentAllyOrSelf', 'allyTeam', 'allySide'].includes(move.target) ? attacker : defender;
    calc.setActiveMove(prepared, attacker, target);
    const acted = calc.actions.useMove(prepared, attacker, { target });
    if (move.id === 'instruct' && calc.queue.list.length > 1 && defender.lastMove) {
      const repeated = calc.dex.getActiveMove(defender.lastMove);
      defender.deductPP(repeated.id, 1);
      const repeatedTarget = ['self', 'allySide', 'allyTeam'].includes(repeated.target) ? defender : attacker;
      calc.setActiveMove(repeated, defender, repeatedTarget);
      calc.actions.useMove(repeated, defender, { target: repeatedTarget });
    }
    if (move.id === 'sparklingaria' && calc.activeMove) calc.singleEvent('AfterMove', calc.activeMove, null, attacker, defender, calc.activeMove);
    if (['recycle', 'teatime'].includes(move.id)) {
      calc.runEvent('Update', attacker);
      calc.runEvent('Update', defender);
    }
    const healing = move.category === 'Status' ? (attacker.hp - hpBefore) / attacker.maxhp * 100 * 0.8 : 0;
    const sacrificed = attacker.hp <= 0;
    const knockedOut = defender.hp <= 0;
    const opponentHpValue = move.category === 'Status' ? (foeHpBefore - defender.hp) / defender.maxhp * 100 * 0.8 : 0;
    // 主ダメージ・吸収・反動は既存の計算に含まれるため、将来の対面比較ではHPを揃える。
    attacker.hp = hpBefore;
    defender.hp = foeHpBefore;
    const afterMoves = move.id === 'transform' && attacker.transformed ? attacker.moveSlots.map((slot) => slot.id) : ownMoves;
    const after = projectedEffectPosition(session, pokemon, opponentSpeciesName, defenderPlayer, afterMoves);
    let score = after.value - before.value + healing + opponentHpValue + ownHazards - effectOwnHazardBurden(attacker.side, attacker, ownBench)
      - foeHazards + effectHazardBurden(defender.side, defender);
    score += effectConditionValue(defender) - effectConditionValue(attacker) - conditionsBefore;
    if (['trick', 'switcheroo'].includes(move.id)) score += projectedItemSupport(session, attacker, after, true) - projectedItemSupport(session, defender, after, false) - itemBefore;
    if (move.id === 'spite') score += effectPPRemovalValue(session, ppBefore, defender, attacker);
    if (move.id === 'safeguard') score += 2 * (statusThreatBefore - projectedStatusThreat(session, pokemon, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName));
    if (['jawlock', 'fairylock'].includes(move.id)) score += projectedTrapValue(session, pokemon, opponentSpeciesName, afterMoves, ownBench, foeBench, attackerPlayer, defenderPlayer, after) - trapBefore;
    if (['electrify', 'wideguard', 'quickguard'].includes(move.id)) {
      const responses = publicEffectResponses(move, pokemon, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName, defenderAssumption);
      const beforeChance = responses.reduce((sum, action) => sum + action.weight * action.actionChance * (1 - action.beforeOrder), 0);
      score *= beforeChance;
    }
    // 遅延回復は、今の不足HPを上限に一回分を評価する。
    for (const id of ['aquaring', 'ingrain']) {
      if (attacker.volatiles[id] && !ownVolatilesBefore.has(id)) score += Math.min(100 / 16, (attacker.maxhp - hpBefore) / attacker.maxhp * 100) * 0.8;
    }
    if (attacker.side.slotConditions?.[attacker.position]?.wish) score += Math.min(50, (attacker.maxhp - hpBefore) / attacker.maxhp * 100) * 0.8;
    const notes = ['能力・対面の変化'];
    if (move.id === 'fellstinger' && knockedOut && foeBench.length) {
      const deltas = foeBench.map((name) => {
        const next = createPublicMoveSession(pokemon, name, attacker.boosts, {}, attackerPlayer, defenderPlayer);
        const prior = createPublicMoveSession(pokemon, name, ownBoosts, {}, attackerPlayer, defenderPlayer);
        try {
          applyEffectPublicField(next, attackerPlayer, defenderPlayer);
          applyEffectPublicField(prior, attackerPlayer, defenderPlayer);
          return projectedEffectPosition(next, pokemon, name, defenderPlayer, ownMoves).value - projectedEffectPosition(prior, pokemon, name, defenderPlayer, ownMoves).value;
        } finally { next.calc.destroy(); prior.calc.destroy(); }
      });
      score += deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      notes.push('KO後の相手の控えに対する攻撃上昇');
    }
    if (move.id === 'spite') notes.push('PP減少（公開履歴から残量推定）');
    if (['wideguard', 'quickguard'].includes(move.id)) notes.push('対応する攻撃を防ぐ');
    if (move.id === 'electrify') notes.push('先に動ける場合だけ相手の技を電気に変える');
    if (move.id === 'recycle') notes.push('公開された消費アイテムを回収');
    if (move.id === 'swallow') notes.push('たくわえた回数で回復し能力上昇を解除');
    if (move.id === 'transform') notes.push('公開技と構成候補から変身後を推定');
    if (['trick', 'switcheroo'].includes(move.id)) notes.push('持ち物交換後の火力・速度・回復・技の制約を比較');
    if (move.id === 'recycle' && !pokemon.item && attacker.hasItem('leftovers')) {
      score += Math.min(100 / 16, (attacker.maxhp - hpBefore) / attacker.maxhp * 100 + after.incoming) * 0.8;
    }
    if (Math.abs(ownHazards - effectOwnHazardBurden(attacker.side, attacker, ownBench)) > 0.01 ||
        Math.abs(foeHazards - effectHazardBurden(defender.side, defender)) > 0.01) notes.push('設置技の増減');
    if (attacker.switchFlag && ownBench.length) {
      const positions = ownBench.map((bench) => {
        const next = createPublicMoveSession(bench, opponentSpeciesName, move.id === 'batonpass' ? attacker.boosts : {}, defender.boosts, attackerPlayer, defenderPlayer);
        try {
          applyEffectPublicField(next, attackerPlayer, defenderPlayer);
          return projectedEffectPosition(next, bench, opponentSpeciesName, defenderPlayer, bench.moves).value - effectHazardBurden(next.attacker.side, next.attacker);
        } finally { next.calc.destroy(); }
      });
      score += Math.max(...positions) - after.value;
      notes.push('控えへの交代');
    }
    if (defender.forceSwitchFlag && foeBench.length) {
      // 控えの技・HPは公開情報だけから予測し、交代後の対面を平均する。
      const values = foeBench.map((name) => {
        const next = createPublicMoveSession(pokemon, name, attacker.boosts, {}, attackerPlayer, defenderPlayer);
        try {
          applyEffectPublicField(next, attackerPlayer, defenderPlayer);
          return projectedEffectPosition(next, pokemon, name, defenderPlayer, ownMoves).value + effectHazardBurden(next.defender.side, next.defender);
        } finally { next.calc.destroy(); }
      });
      score += values.reduce((sum, value) => sum + value, 0) / values.length - after.value;
      notes.push('相手を交代させる');
    }
    if (['healbell', 'aromatherapy'].includes(move.id)) {
      for (const bench of ownBench) {
        if (!parseCondition(bench.condition).status || (move.id === 'healbell' && ['soundproof', 'goodasgold'].includes(normalizeBattleEffect(bench.ability)))) continue;
        const next = createPublicMoveSession(bench, opponentSpeciesName, {}, opponentBoosts, attackerPlayer, defenderPlayer);
        try {
          const old = effectConditionValue(next.attacker);
          const position = projectedEffectPosition(next, bench, opponentSpeciesName, defenderPlayer, bench.moves);
          if (next.attacker.cureStatus()) score += 0.5 * (old + projectedEffectPosition(next, bench, opponentSpeciesName, defenderPlayer, bench.moves).value - position.value);
        } finally { next.calc.destroy(); }
      }
      notes.push('控えの状態異常治癒');
    }
    if (move.id === 'healingwish' && hpBefore > 0 && sacrificed) {
      const outcomes = ownBench.map((bench) => {
        const next = createPublicMoveSession(bench, opponentSpeciesName, {}, opponentBoosts, attackerPlayer, defenderPlayer);
        try {
          applyEffectPublicField(next, attackerPlayer, defenderPlayer);
          const hp = next.attacker.hp;
          const statusValue = effectConditionValue(next.attacker);
          next.attacker.side.addSlotCondition(next.attacker, 'healingwish', next.attacker, move);
          const state = next.attacker.side.slotConditions[next.attacker.position].healingwish;
          next.calc.singleEvent('Swap', next.calc.dex.conditions.get('healingwish'), state, next.attacker);
          return projectedEffectPosition(next, bench, opponentSpeciesName, defenderPlayer, bench.moves).value - before.value
            + (next.attacker.hp - hp) / next.attacker.maxhp * 80 + statusValue - effectConditionValue(next.attacker) - effectHazardBurden(next.attacker.side, next.attacker);
        } finally { next.calc.destroy(); }
      });
      score += Math.max(...outcomes);
      notes.push('本人の犠牲と控えの回復・治癒・対面を比較');
    }
    if (sampleChoices > 1 && sampleIndex === null) {
      const outcomes = [score];
      for (let index = 1; index < sampleChoices; index++) outcomes.push(evaluateProjectedStateEffect(move, pokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, index, damageRoll, hpEndpoint, forceCrit, defenderAssumption).score);
      return { score: outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length, reason: `${notes.join(' ')} / ランダム効果${sampleChoices}候補の平均`, outcomes };
    }
    const failed = move.id === 'transform' ? !attacker.transformed || transformedBefore
      : !acted && ['spite', 'lockon', 'swallow', 'recycle', 'magneticflux', 'healpulse', 'instruct', 'teatime', 'trick', 'switcheroo'].includes(move.id);
    if (failed) score = -100;
    return { score, reason: `${notes.join(' ')}${!acted ? ' / 効果が失敗または変化なし' : ''}`, before, after, ownBoosts: { ...attacker.boosts }, opponentBoosts: { ...defender.boosts }, switched: !!attacker.switchFlag, forcedSwitch: !!defender.forceSwitchFlag, acted: !!acted, failed, ownItem: attacker.item, ownStatus: attacker.status, opponentStatus: defender.status, ownMoves: afterMoves };
  } finally { session.calc.destroy(); }
}

function statusMoveFailReason(session, move) {
  const { calc, attacker, defender } = session;
  const prepared = prepareDamageMove(calc, attacker, defender, move);
  if (move.target === 'foeSide') {
    return calc.runEvent('TryHitSide', defender, attacker, prepared) ? null : '相手側への変化技が無効・反射';
  }
  if (!calc.actions.hitStepTryHitEvent([defender], attacker, prepared)[0]) return '特性などで無効・反射';
  if (!calc.actions.hitStepTypeImmunity([defender], attacker, prepared)[0] ||
      !calc.actions.hitStepTryImmunity([defender], attacker, prepared)[0]) return 'タイプなどで無効';
  if (calc.runEvent('TryPrimaryHit', defender, attacker, prepared) !== true) return 'みがわりに防がれる';
  if (prepared.status && !defender.setStatus(prepared.status, attacker, prepared)) return '状態異常が無効';
  return null;
}

function evaluateHealingMove(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer) {
  const session = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer);
  try {
    const before = session.attacker.hp;
    session.calc.actions.useMove(move.id, session.attacker, session.attacker);
    const restored = (session.attacker.hp - before) / session.attacker.maxhp * 100;
    return restored > 0
      ? { score: restored * 0.8, minDamagePercent: 0, maxDamagePercent: 0, reason: `回復${restored.toFixed(0)}%` }
      : { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: '満タンなどで回復できない' };
  } finally { session.calc.destroy(); }
}

function evaluatePainSplit(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer) {
  const outcomes = ['min', 'max'].map((endpoint) => {
    const session = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, endpoint);
    try {
      const ownBefore = session.attacker.hp;
      const foeBefore = session.defender.hp;
      session.calc.randomChance = () => true;
      session.calc.actions.useMove('painsplit', session.attacker, session.defender);
      return {
        gained: (session.attacker.hp - ownBefore) / session.attacker.maxhp * 100,
        removed: (foeBefore - session.defender.hp) / session.defender.maxhp * 100,
      };
    } finally { session.calc.destroy(); }
  });
  const gained = outcomes.reduce((sum, outcome) => sum + outcome.gained, 0) / outcomes.length;
  const removed = outcomes.reduce((sum, outcome) => sum + outcome.removed, 0) / outcomes.length;
  const range = (key) => outcomes.map((outcome) => outcome[key]).sort((a, b) => a - b);
  const ownRange = range('gained');
  const foeRange = range('removed');
  return {
    score: gained * 0.8 + removed * 0.6,
    reason: `いたみわけ 自分HP${ownRange.map((value) => `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`).join('～')} / 相手を削る${foeRange.map((value) => `${value.toFixed(0)}%`).join('～')}`,
    ownHpChangePercent: gained,
    opponentHpRemovedPercent: removed,
  };
}

function predictYawnSleepChance(player, pokemon = null) {
  const state = battleState[player];
  if (!state?.volatiles.yawn || (state.yawnDueTurn !== null && state.yawnDueTurn > speedLearningState.turn) || (pokemon ? parseCondition(pokemon.condition).status : state.status)) return 0;
  const foe = player === 'p1' ? 'p2' : 'p1';
  const spec = pokemon ? knownCombatant(pokemon, state.boosts) : rangedCombatant(battleDex.species.get(state.species), 'def', 'max', state.boosts, player);
  const profiles = pokemon ? [{ ability: spec.ability, item: spec.item, weight: 1 }] : predictOpponentSets(player, state.species);
  let chance = 0;
  for (const profile of profiles) {
    const session = createDamageBattle({ ...spec, ability: profile.ability, item: profile.item }, rangedCombatant(battleDex.species.get(battleState[foe].species), 'def', 'max', battleState[foe].boosts, foe), foe);
    try {
      applyPublicCalcState(session.attacker, player, spec);
      if (!session.attacker.trySetStatus('slp', session.defender)) continue;
      session.calc.runEvent('Update', session.attacker);
      if (session.attacker.status === 'slp') chance += profile.weight;
    } finally { session.calc.destroy(); }
  }
  return Math.min(1, chance);
}

function evaluateYawnRisk(player, pokemon, move = null, hitChance = 1) {
  if (!pokemon) return { penalty: 0, chance: 0 };
  const sleepChance = predictYawnSleepChance(player, pokemon);
  if (!sleepChance) return { penalty: 0, chance: 0 };
  const escape = move?.selfSwitch ? Math.min(1, Math.max(0, hitChance)) : 0;
  const moves = (pokemon.moves || []).map((id) => battleDex.moves.get(id)).filter((move) => isMoveAllowed(move));
  const usableAsleep = moves.some((candidate) => candidate.id === 'snore' || (candidate.id === 'sleeptalk' && moves.some((called) => called.id !== 'sleeptalk' && !called.flags.nosleeptalk && !called.flags.charge)));
  const lostActions = normalizeBattleEffect(pokemon.ability) === 'earlybird' ? 2 / 3 : 5 / 3;
  const chance = sleepChance * (1 - escape);
  return { chance, penalty: 40 * lostActions * chance * (usableAsleep ? 0.35 : 1), reason: chance ? 'あくびでターン終了後に眠る' : '交代技であくび回避' };
}

function effectProfileGroups(player, speciesName) {
  const groups = new Map();
  for (const profile of predictOpponentSets(player, speciesName)) {
    const key = JSON.stringify([profile.ability, profile.item, profile.moves]);
    const group = groups.get(key) || { ...profile, weight: 0 };
    group.weight += profile.weight;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function averageEffectResults(outcomes, note) {
  if (!outcomes.length) return { score: -100, failed: true, hitChance: 0, reason: '評価できる公開情報の候補がない' };
  const total = outcomes.reduce((sum, row) => sum + row.weight, 0);
  const failed = (result) => result.failed === true || (result.failed === undefined && result.score === -100 && !result.before);
  const allFailed = outcomes.every((row) => failed(row.result));
  const average = (key) => outcomes.reduce((sum, row) => sum + row.weight * (failed(row.result) ? 0 : row.result[key] ?? (key === 'hitChance' ? 1 : 0)), 0) / total;
  const result = { ...outcomes.find((row) => !failed(row.result))?.result || outcomes[0].result,
    score: allFailed ? -100 : average('score'), hitChance: average('hitChance'), failed: allFailed,
    reason: [...new Set(outcomes.map((row) => row.result.reason).filter(Boolean)), note].filter(Boolean).join(' / ') };
  for (const key of ['critChance', 'critFactor', 'yawnPenalty', 'opponentNextTurnSleepChance', 'successChance']) if (outcomes.some((row) => row.result[key] != null)) result[key] = average(key);
  for (const key of ['minDamagePercent', 'maxDamagePercent', 'critMaxDamagePercent']) {
    const values = outcomes.map((row) => failed(row.result) ? 0 : row.result[key] || 0);
    result[key] = key === 'minDamagePercent' ? Math.min(...values) : Math.max(...values);
  }
  return result;
}

function evaluateMove(moveRequest, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer = null, defenderPlayer = null, calledBySleepTalk = false, inferTraits = false, defenderAssumption = null) {
  const move = battleDex.moves.get(moveRequest.id);
  const activePokemon = request.side.pokemon.find((pokemon) => pokemon.active);
  // 仮説ごとの効果とダメージを同じ盤面で評価。公開状態を仮説の値で上書きしない。
  if (inferTraits && !defenderAssumption && activePokemon && isMoveAllowed(move) &&
      (hasProjectedStateEffect(move, activePokemon) || move.secondary || move.secondaries?.length || move.status || move.stallingMove || ['encore', 'disable', 'tailwind', 'copycat', 'taunt', 'leechseed', 'yawn', 'sandstorm', 'snowscape', 'hail'].includes(move.id))) {
    const profiles = effectProfileGroups(defenderPlayer, opponentSpeciesName);
    if (profiles.length) return averageEffectResults(profiles.map((profile) => ({ weight: profile.weight,
      result: evaluateMove(moveRequest, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, calledBySleepTalk, false, profile) })), '構成候補ごとの効果・損益を平均');
  }
  const result = evaluateMoveWhenAble(moveRequest, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, calledBySleepTalk, inferTraits, defenderAssumption);
  if (result.score === -100 && result.failed === undefined) result.failed = true;
  if (move.category === 'Status' && targetsOpponent(move) && activePokemon && !result.failed && (result.score >= 0 || result.failed === false || result.before || result.outcomes)) {
    const session = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, 'max', defenderAssumption);
    try {
      const prepared = prepareDamageMove(session.calc, session.attacker, session.defender, move);
      const chance = readMoveHitChance(session.calc, session.attacker, session.defender, prepared);
      const baseChance = move.accuracy === true ? 1 : move.accuracy / 100;
      result.score *= baseChance ? chance / baseChance : 0;
      result.hitChance = chance * (result.successChance ?? 1);
    } finally { session.calc.destroy(); }
    if (inferTraits) {
      const profiles = predictOpponentSets(defenderPlayer, opponentSpeciesName);
      let allowed = 0;
      for (const profile of profiles) {
        const assumed = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, 'max', { ability: profile.ability, item: profile.item });
        try { if (!statusMoveFailReason(assumed, move)) allowed += profile.weight; }
        finally { assumed.calc.destroy(); }
      }
      allowed = Math.min(1, allowed);
      result.score *= allowed;
      result.hitChance *= allowed;
      if (allowed < 1) result.reason = [result.reason, `構成候補の無効化を考慮${Math.round(allowed * 100)}%`].filter(Boolean).join(' / ');
    }
  }
  const status = attackerPlayer ? battleState[attackerPlayer].status : null;
  const selfThaw = status === 'frz' && move.flags.defrost;
  const asleep = status === 'slp' && !move.sleepUsable;
  const frozen = status === 'frz' && !selfThaw;
  const paralyzed = status === 'par';
  const chance = !calledBySleepTalk && (asleep || frozen || paralyzed) ? cantMoveFactor(status, attackerPlayer, activePokemon?.ability) : 1;
  if (!result.failed && (result.score >= 0 || result.failed === false) && chance < 1) {
    result.score = chance ? result.score * chance : 0;
    result.minDamagePercent = 0;
    if (chance === 0) {
      result.maxDamagePercent = 0;
      result.critMaxDamagePercent = 0;
    }
    result.hitChance = (result.hitChance ?? 1) * chance;
  }
  const reason = selfThaw ? '技でこおり解除' : !calledBySleepTalk && (asleep || frozen || paralyzed) ? `行動可能性${Math.round(chance * 100)}%` : null;
  if (reason) result.reason = [result.reason, reason].filter(Boolean).join(' / ');
  if (!calledBySleepTalk) {
    const yawn = evaluateYawnRisk(attackerPlayer, activePokemon, move, result.score > 0 ? result.hitChance ?? 1 : 0);
    result.score -= yawn.penalty;
    result.yawnPenalty = yawn.penalty;
    if (yawn.reason) result.reason = [result.reason, yawn.reason].filter(Boolean).join(' / ');
    const foeSleepChance = predictYawnSleepChance(defenderPlayer);
    result.opponentNextTurnSleepChance = foeSleepChance;
    if (foeSleepChance && move.category === 'Status' && ['self', 'allySide'].includes(move.target) && result.score > 0) {
      result.score += 12 * foeSleepChance;
      result.reason = [result.reason, '相手のあくびによる睡眠を見越す'].filter(Boolean).join(' / ');
    }
  }
  return result;
}

function evaluateMoveWhenAble(moveRequest, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer = null, defenderPlayer = null, calledBySleepTalk = false, inferTraits = false, defenderAssumption = null) {
  const move = battleDex.moves.get(moveRequest.id);

  const ownPokemon = battleDex.species.get(ownSpeciesName);

  const opponentPokemon = battleDex.species.get(opponentSpeciesName);

  const activePokemon = request.side.pokemon.find((pokemon) => pokemon.active);

  if (!activePokemon) {
    return {
      score: 0,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: null,
    };
  }

  const ownStatus = attackerPlayer ? battleState[attackerPlayer].status : null;

  const lockedMove = attackerPlayer && !calledBySleepTalk ? choiceLockedMove(attackerPlayer) : null;

  if (lockedMove && lockedMove !== move.id) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: 'こだわりで使えない',
    };
  }

  const ownAbility = normalizeBattleEffect(activePokemon.ability) || (attackerPlayer ? battleState[attackerPlayer]?.ability : null);

  if (!isMoveAllowed(move)) return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: moveRestriction(move) };
  if (move.id === 'copycat') {
    const copied = battleDex.moves.get(publicEffectHistory.lastMove?.id);
    if (!copied.exists || copied.flags.failcopycat || copied.isZ || copied.isMax || copied.id === 'copycat') {
      return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: 'まねっこで呼べる直前の公開技がない' };
    }
    const value = evaluateMove({ id: copied.id }, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, true, inferTraits, defenderAssumption);
    return { ...value, reason: `まねっこで${copied.name} / ${value.reason || '呼び出した効果を評価'}` };
  }

  if (['fakeout', 'firstimpression'].includes(move.id) && attackerPlayer && battleState[attackerPlayer].activeMoveActions > 0) {
    return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: '登場直後の行動でしか使えない' };
  }

  if (move.id === 'rest') {
    if (ownStatus === 'slp') return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: 'ねむっていてねむるは失敗' };
    const session = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer);
    try {
      const before = session.attacker.hp;
      session.calc.actions.useMove('rest', session.attacker, session.attacker);
      const restored = (session.attacker.hp - before) / session.attacker.maxhp * 100;
      if (restored <= 0) return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: 'ねむるが失敗する条件' };
      const cureBonus = ['brn', 'psn', 'tox', 'par'].includes(ownStatus) ? 12 : 0;
      return { score: restored * 0.8 + cureBonus - 12, minDamagePercent: 0, maxDamagePercent: 0, reason: `ねむる 回復${restored.toFixed(0)}% / ねむり2ターン` };
    } finally { session.calc.destroy(); }
  }

  if (move.id === 'sleeptalk') {
    if (ownStatus !== 'slp' && ownAbility !== 'comatose') return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: '起きているためねごとは失敗' };
    const moveIds = activePokemon.moves || request.active?.[0]?.moves.map((entry) => entry.id) || [];
    const calledMoves = moveIds.map((id) => battleDex.moves.get(id)).filter((called) => called.exists && isMoveAllowed(called) && !called.flags.nosleeptalk && !called.flags.charge && !called.isZ && !called.isMax);
    if (!calledMoves.length) return { score: -100, minDamagePercent: 0, maxDamagePercent: 0, reason: 'ねごとで呼べる技がない' };
    const outcomes = calledMoves.map((called) => evaluateMove({ id: called.id }, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, true, inferTraits, defenderAssumption));
    // 呼び出し失敗も等確率で含める。呼ばれる技を指定して確定KOとは扱わない。
    const asleepChance = ownAbility === 'comatose' ? 1 : 1 - sleepWakeChance(attackerPlayer, ownAbility);
    return { score: asleepChance ? outcomes.reduce((sum, outcome) => sum + (outcome.failed ? 0 : outcome.score), 0) / outcomes.length * asleepChance : 0,
      failed: false, minDamagePercent: 0, maxDamagePercent: 0, reason: `ねごと ${calledMoves.map((called) => called.name).join('/')}の平均評価（成功時の不利益を含む） / 睡眠継続${Math.round(asleepChance * 100)}%` };
  }

  if (move.category === 'Status' && (targetsOpponent(move) || move.target === 'foeSide')) {
    const session = createPublicMoveSession(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, 'max', defenderAssumption);
    try {
      const reason = statusMoveFailReason(session, move);
      if (reason) return { score: -100, failed: true, minDamagePercent: 0, maxDamagePercent: 0, reason };
    } finally { session.calc.destroy(); }
  }

  if (ownAbility === 'prankster' && move.category === 'Status' && targetsOpponent(move) && opponentPokemon.types?.includes('Dark')) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: 'いたずらごころ無効',
    };
  }

  if (effectiveMovePriority(move, attackerPlayer, activePokemon) > 0 && priorityBlocked(defenderPlayer, move)) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: 'サイコフィールド',
    };
  }

  // ========================================
  // 変化技
  // ========================================

  if (move.category === 'Status') {
    if (['encore', 'disable'].includes(move.id)) {
      return evaluateControlMove(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, defenderAssumption);
    }
    if (['taunt', 'leechseed', 'yawn'].includes(move.id)) {
      return { ...evaluatePersistentStatusMove(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, defenderAssumption), minDamagePercent: 0, maxDamagePercent: 0 };
    }
    if (move.status && targetsOpponent(move)) {
      return { ...evaluateAilmentMove(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, defenderAssumption), minDamagePercent: 0, maxDamagePercent: 0 };
    }
    if (move.target === 'self' && (move.heal || ['synthesis', 'morningsun', 'moonlight', 'shoreup'].includes(move.id))) {
      return evaluateHealingMove(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer);
    }
    const fieldMoveRepeatReason = getFieldMoveRepeatReason(move.id, attackerPlayer);

    if (fieldMoveRepeatReason) {
      return {
        score: -100,
        failed: true,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: fieldMoveRepeatReason,
      };
    }

    const weatherSetupEvaluation = evaluateWeatherSetupMove(move.id, request, ownSpeciesName, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer);

    if (weatherSetupEvaluation) {
      return {
        score: weatherSetupEvaluation.score,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: weatherSetupEvaluation.reason,
      };
    }

    const fieldSetupEvaluation = evaluateFieldSetupMove(move, activePokemon, opponentPokemon, opponentBoosts, opponentStatus, attackerPlayer, defenderPlayer, ownBoosts, request, defenderAssumption);

    if (fieldSetupEvaluation) {
      return {
        score: fieldSetupEvaluation.score,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: fieldSetupEvaluation.reason,
      };
    }

    const terrainStatusReason = getTerrainStatusBlockReason(move, isPokemonGrounded(activePokemon), isActiveGrounded(defenderPlayer, opponentPokemon));

    if (terrainStatusReason) {
      return {
        score: -100,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: terrainStatusReason,
      };
    }

    if (move.status && move.target !== 'self' && opponentStatus) {
      return {
        score: -100,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: '相手は状態異常済み',
      };
    }

    if (move.stallingMove) {
      const protectEvaluation = evaluateProtectMove(move, activePokemon, attackerPlayer, defenderPlayer, opponentSpeciesName, opponentBoosts, ownBoosts, request, defenderAssumption);

      if (protectEvaluation) {
        return protectEvaluation;
      }
    }

    if (hasProjectedStateEffect(move, activePokemon)) {
      const effect = evaluateProjectedStateEffect(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, null, 7, 'max', false, defenderAssumption);
      const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
      return { ...effect, score: effect.score * accuracy, minDamagePercent: 0, maxDamagePercent: 0 };
    }

    const sleepEvaluation = evaluateSleepStatusMove(move, activePokemon, opponentPokemon, opponentBoosts, defenderPlayer, attackerPlayer);

    if (sleepEvaluation) {
      return sleepEvaluation;
    }

    const utilityEvaluation = evaluateUtilityStatusMove(move, activePokemon, opponentPokemon, ownBoosts, defenderPlayer, attackerPlayer, opponentBoosts, opponentStatus, request, defenderAssumption);

    if (utilityEvaluation) {
      return {
        ...utilityEvaluation,
        minDamagePercent: 0,
        maxDamagePercent: 0,
      };
    }

    return {
      score: 0,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: '評価未対応の変化技',
    };
  }

  // ========================================
  // 攻撃技
  // ========================================

  if (!isDamagingMove(move)) {
    return {
      score: 0,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: null,
    };
  }

  const damageRange = (inferTraits ? estimateInferredBattleDamage : estimateBattleDamage)({
    move,
    attackerSpecies: ownPokemon,
    defenderSpecies: opponentPokemon,
    attackerPokemon: activePokemon,
    attackerBoosts: ownBoosts,
    defenderBoosts: opponentBoosts,
    defenderPlayer,
    defenderAssumption,
  });

  if (damageRange.immune) {
    const crash = move.hasCrashDamage && normalizeBattleEffect(activePokemon?.ability) !== 'magicguard';

    return {
      score: crash ? -50 : 0,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: crash ? '失敗反動' : (damageRange.failReason ?? '無効'),
    };
  }

  const ownMoveIds = request?.active?.[0]?.moves?.map((entry) => entry.id) || activePokemon.moves;
  const added = addedEffectScore(move, activePokemon, opponentStatus, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName, ownMoveIds, defenderAssumption);
  added.score = ((added.score - (added.selfScore || 0)) * (damageRange.bodyHitChance ?? 1) + (added.selfScore || 0)) * (damageRange.hitChance ?? 1);
  if (!damageRange.bodyHitChance) added.reason = added.selfScore > 0 ? '追加で能力上昇' : null;

  let primaryEffect = hasProjectedStateEffect(move, activePokemon)
    ? evaluateProjectedStateEffect(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, null, 7, 'max', false, defenderAssumption)
    : { score: 0, reason: null };
  if (move.id === 'fellstinger') {
    let score = 0;
    for (const endpoint of ['min', 'max']) {
      for (let roll = 0; roll < 16; roll++) {
        for (const [critical, weight] of [[false, 1 - damageRange.critChance], [true, damageRange.critChance]]) {
          if (!weight) continue;
          score += weight / 32 * evaluateProjectedStateEffect(move, activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, request, attackerPlayer, defenderPlayer, null, roll, endpoint, critical, defenderAssumption).score;
        }
      }
    }
    primaryEffect = { score, reason: 'とどめばりで倒せるダメージ乱数と急所の分だけ攻撃上昇を評価' };
  }
  primaryEffect.score *= damageRange.hitChance ?? 1;

  let contactChip = 0;

  const contactChance = move.id === 'shellsidearm' ? shellSideArmContactChance(activePokemon, opponentSpeciesName, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer) : move.flags?.contact ? 1 : 0;
  if (contactChance && ownAbility !== 'longreach' && normalizeBattleEffect(activePokemon.item) !== 'protectivepads' && defenderPlayer && battleState[defenderPlayer]?.item === 'rockyhelmet') {
    const hits = hitBounds(move, {
      ability: normalizeBattleEffect(activePokemon.ability),
      item: normalizeBattleEffect(activePokemon.item),
    });

    contactChip = (100 / 6) * (damageRange.bodyHits ?? hits.expected) * (damageRange.hitChance ?? 1) * contactChance;
  }

  let itemPenalty = 0;
  let itemReason = null;
  const defenderItem = defenderPlayer ? battleState[defenderPlayer]?.item : null;

  if (defenderItem === 'redcard') {
    itemPenalty = 24;
    itemReason = 'レッドカード';
  } else if (defenderItem === 'ejectbutton') {
    itemPenalty = 16;
    itemReason = 'だっしゅつボタン';
  }
  itemPenalty *= (damageRange.bodyHitChance ?? 1) * (damageRange.hitChance ?? 1);
  if (!damageRange.bodyHitChance) itemReason = null;

  const selfDrop = move.self?.boosts && Object.values(move.self.boosts).some((value) => value < 0);

  if (selfDrop && normalizeBattleEffect(activePokemon?.item) === 'ejectpack') {
    itemPenalty += 18;
    itemReason = 'だっしゅつパック';
  }

  let knockOffBonus = 0;

  if (move.id === 'knockoff' && defenderItem) {
    knockOffBonus = 18 * (damageRange.bodyHitChance ?? 1) * (damageRange.hitChance ?? 1);
    itemReason = itemReason ? `${itemReason} はたきおとす` : 'はたきおとす';
  }

  const reasons = [damageRange.substituteScore > 0 ? 'みがわりを削る' : null, move.id === 'struggle' ? 'わるあがき反動' : null, damageRange.recoilPercent > 0.5 ? '反動' : null, damageRange.recoilPercent < -0.5 ? '吸収' : null, defenderPlayer && battleState[defenderPlayer]?.ability === 'liquidooze' && move.drain ? 'ヘドロえき' : null, added.reason, Math.abs(primaryEffect.score) > 0.01 ? primaryEffect.reason : null, contactChip > 0 ? 'ゴツゴツメット' : null, itemReason].filter(Boolean);

  return {
    score: damageRange.score + damageRange.substituteScore - damageRange.recoilPercent + added.score + primaryEffect.score - contactChip - itemPenalty + knockOffBonus,
    minDamagePercent: damageRange.minDamagePercent,
    maxDamagePercent: damageRange.maxDamagePercent,
    weatherReason: damageRange.weatherReason,
    fieldReason: damageRange.fieldReason,
    reason: reasons.join(' ') || null,
    critChance: damageRange.critChance ?? 0,
    critFactor: damageRange.critFactor ?? 1,
    critMaxDamagePercent: damageRange.critMaxDamagePercent ?? 0,
    hitChance: damageRange.hitChance ?? 0,
  };
}

// ========================================
// ポケモン名取得
// ========================================

function getPokemonSpeciesName(pokemon) {
  return pokemon.details?.split(',')[0].trim();
}

function usesFixedDamage(move) {
  return Boolean(move?.ohko || move?.damage != null || typeof move?.damageCallback === 'function');
}

function isDamagingMove(move) {
  return Boolean(move?.exists && move.category !== 'Status' && (move.basePower || usesFixedDamage(move) || typeof move.basePowerCallback === 'function'));
}

function moveTypeMultiplier(move, defenderTypes) {
  const multiplier = getTypeMultiplier(move.type, defenderTypes);

  // 固定ダメージは無効のみ考慮し、弱点・半減では増減しない。
  return usesFixedDamage(move) ? (multiplier > 0 ? 1 : 0) : multiplier;
}

// ========================================
// 控えの攻撃性能
// ========================================

function estimatePokemonAttackScore(pokemon, opponentSpeciesName, defenderPlayer = null, attackerBoosts = null, defenderBoosts = null) {
  const ownSpeciesName = getPokemonSpeciesName(pokemon);

  const ownPokemon = battleDex.species.get(ownSpeciesName);

  const opponentPokemon = battleDex.species.get(opponentSpeciesName);

  if (!ownPokemon.exists || !opponentPokemon.exists) {
    return 0;
  }

  let bestScore = 0;

  for (const moveId of pokemon.moves) {
    const move = battleDex.moves.get(moveId);

    if (!isDamagingMove(move)) {
      continue;
    }

    const damageRange = estimateInferredBattleDamage({
      move,
      attackerSpecies: ownPokemon,
      defenderSpecies: opponentPokemon,
      attackerPokemon: pokemon,
      attackerBoosts, defenderBoosts,
      defenderPlayer,
    });

    if (damageRange.immune) {
      continue;
    }

    bestScore = Math.max(bestScore, damageRange.score - damageRange.recoilPercent);
  }

  return bestScore;
}

// ========================================
// タイプ倍率
// ========================================

function getTypeMultiplier(attackType, defenderTypes) {
  if (!battleDex.getImmunity(attackType, defenderTypes)) {
    return 0;
  }

  return 2 ** battleDex.getEffectiveness(attackType, defenderTypes);
}

// ========================================
// 守備相性
// ========================================

function getDefensiveMatchupScore(ownSpeciesName, opponentSpeciesName, revealedMoveIds = []) {
  const ownPokemon = battleDex.species.get(ownSpeciesName);

  const opponentPokemon = battleDex.species.get(opponentSpeciesName);

  const attackTypes = new Set(opponentPokemon.types);

  for (const moveId of revealedMoveIds) {
    const move = battleDex.moves.get(moveId);

    if (move.exists && move.category !== 'Status') {
      attackTypes.add(move.type);
    }
  }

  let worstMultiplier = 0;

  for (const attackType of attackTypes) {
    worstMultiplier = Math.max(worstMultiplier, getTypeMultiplier(attackType, ownPokemon.types));
  }

  if (worstMultiplier === 0) {
    return 40;
  }

  if (worstMultiplier <= 0.25) {
    return 30;
  }

  if (worstMultiplier <= 0.5) {
    return 20;
  }

  if (worstMultiplier === 1) {
    return 0;
  }

  if (worstMultiplier === 2) {
    return -25;
  }

  return -50;
}

// ========================================
// 公開技から受けるダメージを推定
// ========================================

function estimateIncomingDamage(defender, opponentSpeciesName, moveId, opponentBoosts, defenderPlayer = null, weather = fieldState.weather, responseMove = null, inferTraits = false, attackerAssumption = null) {
  const defenderSpeciesName = getPokemonSpeciesName(defender);

  const defenderSpecies = battleDex.species.get(defenderSpeciesName);

  const opponentSpecies = battleDex.species.get(opponentSpeciesName);

  const move = battleDex.moves.get(moveId);

  if (!isDamagingMove(move)) {
    return null;
  }

  const damageRange = (inferTraits ? estimateInferredBattleDamage : estimateBattleDamage)({
    move,
    attackerSpecies: opponentSpecies,
    defenderSpecies,
    defenderPokemon: defender,
    attackerBoosts: opponentBoosts,
    defenderPlayer,
    weather,
    responseMove,
    attackerAssumption,
  });

  if (!damageRange) {
    return null;
  }

  if (damageRange.immune) {
    return {
      moveName: move.name,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      expectedDamagePercent: 0,
    };
  }

  return {
    moveId: move.id,
    moveName: move.name,
    minDamagePercent: damageRange.minDamagePercent,
    maxDamagePercent: damageRange.maxDamagePercent,
    expectedDamagePercent: damageRange.score,
    hitChance: damageRange.hitChance,
    fieldReason: damageRange.fieldReason,
  };
}

// ========================================
// 交代時の危険度
// ========================================

const learnedDamagingMoveIds = new Map();

const guessedStabDamageCache = new Map();

const opponentSetCache = new Map();
const inferredDamageCache = new Map();

// 採用率データではなく、公開技・種族の能力・技の役割から置く構成候補。
// 対面が変わっても同じ4技セットを使い、実際の相手の構築は参照しない。
function predictOpponentSets(player, speciesName, revealedOverride = null) {
  const species = battleDex.species.get(speciesName);
  const state = battleState[player];
  if (!species.exists) return [];
  const entry = rosterByShowdownId.get(species.id);
  const revealed = [...new Set(revealedOverride || (player ? getRevealedMoves(player, species.name) : []))].filter((id) => isMoveAllowed(battleDex.moves.get(id))).slice(0, 4);
  const ability = revealedAbilityFor(player, species.name);
  const itemKnown = !!state && (Object.hasOwn(state.revealedItems, baseSpeciesName(species.name)) || (state.species === species.name && !!state.item));
  const item = revealedItemFor(player, species.name);
  const usedItems = Object.entries(state?.revealedItems || {}).filter(([name]) => name !== baseSpeciesName(species.name)).map(([, value]) => value).filter(Boolean);
  const key = JSON.stringify([player, species.name, revealed, ability, itemKnown, item, usedItems]);
  if (opponentSetCache.has(key)) return opponentSetCache.get(key);
  const learned = (learnsetByName.get(entry?.name) || []).map((row) => battleDex.moves.get(moveByChampionsId.get(row.id)?.showdownId)).filter((move) => move.exists && isMoveAllowed(move));
  const abilitiesByName = new Map(abilities.map((row) => [row.name, row.showdownId]));
  const abilityIds = ability ? [ability] : [...new Set(Object.values(entry?.abilities || species.abilities).filter(Boolean).map((name) => abilitiesByName.get(name) || normalizeBattleEffect(name)))];
  if (!abilityIds.length) abilityIds.push('');
  const knownMoves = revealed.map((id) => battleDex.moves.get(id));
  const physicalCount = knownMoves.filter((move) => move.category === 'Physical').length;
  const specialCount = knownMoves.filter((move) => move.category === 'Special').length;
  const roles = [];
  if (species.baseStats.atk >= species.baseStats.spa * 0.8 || physicalCount) roles.push({ name: 'physical', weight: species.baseStats.atk * (1 + physicalCount) });
  if (species.baseStats.spa >= species.baseStats.atk * 0.8 || specialCount) roles.push({ name: 'special', weight: species.baseStats.spa * (1 + specialCount) });
  if (species.baseStats.hp + species.baseStats.def + species.baseStats.spd >= 240 || knownMoves.some((move) => move.heal || move.status || move.volatileStatus === 'yawn')) roles.push({ name: 'bulky', weight: 70 + knownMoves.filter((move) => move.category === 'Status').length * 40 });
  if (!roles.length) roles.push({ name: 'physical', weight: 1 });
  const profiles = [];
  for (const role of roles) {
    const ids = [...revealed];
    const category = role.name === 'physical' ? 'Physical' : role.name === 'special' ? 'Special' : species.baseStats.atk >= species.baseStats.spa ? 'Physical' : 'Special';
    while (ids.length < 4) {
      const selected = ids.map((id) => battleDex.moves.get(id));
      const ranked = learned.filter((move) => !ids.includes(move.id)).map((move) => {
        let score = 0;
        if (isDamagingMove(move)) {
          const power = usesFixedDamage(move) ? 65 : move.basePower || 50;
          score = Math.min(power, 130) * (move.accuracy === true ? 1 : move.accuracy / 100);
          score *= species.types.includes(move.type) ? 1.5 : 1;
          score *= move.category === category ? 1 : 0.35;
          if (move.flags.charge || move.selfdestruct || move.flags.recharge) score *= 0.25;
          if (['counter', 'mirrorcoat', 'fakeout', 'firstimpression'].includes(move.id)) score *= 0.45;
          if (move.ohko) score *= 0.3;
          if (move.priority > 0) score *= 1.15;
          if (selected.some((other) => isDamagingMove(other) && other.type === move.type)) score *= 0.3;
          if (role.name === 'bulky' && selected.some(isDamagingMove)) score *= 0.5;
        } else {
          const boosts = move.boosts || {};
          const setup = (category === 'Physical' ? boosts.atk : boosts.spa) > 0;
          score = move.heal ? 105 : move.status || move.volatileStatus === 'yawn' ? 90 : ['stealthrock', 'spikes', 'protect', 'leechseed'].includes(move.id) ? 80 : setup ? 95 : ['taunt', 'encore', 'substitute'].includes(move.id) ? 65 : 5;
          score *= role.name === 'bulky' ? 1.3 : setup ? 1 : 0.65;
          if (!selected.some(isDamagingMove)) score *= 0.1;
          if (selected.some((other) => (move.heal && other.heal) || (move.status && other.status) || (setup && other.boosts && (other.boosts.atk > 0 || other.boosts.spa > 0)))) score *= 0.2;
        }
        return { move, score };
      }).sort((a, b) => b.score - a.score || a.move.id.localeCompare(b.move.id));
      if (!ranked.length) break;
      ids.push(ranked[0].move.id);
    }
    const hasStatus = knownMoves.some((move) => move.category === 'Status');
    let itemIds = role.name === 'bulky' ? ['leftovers', 'sitrusberry'] : hasStatus ? ['lifeorb', 'sitrusberry'] : role.name === 'physical' ? ['choiceband', 'choicescarf'] : ['choicespecs', 'choicescarf'];
    if (itemKnown) itemIds = [item];
    else {
      if (role.name !== 'bulky' && species.baseStats.hp + species.baseStats.def <= 150) itemIds[1] = 'focussash';
      itemIds = ['', ...itemIds.filter((id) => items.some((row) => row.showdownId === id) && !usedItems.includes(id))];
    }
    if (!itemIds.length) itemIds = [''];
    for (const itemId of itemIds) {
      const itemMoves = [...ids];
      if (['choiceband', 'choicespecs', 'choicescarf', 'assaultvest'].includes(itemId)) {
        for (let index = 0; index < itemMoves.length; index++) {
          if (revealed.includes(itemMoves[index]) || battleDex.moves.get(itemMoves[index]).category !== 'Status') continue;
          const replacement = learned.filter((move) => isDamagingMove(move) && !itemMoves.includes(move.id)).map((move) => ({
            move, score: (usesFixedDamage(move) ? 65 : move.basePower || 50) * (species.types.includes(move.type) ? 1.5 : 1) * (move.category === category ? 1 : 0.3) * (itemMoves.some((id) => battleDex.moves.get(id).type === move.type) ? 0.3 : 1) * (move.flags.charge || move.flags.recharge || move.selfdestruct ? 0.2 : 1),
          })).sort((a, b) => b.score - a.score);
          if (replacement[0]) itemMoves[index] = replacement[0].move.id;
        }
      }
      for (const abilityId of abilityIds) profiles.push({ role: role.name, moves: itemMoves, ability: abilityId, item: itemId, weight: role.weight / abilityIds.length / itemIds.length, inferred: !ability || !itemKnown || revealed.length < 4 });
    }
  }
  const total = profiles.reduce((sum, profile) => sum + profile.weight, 0);
  for (const profile of profiles) profile.weight /= total;
  if (opponentSetCache.size >= 256) opponentSetCache.clear();
  opponentSetCache.set(key, profiles);
  return profiles;
}

function estimateInferredBattleDamage(options) {
  const { attackerPokemon, defenderPokemon, attackerSpecies, defenderSpecies, defenderPlayer, move } = options;
  const attackerPlayer = options.attackerPlayer ?? (defenderPlayer === 'p1' ? 'p2' : 'p1');
  const player = attackerPokemon ? defenderPlayer : attackerPlayer;
  const species = attackerPokemon ? defenderSpecies : attackerSpecies;
  if ((!attackerPokemon && !defenderPokemon) || !player || ['counter', 'mirrorcoat'].includes(move.id)) return estimateBattleDamage(options);
  let profiles = predictOpponentSets(player, species.name);
  if (!attackerPokemon && !getRevealedMoves(player, species.name).includes(move.id)) profiles = profiles.filter((profile) => profile.moves.includes(move.id));
  if (!profiles.length) return estimateBattleDamage(options);
  const groups = new Map();
  for (const profile of profiles) {
    const key = JSON.stringify([profile.ability, profile.item]);
    const group = groups.get(key) || { ability: profile.ability, item: profile.item, weight: 0 };
    group.weight += profile.weight;
    groups.set(key, group);
  }
  const known = attackerPokemon || defenderPokemon;
  const key = JSON.stringify([move.id, knownCombatant(known, attackerPokemon ? options.attackerBoosts : options.defenderBoosts), attackerSpecies.name, defenderSpecies.name, options.attackerBoosts, options.defenderBoosts, options.weather, options.responseMove, battleState, fieldState, [...groups.values()]]);
  if (inferredDamageCache.has(key)) return inferredDamageCache.get(key);
  const total = profiles.reduce((sum, profile) => sum + profile.weight, 0);
  const outcomes = [...groups.values()].map((group) => ({ weight: group.weight / total, result: estimateBattleDamage({ ...options, [attackerPokemon ? 'defenderAssumption' : 'attackerAssumption']: { ability: group.ability, item: group.item } }) }));
  const average = (field) => outcomes.reduce((sum, row) => sum + (row.result[field] || 0) * row.weight, 0);
  const result = {
    ...outcomes[0].result,
    immune: outcomes.every((row) => row.result.immune),
    minDamagePercent: Math.min(...outcomes.flatMap((row) => [row.result.minDamagePercent, row.result.maxDamagePercent])),
    maxDamagePercent: Math.max(...outcomes.flatMap((row) => [row.result.minDamagePercent, row.result.maxDamagePercent])),
    critMaxDamagePercent: Math.max(...outcomes.map((row) => row.result.critMaxDamagePercent)),
    inferred: profiles.some((profile) => profile.inferred),
  };
  for (const field of ['score', 'hitChance', 'critChance', 'critFactor', 'substituteScore', 'bodyHitChance', 'bodyHits', 'recoilPercent']) result[field] = average(field);
  for (const field of ['hitChance', 'critChance', 'bodyHitChance']) result[field] = Math.max(0, Math.min(1, result[field]));
  result.fieldReason = [result.fieldReason, result.inferred ? '公開情報から構成候補を推定' : null].filter(Boolean).join(' / ') || null;
  if (inferredDamageCache.size >= 512) inferredDamageCache.clear();
  inferredDamageCache.set(key, result);
  return result;
}

function getLearnedDamagingMoveIds(speciesName) {
  if (learnedDamagingMoveIds.has(speciesName)) {
    return learnedDamagingMoveIds.get(speciesName);
  }

  const species = battleDex.species.get(speciesName);
  const rosterEntry = species.exists ? rosterByShowdownId.get(species.id) : null;
  const learned = rosterEntry ? learnsetByName.get(rosterEntry.name) : null;
  const moveIds = [];

  for (const learnedMove of learned ?? []) {
    const moveData = moveByChampionsId.get(learnedMove.id);
    const move = moveData ? battleDex.moves.get(moveData.showdownId) : null;

    if (!isDamagingMove(move)) {
      continue;
    }

    moveIds.push(move.id);
  }

  learnedDamagingMoveIds.set(speciesName, moveIds);

  return moveIds;
}

function hasRevealedDamagingMove(revealedMoveIds) {
  return revealedMoveIds.some((moveId) => {
    const move = battleDex.moves.get(moveId);

    return isDamagingMove(move);
  });
}

function guessIncomingDamage(defender, opponentSpeciesName, opponentBoosts, defenderPlayer, excludeMoveIds = [], responseMove = null) {
  const defenderStats = defender.stats ?? {};
  const attackerPlayer = defenderPlayer === 'p1' ? 'p2' : defenderPlayer === 'p2' ? 'p1' : null;
  const defenderState = defenderPlayer ? battleState[defenderPlayer] : null;
  const excluded = new Set(excludeMoveIds);
  // 自分の既知情報と公開盤面を含め、ランク・特性・持ち物などの変更を区別する。
  const cacheKey = JSON.stringify({
    opponentSpeciesName,
    opponentBoosts,
    defenderPlayer,
    defender: knownCombatant(defender, defenderState?.boosts),
    attackerState: attackerPlayer ? battleState[attackerPlayer] : null,
    defenderState,
    fieldState,
    level: currentBattleLevel(),
    excluded: [...excluded].sort(),
    responseMove,
  });

  if (guessedStabDamageCache.has(cacheKey)) {
    return guessedStabDamageCache.get(cacheKey);
  }

  const defenderSpecies = battleDex.species.get(getPokemonSpeciesName(defender));
  const defenderTypes = defenderSpecies.types;
  const attackerTypes = new Set(battleDex.species.get(opponentSpeciesName).types ?? []);
  const defenseStat = {
    Physical: defenderStats.def || 1,
    Special: defenderStats.spd || 1,
  };

  const candidates = getLearnedDamagingMoveIds(opponentSpeciesName)
    .map((moveId) => {
      const move = battleDex.moves.get(moveId);
      const accuracy = move.accuracy === true ? 100 : move.accuracy;
      const stab = attackerTypes.has(move.type) ? 1.5 : 1;

      return {
        moveId,
        fixed: usesFixedDamage(move),
        rough: ((move.basePower * (accuracy / 100) * getTypeMultiplier(move.type, defenderTypes) * stab * getScreenDamageMultiplier(defenderPlayer, move.category)) / defenseStat[move.category]) * getWeatherDamageMultiplier(move.type),
      };
    })
    .filter((candidate) => (candidate.fixed || candidate.rough > 0) && !excluded.has(candidate.moveId))
    .sort((a, b) => b.rough - a.rough)
    // 通常威力から概算できない固定ダメージ技も、必ず詳細計算に残す。
    .filter((candidate, index) => candidate.fixed || index < 8);

  const ranked = [];

  for (const candidate of candidates) {
    const damage = estimateIncomingDamage(defender, opponentSpeciesName, candidate.moveId, opponentBoosts, defenderPlayer, fieldState.weather, responseMove);

    if (!damage || damage.expectedDamagePercent <= 0) {
      continue;
    }

    ranked.push(damage);
  }

  ranked.sort((a, b) => b.expectedDamagePercent - a.expectedDamagePercent);

  const best = ranked[0];

  const guessed = best ? { ...best, guessed: true, options: ranked.slice(0, 8) } : null;

  guessedStabDamageCache.set(cacheKey, guessed);

  return guessed;
}

function hiddenMoveWeight(openSlots) {
  return [0, 0.45, 0.65, 0.8, 1][Math.min(Math.max(openSlots, 0), 4)];
}

function hiddenIncomingThreat(defender, opponentSpeciesName, opponentBoosts, defenderPlayer, revealedMoveIds, responseMove = null) {
  const revealed = [...new Set(revealedMoveIds)];
  const openSlots = Math.max(4 - revealed.length, 0);
  if (!openSlots) return null;
  const cacheKey = JSON.stringify(['sets', knownCombatant(defender, battleState[defenderPlayer]?.boosts), opponentSpeciesName, opponentBoosts, defenderPlayer, revealed, responseMove, battleState, fieldState]);
  if (guessedStabDamageCache.has(cacheKey)) return guessedStabDamageCache.get(cacheKey);
  const player = defenderPlayer === 'p1' ? 'p2' : 'p1';
  const profiles = predictOpponentSets(player, opponentSpeciesName, revealed);
  const rows = profiles.map((profile) => {
    const attacks = profile.moves.filter((id) => !revealed.includes(id) && isDamagingMove(battleDex.moves.get(id)) && !(battleState[player]?.species === opponentSpeciesName && moveBlockedByVolatile(player, battleDex.moves.get(id))));
    const damages = attacks.map((id) => estimateIncomingDamage(defender, opponentSpeciesName, id, opponentBoosts, defenderPlayer, fieldState.weather, responseMove, false, { ability: profile.ability, item: profile.item })).filter(Boolean);
    damages.sort((a, b) => b.expectedDamagePercent - a.expectedDamagePercent);
    return { profile, damage: damages[0] || null };
  });
  const damaging = rows.filter((row) => row.damage?.expectedDamagePercent > 0);
  if (!damaging.length) return null;
  const weight = hiddenMoveWeight(openSlots);
  const options = [...new Map(damaging.map((row) => [row.damage.moveId, row.damage])).values()];
  options.sort((a, b) => b.expectedDamagePercent - a.expectedDamagePercent);
  const result = {
    ...options[0], guessed: true,
    moveName: options.map((damage) => damage.moveName).join('/'),
    minDamagePercent: 0,
    maxDamagePercent: Math.max(...damaging.map((row) => row.damage.maxDamagePercent)),
    expectedDamagePercent: rows.reduce((sum, row) => sum + (row.damage?.expectedDamagePercent || 0) * row.profile.weight, 0) * weight,
    options, predictedSets: profiles,
    fieldReason: '公開技を含む4技構成の候補から推定',
  };
  if (guessedStabDamageCache.size >= 512) guessedStabDamageCache.clear();
  guessedStabDamageCache.set(cacheKey, result);
  return result;
}

function formatIncomingMoveName(damage) {
  if (!damage) {
    return '';
  }

  return damage.guessed ? `予想:${damage.moveName}` : damage.moveName;
}

function evaluateIncomingRisk(pokemon, opponentSpeciesName, revealedMoveIds, opponentBoosts, defenderPlayer = null) {
  const condition = parseCondition(pokemon.condition);

  const attackerPlayer = defenderPlayer === 'p1' ? 'p2' : defenderPlayer === 'p2' ? 'p1' : null;

  let worstDamage = null;

  for (const moveId of revealedMoveIds) {
    const revealedMove = battleDex.moves.get(moveId);

    if (attackerPlayer && moveBlockedByVolatile(attackerPlayer, revealedMove)) {
      continue;
    }

    const damage = estimateIncomingDamage(pokemon, opponentSpeciesName, moveId, opponentBoosts, defenderPlayer, fieldState.weather, null, true);

    if (!damage) {
      continue;
    }

    if (!worstDamage || damage.expectedDamagePercent > worstDamage.expectedDamagePercent) {
      worstDamage = damage;
    }
  }

  const encored = attackerPlayer ? battleState[attackerPlayer]?.volatiles?.encoreMove : null;

  if (encored) {
    const encoredDamage = estimateIncomingDamage(pokemon, opponentSpeciesName, encored, opponentBoosts, defenderPlayer, fieldState.weather, null, true);

    worstDamage = encoredDamage && encoredDamage.expectedDamagePercent > 0 ? encoredDamage : worstDamage;
  }

  const locked = attackerPlayer ? choiceLockedMove(attackerPlayer) : null;

  if (locked) {
    const lockedDamage = estimateIncomingDamage(pokemon, opponentSpeciesName, locked, opponentBoosts, defenderPlayer, fieldState.weather, null, true);

    worstDamage = lockedDamage && lockedDamage.expectedDamagePercent > 0 ? lockedDamage : worstDamage;
  } else if (encored) {
    // アンコール中は、ロックされた技以外を予想しない。
  } else if (!hasRevealedDamagingMove(revealedMoveIds)) {
    worstDamage = hiddenIncomingThreat(pokemon, opponentSpeciesName, opponentBoosts, defenderPlayer, revealedMoveIds);
  } else {
    const hidden = hiddenIncomingThreat(pokemon, opponentSpeciesName, opponentBoosts, defenderPlayer, revealedMoveIds);

    if (hidden && (!worstDamage || hidden.expectedDamagePercent > worstDamage.expectedDamagePercent)) {
      worstDamage = hidden;
    }
  }

  if (!worstDamage) {
    return {
      penalty: 0,
      damage: null,
      koRisk: null,
    };
  }

  let penalty = worstDamage.expectedDamagePercent;

  let koRisk = null;

  // ダメージ計算でタスキ・がんじょうと各打撃を処理済み。その結果でKOを判定する。
  if (!worstDamage.guessed && worstDamage.minDamagePercent >= condition.hpPercent && (worstDamage.hitChance ?? 1) >= 1) {
    penalty += 40;

    koRisk = '確定で倒れる危険';
  } else if (!worstDamage.guessed && worstDamage.maxDamagePercent >= condition.hpPercent) {
    penalty += 20 * (worstDamage.hitChance ?? 1);

    koRisk = '倒れる可能性';
  }

  penalty *= cantMoveFactor(attackerPlayer ? battleState[attackerPlayer]?.status : null, attackerPlayer);

  return {
    penalty,
    damage: worstDamage,
    koRisk,
  };
}

// ========================================
// 素早さ関係の評価点
// ========================================

function getSpeedRelationScore(relation) {
  if (relation === 'own') {
    return 15;
  }

  if (relation === 'opponent') {
    return -15;
  }

  return 0;
}

// ========================================
// 交代後の次ターンの素早さ関係を推定
//
// 交代すると能力ランクはリセットされるため、
// 交代候補側の spe ランクは 0 として扱う。
// 相手側は現在の能力ランク・状態異常と、
// これまでに学習した素早さレンジを使う。
// ========================================

function evaluateSwitchSpeed(observer, pokemon, opponentSpeciesName, opponentBoosts, opponentStatus) {
  const condition = parseCondition(pokemon.condition);

  const webDrop = fieldState.sides[observer]?.stickyWeb && isPokemonGrounded(pokemon) ? -1 : 0;

  const ownSpeed = getEffectiveSpeed(pokemon.stats.spe, webDrop, condition.status, getPublicSpeedModifiers(observer, pokemon));

  const opponentRange = getOpponentSpeedRange(observer, opponentSpeciesName, opponentBoosts, opponentStatus);

  let relation;

  if (fieldState.trickRoom) {
    if (ownSpeed < opponentRange.minSpeed) {
      relation = 'own';
    } else if (ownSpeed > opponentRange.maxSpeed) {
      relation = 'opponent';
    } else {
      relation = 'uncertain';
    }
  } else if (ownSpeed > opponentRange.maxSpeed) {
    relation = 'own';
  } else if (ownSpeed < opponentRange.minSpeed) {
    relation = 'opponent';
  } else {
    relation = 'uncertain';
  }

  return {
    ownSpeed,
    opponentMinSpeed: opponentRange.minSpeed,
    opponentMaxSpeed: opponentRange.maxSpeed,
    relation,
    score: getSpeedRelationScore(relation),
  };
}

// ========================================
// 交代候補評価
// ========================================

function incomingSwitchPenalty(risk, mode) {
  if (mode !== 'forced') {
    return risk.penalty;
  }

  let penalty = (risk.damage?.expectedDamagePercent ?? 0) * 0.35;

  if (risk.koRisk) {
    penalty += 25;
  }

  return penalty;
}

// 自分のいかくだけを見る。相手の特性は、公開されるまで無効化しない。
function intimidateReaction(abilityId) {
  if (['clearbody', 'whitesmoke', 'fullmetalbody', 'hypercutter', 'innerfocus', 'oblivious', 'owntempo'].includes(abilityId)) {
    return 'immune';
  }

  if (abilityId === 'contrary') {
    return 'contrary';
  }

  if (abilityId === 'mirrorarmor') {
    return 'mirrorarmor';
  }

  if (abilityId === 'defiant' || abilityId === 'guarddog') {
    return 'defiant';
  }

  if (abilityId === 'competitive') {
    return 'competitive';
  }

  return null;
}

function getIntimidateSwitch(pokemon, opponentBoosts, revealedMoveIds, opponentPlayer = null) {
  if (normalizeBattleEffect(pokemon.ability) !== 'intimidate' || !battleState[opponentPlayer]?.species) return null;
  const ownPlayer = opponentPlayer === 'p1' ? 'p2' : 'p1';
  const session = createPublicMoveSession(pokemon, battleState[opponentPlayer].species, {}, opponentBoosts, ownPlayer, opponentPlayer);
  try {
    const { calc, attacker, defender } = session;
    calc.singleEvent('Start', calc.dex.abilities.get('intimidate'), attacker.abilityState, attacker);
    return { boosts: { ...defender.boosts }, ownBoosts: { ...attacker.boosts }, bonus: 0, note: 'いかく後の能力で評価' };
  } finally { session.calc.destroy(); }
}

function evaluateSwitchCandidates(observer, request, opponentSpeciesName, revealedMoveIds, opponentBoosts, opponentStatus, mode = 'voluntary') {
  const opponentPlayer = observer === 'p1' ? 'p2' : 'p1';

  return request.side.pokemon
    .map((pokemon, index) => ({
      pokemon,
      slot: index + 1,
    }))
    .filter(({ pokemon }) => !pokemon.active && !pokemon.condition.includes('fnt'))
    .map(({ pokemon, slot }) => {
      const species = getPokemonSpeciesName(pokemon);

      const intimidate = getIntimidateSwitch(pokemon, opponentBoosts, revealedMoveIds, opponentPlayer);
      const attackScore = estimatePokemonAttackScore(pokemon, opponentSpeciesName, opponentPlayer, intimidate?.ownBoosts, intimidate?.boosts);

      const defenseScore = getDefensiveMatchupScore(species, opponentSpeciesName, revealedMoveIds);

      const condition = parseCondition(pokemon.condition);

      const hpFactor = Math.max(0.25, condition.hpPercent / 100);


      const incomingRisk = evaluateIncomingRisk(pokemon, opponentSpeciesName, revealedMoveIds, intimidate?.boosts ?? opponentBoosts, observer);

      const speedEvaluation = evaluateSwitchSpeed(observer, pokemon, opponentSpeciesName, opponentBoosts, opponentStatus);

      let incomingRiskPenalty = incomingSwitchPenalty(incomingRisk, mode);

      let intimidateNote = intimidate?.note ?? null;

      if (intimidate?.boosts && intimidate.boosts !== opponentBoosts && revealedMoveIds.length > 0) {
        const riskWithoutIntimidate = evaluateIncomingRisk(pokemon, opponentSpeciesName, revealedMoveIds, opponentBoosts, observer);

        const saved = incomingSwitchPenalty(riskWithoutIntimidate, mode) - incomingRiskPenalty;

        if (saved > 0.5) {
          intimidateNote = `いかく+${saved.toFixed(0)}`;
        }
      }

      const entryHazardRisk = getEntryHazardRisk(observer, pokemon);

      const residual = getEndOfTurnChange(species, {
        abilityId: normalizeBattleEffect(pokemon.ability),
        itemId: normalizeBattleEffect(pokemon.item),
        grounded: isPokemonGrounded(pokemon),
        status: condition.status,
      toxicCounter: condition.status === 'tox' ? 1 : 0,
      hpPercent: condition.hpPercent,
      volatiles: null,
    });

      const trickRoomScore = trickRoomPositionScore(speedEvaluation.relation);

      const score = (attackScore + defenseScore) * hpFactor + speedEvaluation.score + trickRoomScore + (intimidate?.bonus ?? 0) - incomingRiskPenalty - entryHazardRisk.penalty - residual.percent;

      return {
        species,
        slot,
        attackScore,
        defenseScore,
        incomingRisk,
        incomingRiskPenalty,
        entryHazardRisk,
        speedEvaluation,
        intimidateNote,
        residual,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function formatSwitchCandidate(candidate) {
  let text = `${candidate.species}=` + `${candidate.score.toFixed(1)}` + ` (攻` + `${candidate.attackScore.toFixed(1)}` + ` 守` + `${candidate.defenseScore.toFixed(1)}`;

  if (candidate.incomingRisk.damage) {
    const damage = candidate.incomingRisk.damage;

    text += ` 被` + `${formatIncomingMoveName(damage)} ` + `${damage.minDamagePercent.toFixed(1)}` + `〜` + `${damage.maxDamagePercent.toFixed(1)}%`;
  }

  if (candidate.incomingRisk.koRisk) {
    text += ` ${candidate.incomingRisk.koRisk}`;
  }

  if (candidate.entryHazardRisk.damagePercent > 0) {
    text += ` 場${candidate.entryHazardRisk.damagePercent.toFixed(1)}%`;
  }

  if (candidate.entryHazardRisk.statusRisk) {
    text += ` ${candidate.entryHazardRisk.statusRisk}`;
  }

  if (candidate.residual?.reason) {
    text += ` 終了${candidate.residual.percent >= 0 ? '-' : '+'}${Math.abs(candidate.residual.percent).toFixed(1)}`;
  }

  if (candidate.entryHazardRisk.koRisk) {
    text += ` ${candidate.entryHazardRisk.koRisk}`;
  }

  const speedEvaluation = candidate.speedEvaluation;

  if (candidate.intimidateNote) {
    text += ` ${candidate.intimidateNote}`;
  }

  if (speedEvaluation.relation === 'own') {
    text += ` 次先+${speedEvaluation.score}`;
  } else if (speedEvaluation.relation === 'opponent') {
    text += ` 次後${speedEvaluation.score}`;
  } else {
    text += ' 次速度不明';
  }

  text += ` [${speedEvaluation.ownSpeed}` + ` vs ` + `${speedEvaluation.opponentMinSpeed}〜` + `${speedEvaluation.opponentMaxSpeed}]`;

  text += ')';

  return text;
}

// ========================================
// 行動順の推定
// ========================================

function weatherSpeedMultiplier(abilityId, status) {
  if (abilityId === 'chlorophyll' && fieldState.weather === 'sun') {
    return 2;
  }

  if (abilityId === 'swiftswim' && fieldState.weather === 'rain') {
    return 2;
  }

  if (abilityId === 'sandrush' && fieldState.weather === 'sand') {
    return 2;
  }

  if (abilityId === 'slushrush' && (fieldState.weather === 'snow' || fieldState.weather === 'hail')) {
    return 2;
  }

  if (abilityId === 'surgesurfer' && fieldState.terrain === 'electric') {
    return 2;
  }

  if (abilityId === 'quickfeet' && status && status !== 'slp' && status !== 'frz') {
    return 1.5;
  }

  return 1;
}

function getPublicSpeedModifiers(player, pokemon = null) {
  const state = player ? battleState[player] : null;

  const requestItem = pokemon ? normalizeBattleEffect(pokemon.item) : null;

  const itemId = requestItem || state?.item || null;

  const isActive = pokemon ? Boolean(pokemon.active) : true;

  const abilityId = normalizeBattleEffect(pokemon?.ability) || state?.ability || null;

  const status = pokemon ? parseCondition(pokemon.condition).status : state?.status;

  return {
    scarf: itemId === 'choicescarf',
    unburden: Boolean(isActive && state?.unburden),
    tailwind: Boolean(player && fieldState.sides[player]?.tailwind),
    abilityId,
    abilityMultiplier: weatherSpeedMultiplier(abilityId, status),
  };
}

function applyKnownSpeedModifiers(speed, modifiers) {
  let result = speed;

  if (modifiers?.scarf) {
    result = Math.floor(result * 1.5);
  }

  if (modifiers?.unburden) {
    result *= 2;
  }

  if (modifiers?.tailwind) {
    result *= 2;
  }

  if (modifiers?.abilityMultiplier && modifiers.abilityMultiplier !== 1) {
    result = Math.floor(result * modifiers.abilityMultiplier);
  }

  return result;
}

function formatSpeedModifiers(modifiers) {
  const labels = [];

  if (modifiers?.scarf) {
    labels.push('スカーフ');
  }

  if (modifiers?.unburden) {
    labels.push('かるわざ');
  }

  if (modifiers?.tailwind) {
    labels.push('おいかぜ');
  }

  if (modifiers?.abilityMultiplier > 1) {
    labels.push('特性素早さ');
  }

  return labels.length ? `(${labels.join('+')})` : '';
}

function getEffectiveSpeed(baseSpeed, boostStage, status, modifiers) {
  let speed = Math.floor(baseSpeed * getBoostMultiplier(boostStage));

  // まひは素早さ1/2。はやあしなら下がらず、特性側で1.5倍する。
  if (status === 'par' && modifiers?.abilityId !== 'quickfeet') {
    speed = Math.floor(speed * 0.5);
  }

  return applyKnownSpeedModifiers(speed, modifiers);
}

function getOpponentSpeedRange(observer, opponentSpeciesName, opponentBoosts, opponentStatus, inferTraits = false, assumption = null) {
  const knowledge = ensureSpeedKnowledge(observer, opponentSpeciesName);

  const opponent = observer === 'p1' ? 'p2' : 'p1';

  const modifiers = { ...getPublicSpeedModifiers(opponent) };
  if (assumption) Object.assign(modifiers, { scarf: assumption.item === 'choicescarf', abilityId: assumption.ability, abilityMultiplier: weatherSpeedMultiplier(assumption.ability, opponentStatus) });
  const range = getEffectiveCandidateRange(knowledge.candidates, opponentBoosts.spe, opponentStatus, modifiers);
  if (inferTraits) {
    for (const profile of predictOpponentSets(opponent, opponentSpeciesName)) {
      const modifiers = { ...getPublicSpeedModifiers(opponent), scarf: profile.item === 'choicescarf', abilityId: profile.ability, abilityMultiplier: weatherSpeedMultiplier(profile.ability, opponentStatus) };
      const predicted = getEffectiveCandidateRange(knowledge.candidates, opponentBoosts.spe, opponentStatus, modifiers);
      range.minSpeed = Math.min(range.minSpeed, predicted.minSpeed);
      range.maxSpeed = Math.max(range.maxSpeed, predicted.maxSpeed);
    }
  }

  return {
    ...range,
    observations: knowledge.observations,
  };
}

function getSpeedEstimate(observer, activePokemon, ownBoosts, ownStatus, opponentSpeciesName, opponentBoosts, opponentStatus, inferTraits = false, assumption = null) {
  const ownSpeed = getEffectiveSpeed(activePokemon.stats.spe, ownBoosts.spe, ownStatus, getPublicSpeedModifiers(observer, activePokemon));

  const opponentSpeedRange = getOpponentSpeedRange(observer, opponentSpeciesName, opponentBoosts, opponentStatus, inferTraits, assumption);

  let relation;

  if (ownSpeed > opponentSpeedRange.maxSpeed) {
    relation = 'own';
  } else if (ownSpeed < opponentSpeedRange.minSpeed) {
    relation = 'opponent';
  } else {
    relation = 'uncertain';
  }

  return {
    ownSpeed,
    opponentMinSpeed: opponentSpeedRange.minSpeed,
    opponentMaxSpeed: opponentSpeedRange.maxSpeed,
    observations: opponentSpeedRange.observations,
    relation,
  };
}

function compareEstimatedMoveOrder(ownMove, opponentMove, ownSpeed, opponentMinSpeed, opponentMaxSpeed, observer = null, ownPokemon = null, opponentPokemon = null) {
  const opponentPlayer = observer === 'p1' ? 'p2' : observer === 'p2' ? 'p1' : null;
  if (opponentPokemon) opponentPokemon = { condition: `${battleState[opponentPlayer]?.hpPercent ?? 100}/100 ${battleState[opponentPlayer]?.status || ''}`, ...opponentPokemon };
  const ownPriority = effectiveMovePriority(ownMove, observer, ownPokemon);
  const opponentPriority = effectiveMovePriority(opponentMove, opponentPlayer, opponentPokemon);

  if (opponentPriority > 0 && priorityBlocked(observer, opponentMove)) {
    return 'own';
  }

  if (ownPriority > 0 && priorityBlocked(opponentPlayer, ownMove)) {
    return 'opponent';
  }

  if (ownPriority > opponentPriority) {
    return 'own';
  }

  if (ownPriority < opponentPriority) {
    return 'opponent';
  }

  const ownFractional = fractionalMovePriority(ownMove, observer, ownPokemon);
  const opponentFractional = fractionalMovePriority(opponentMove, opponentPlayer, opponentPokemon);

  if (ownFractional > opponentFractional) {
    return 'own';
  }

  if (ownFractional < opponentFractional) {
    return 'opponent';
  }

  if (fieldState.trickRoom) {
    if (ownSpeed < opponentMinSpeed) {
      return 'own';
    }

    if (ownSpeed > opponentMaxSpeed) {
      return 'opponent';
    }

    return 'uncertain';
  }

  if (ownSpeed > opponentMaxSpeed) {
    return 'own';
  }

  if (ownSpeed < opponentMinSpeed) {
    return 'opponent';
  }

  return 'uncertain';
}

// ========================================
// 行動前に倒される危険
// ========================================

function evaluatePreMoveThreat(observer, activePokemon, ownMoveRequest, opponentSpeciesName, revealedMoveIds, opponentBoosts, ownBoosts, ownStatus, opponentStatus) {
  const ownMove = battleDex.moves.get(ownMoveRequest.id);

  const opponentPlayer = observer === 'p1' ? 'p2' : 'p1';

  const speedEstimate = getSpeedEstimate(observer, activePokemon, ownBoosts, ownStatus, opponentSpeciesName, opponentBoosts, opponentStatus, true);

  const condition = parseCondition(activePokemon.condition);

  let worstThreat = null;

  for (const moveId of revealedMoveIds) {
    const opponentMove = battleDex.moves.get(moveId);

    if (!isDamagingMove(opponentMove) || moveBlockedByVolatile(opponentPlayer, opponentMove)) {
      continue;
    }

    if (effectiveMovePriority(opponentMove, opponentPlayer, null) > 0 && priorityBlocked(observer, opponentMove)) {
      continue;
    }

    const damage = estimateIncomingDamage(activePokemon, opponentSpeciesName, moveId, opponentBoosts, observer, fieldState.weather, ownMove.id, true);

    if (!damage) {
      continue;
    }

    const order = compareEstimatedMoveOrder(ownMove, opponentMove, speedEstimate.ownSpeed, speedEstimate.opponentMinSpeed, speedEstimate.opponentMaxSpeed, observer, activePokemon);

    // 自分が先なら、この技で
    // 行動前に倒されることはない。
    if (order === 'own') {
      continue;
    }

    const guaranteedKo = damage.minDamagePercent >= condition.hpPercent && (damage.hitChance ?? 1) >= 1;

    const possibleKo = damage.maxDamagePercent >= condition.hpPercent;

    if (!guaranteedKo && !possibleKo) {
      continue;
    }

    let penalty = dieFirstPenalty(order, guaranteedKo, possibleKo, damage.expectedDamagePercent, cantMoveFactor(opponentStatus, opponentPlayer));

    if (order === 'opponent' && normalizeBattleEffect(activePokemon.item) === 'quickclaw') {
      penalty = Math.round(penalty * 0.8);
    }

    if (!worstThreat || penalty > worstThreat.penalty) {
      worstThreat = {
        penalty,
        order,
        moveId,
        moveName: opponentMove.name,
        ownPriority: ownMove.priority ?? 0,
        opponentPriority: opponentMove.priority ?? 0,
        guaranteedKo,
        possibleKo,
        minDamagePercent: damage.minDamagePercent,
        maxDamagePercent: damage.maxDamagePercent,
      };
    }
  }

  const guessed = choiceLockedMove(opponentPlayer) ? null : hiddenIncomingThreat(activePokemon, opponentSpeciesName, opponentBoosts, observer, revealedMoveIds, ownMove.id);

  const guessedId = guessed?.options?.[0]?.moveId || guessed?.options?.[0]?.moveName;
  const guessedMove = guessedId ? battleDex.moves.get(guessedId) : null;

  if (guessed && guessedMove?.exists) {
    const minDamagePercent = guessed.minDamagePercent;

    const maxDamagePercent = guessed.maxDamagePercent;

    const order = compareEstimatedMoveOrder(ownMove, guessedMove, speedEstimate.ownSpeed, speedEstimate.opponentMinSpeed, speedEstimate.opponentMaxSpeed, observer, activePokemon);

    const guaranteedKo = minDamagePercent >= condition.hpPercent && (guessed.hitChance ?? 1) >= 1;

    const possibleKo = maxDamagePercent >= condition.hpPercent;

    const penalty = Math.round(dieFirstPenalty(order, guaranteedKo, possibleKo, guessed.expectedDamagePercent, cantMoveFactor(opponentStatus, opponentPlayer)) * 0.5);

    if (order !== 'own' && penalty > (worstThreat?.penalty ?? 0)) {
      worstThreat = {
        penalty,
        order,
        moveId: guessedMove.id,
        moveName: `予想:${guessed.moveName}`,
        ownPriority: ownMove.priority ?? 0,
        opponentPriority: guessedMove.priority ?? 0,
        guaranteedKo,
        possibleKo,
        minDamagePercent,
        maxDamagePercent,
      };
    }
  }

  return {
    ...speedEstimate,
    threat: worstThreat,
  };
}

// ========================================
// Team Preview 選出評価
// ========================================

function getCombinations(values, size) {
  const results = [];

  function walk(start, current) {
    if (current.length === size) {
      results.push([...current]);
      return;
    }

    for (let index = start; index < values.length; index++) {
      current.push(values[index]);
      walk(index + 1, current);
      current.pop();
    }
  }

  walk(0, []);
  return results;
}

function evaluatePreviewMatchup(observer, pokemon, opponentSpeciesName) {
  const species = getPokemonSpeciesName(pokemon);

  const attackScore = estimatePokemonAttackScore(pokemon, opponentSpeciesName);

  const defenseScore = getDefensiveMatchupScore(species, opponentSpeciesName, []);

  const speedEvaluation = evaluateSwitchSpeed(observer, pokemon, opponentSpeciesName, createEmptyBoosts(), null);

  const intimidate = getIntimidateSwitch(pokemon, createEmptyBoosts(), []);

  const incomingRisk = evaluateIncomingRisk(pokemon, opponentSpeciesName, [], intimidate?.boosts ?? createEmptyBoosts(), observer);

  const incoming = incomingRisk.damage?.expectedDamagePercent ?? 0;

  return {
    species,
    opponentSpeciesName,
    attackScore,
    defenseScore,
    speedScore: speedEvaluation.score,
    incoming,
    intimidateNote: intimidate?.note ?? null,
    score: attackScore + defenseScore + speedEvaluation.score + (intimidate?.bonus ?? 0) - incoming,
  };
}

function evaluateTeamPreview(player, request) {
  if (STEALTH_ROCK_TEST_MODE && player === 'p1') {
    const forced = request.side.pokemon.slice(0, 3).map((pokemon) => getPokemonSpeciesName(pokemon));

    console.log(`${player} ステルスロック検証選出: ` + `${forced.join(' → ')} (team 123)`);

    return 'team 123';
  }

  const opponent = player === 'p1' ? 'p2' : 'p1';

  const opponentSpecies = battleState[opponent].previewSpecies;

  const ownPokemon = request.side.pokemon.map((pokemon, index) => ({
    pokemon,
    slot: index + 1,
    species: getPokemonSpeciesName(pokemon),
  }));

  if (opponentSpecies.length === 0 || ownPokemon.length < 3) {
    console.log(`${player} 選出評価: ` + '相手のTeam Preview情報不足のため team 123');

    return 'team 123';
  }

  const matchupTable = new Map();

  for (const own of ownPokemon) {
    const byOpponent = new Map();

    for (const opponentName of opponentSpecies) {
      byOpponent.set(opponentName, evaluatePreviewMatchup(player, own.pokemon, opponentName));
    }

    matchupTable.set(own.slot, byOpponent);
  }

  const combinations = getCombinations(ownPokemon, 3);

  const evaluated = combinations
    .map((combination) => {
      let coverageScore = 0;

      // 相手6匹それぞれに対し、
      // 選んだ3匹のうち最良と次点を評価する。
      for (const opponentName of opponentSpecies) {
        const matchupScores = combination.map((member) => matchupTable.get(member.slot).get(opponentName).score).sort((a, b) => b - a);

        coverageScore += matchupScores[0] + matchupScores[1] * 0.25;
      }

      // 先発適性。
      // 相手6匹すべてに対する平均と、
      // 最も苦手な対面を少し加味する。
      const leadCandidates = combination
        .map((member) => {
          const scores = opponentSpecies.map((opponentName) => matchupTable.get(member.slot).get(opponentName).score);

          const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;

          const worst = Math.min(...scores);

          return {
            ...member,
            leadScore: average + worst * 0.2,
            averageScore: average,
          };
        })
        .sort((a, b) => b.leadScore - a.leadScore);

      // 先発の安定性も3匹組評価へ少し反映。
      const teamScore = coverageScore + leadCandidates[0].leadScore * 0.5;

      return {
        combination,
        coverageScore,
        leadCandidates,
        teamScore,
      };
    })
    .sort((a, b) => b.teamScore - a.teamScore);

  const topCandidates = evaluated.slice(0, 3);

  console.log(
    `${player} 選出候補:`,
    topCandidates
      .map((candidate) => {
        const names = candidate.combination.map((member) => member.species).join(' / ');

        return `[${names}]=` + candidate.teamScore.toFixed(1);
      })
      .join(' | '),
  );

  const best = evaluated[0];

  // leadCandidates[0] を先発にする。
  // 残り2匹は平均対面評価が高い順に並べる。
  const orderedMembers = [best.leadCandidates[0], ...best.leadCandidates.slice(1).sort((a, b) => b.averageScore - a.averageScore)];

  const teamSpec = orderedMembers.map((member) => member.slot).join('');

  console.log(`${player} 選出判断: ` + `${orderedMembers.map((member) => member.species).join(' → ')} ` + `(team ${teamSpec})`);

  return `team ${teamSpec}`;
}

// ========================================
// AI
// ========================================

function projectMegaRequest(player, request) {
  const active = request.side?.pokemon.find((pokemon) => pokemon.active);
  if (!request.active?.[0]?.canMegaEvo || !active) return null;
  const speciesName = getPokemonSpeciesName(active);
  // 自分の構築だけを参照する。相手のrequestや構築の非公開情報は使わない。
  const ownSet = (player === 'p1' ? teamA : teamB).find((set) => baseSpeciesName(set.species) === baseSpeciesName(speciesName));
  if (!ownSet) return null;
  const opponent = player === 'p1' ? 'p2' : 'p1';
  const opponentSpecies = battleDex.species.get(battleState[opponent].species);
  if (!opponentSpecies.exists) return null;
  const spec = { ...knownCombatant(active, battleState[player].boosts), evs: ownSet.evs, nature: ownSet.nature, moves: active.moves || request.active[0].moves.map((move) => move.id) };
  const session = createDamageBattle(spec, rangedCombatant(opponentSpecies, 'def', 'max', battleState[opponent].boosts, opponent), opponent);
  try {
    useWeather(session.calc, fieldState.weather, session.source);
    if (!session.calc.actions.runMegaEvo(session.attacker)) return null;
    const mon = session.attacker;
    const projected = { ...active, details: mon.details, ability: mon.ability, stats: { ...mon.storedStats }, condition: `${mon.hp}/${mon.maxhp}${mon.status ? ` ${mon.status}` : ''}` };
    return {
      request: { ...request, active: request.active.map((entry) => ({ ...entry, canMegaEvo: false })), side: { ...request.side, pokemon: request.side.pokemon.map((pokemon) => pokemon === active ? projected : pokemon) } },
      species: mon.species.name,
      ability: mon.ability,
      ownBoosts: { ...mon.boosts },
      opponentBoosts: { ...session.defender.boosts },
      weather: Object.keys(SIM_WEATHER_ID).find((label) => SIM_WEATHER_ID[label] === session.calc.field.weather) || null,
      terrain: session.calc.field.terrain ? session.calc.field.terrain.replace(/terrain$/, '') : fieldState.terrain,
    };
  } finally {
    session.calc.destroy();
  }
}

function chooseAction(player, request) {
  syncFieldStateFromBattle();
  const projection = request.teamPreview || request.wait || request.forceSwitch?.some(Boolean) ? null : projectMegaRequest(player, request);
  if (!projection) return chooseActionInternal(player, request);

  const opponent = player === 'p1' ? 'p2' : 'p1';
  const savedOwn = { ...battleState[player] };
  const savedOpponent = { ...battleState[opponent] };
  const savedField = { ...fieldState };
  const restore = () => {
    Object.assign(battleState[player], savedOwn);
    Object.assign(battleState[opponent], savedOpponent);
    Object.assign(fieldState, savedField);
  };
  const applyProjection = () => {
    Object.assign(battleState[player], { species: projection.species, ability: projection.ability, boosts: projection.ownBoosts });
    battleState[opponent].boosts = projection.opponentBoosts;
    fieldState.weather = projection.weather;
    fieldState.terrain = projection.terrain;
  };
  let normalScore = -Infinity;
  let megaScore = -Infinity;
  let megaAction;
  try {
    chooseActionInternal(player, request, (score) => { normalScore = score; }, true);
    restore();
    applyProjection();
    megaAction = chooseActionInternal(player, projection.request, (score) => { megaScore = score; }, true);
  } finally {
    restore();
  }
  if (!megaAction?.startsWith('move ') || megaScore <= normalScore) return chooseActionInternal(player, request);
  try {
    applyProjection();
    console.log(`${player} メガシンカ判断: ${projection.species}（通常${normalScore.toFixed(1)} / メガ${megaScore.toFixed(1)}）`);
    const action = chooseActionInternal(player, projection.request);
    // 公開ログが届くまでは、予測したフォルムや天候を盤面に確定させない。
    const choice = battleState[player].lastChoice;
    const recent = battleState[player].recentSpecies;
    restore();
    battleState[player].lastChoice = choice;
    battleState[player].recentSpecies = recent;
    return action?.startsWith('move ') ? `${action} mega` : action;
  } finally {
    Object.assign(fieldState, savedField);
    battleState[player].species = savedOwn.species;
    battleState[player].ability = savedOwn.ability;
    battleState[player].boosts = savedOwn.boosts;
    battleState[opponent].boosts = savedOpponent.boosts;
  }
}

// 平均の被ダメージとは独立した、一手だけの破綻確認。
// 数値は通常スコアへの加減点に使わず、大差がある場合の行動変更だけに使う。
const HIDDEN_DISRUPTION_LIMIT = 80;
const HIDDEN_DISRUPTION_MARGIN = 40;
const hiddenDisruptionCache = new Map();
// 比較検証から設定を変えられるが、通常実行はこの既定値を使う。
const hiddenDisruptionPolicy = { enabled: true, optimize: true, limit: HIDDEN_DISRUPTION_LIMIT, margin: HIDDEN_DISRUPTION_MARGIN, opportunityWeight: 0.5 };
const hiddenDisruptionMetrics = { calls: 0, cacheHits: 0, scenarios: 0, branches: 0, baselineCacheHits: 0, skippedUnsafe: 0, overrides: 0 };
const hiddenDisruptionDecisions = new Map();

// 定義にboosts/sideCondition等がないコールバックも、候補抽出とKO事前判定で共有する。
const HIDDEN_DISRUPTION_CALLBACKS = new Map([
  ...['bellydrum', 'stockpile', 'stuffcheeks', 'acupressure', 'focusenergy', 'laserfocus', 'psychup',
    'powertrick', 'powersplit', 'guardsplit', 'transform', 'roleplay', 'conversion', 'conversion2',
    'camouflage', 'reflecttype', 'magnetrise', 'substitute', 'tailwind', 'trickroom', 'gravity', 'magicroom', 'wonderroom',
    'sunnyday', 'raindance', 'sandstorm', 'snowscape', 'hail', 'electricterrain', 'grassyterrain',
    'mistyterrain', 'psychicterrain'].map((id) => [id, 'setup']),
  ...['stoneaxe', 'ceaselessedge', 'courtchange'].map((id) => [id, 'hazard']),
  ...['yawn', 'leechseed', 'curse', 'perishsong', 'saltcure', 'syrupbomb', 'throatchop', 'jawlock',
    'spiritshackle', 'destinybond', 'fling', 'taunt', 'encore', 'disable', 'torment', 'imprison', 'spite', 'trick', 'switcheroo',
    'corrosivegas', 'gastroacid', 'simplebeam', 'worryseed', 'entrainment', 'skillswap', 'haze',
    'clearsmog', 'spectralthief', 'topsyturvy', 'heartswap', 'powerswap', 'guardswap', 'speedswap',
    'soak', 'magicpowder', 'trickortreat', 'forestscurse', 'defog', 'lockon', 'electrify', 'fairylock']
    .map((id) => [id, 'control']),
]);

function hiddenDisruptionKinds(move) {
  if (!move?.exists || !isMoveAllowed(move)) return [];
  // 相手の通常の防御技を「対面を崩す未公開技」として扱わない。
  if (move.stallingMove || ['wideguard', 'quickguard'].includes(move.id)) return [];
  const kinds = new Set(move.category !== 'Status' ? ['attack'] : []);
  const effects = [move, move.self, ...(move.secondaries || (move.secondary ? [move.secondary] : []))];
  for (const effect of effects.filter(Boolean)) {
    if (effect.status || (effect.volatileStatus && (effect !== move || targetsOpponent(move)))) kinds.add('status');
    if (effect.boosts || effect.self?.boosts || effect.self?.volatileStatus) kinds.add('setup');
    if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(effect.sideCondition)) kinds.add('hazard');
    if (effect.forceSwitch) kinds.add('control');
  }
  // 壁・おいかぜなど、直後の対面能力を変える場の展開も対象。
  if (['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'].includes(move.sideCondition)) kinds.add('setup');
  const callback = HIDDEN_DISRUPTION_CALLBACKS.get(move.id);
  if (callback) kinds.add(callback);
  return [...kinds];
}

function hiddenDisruptionMoves(player, speciesName) {
  const revealed = getRevealedMoves(player, speciesName);
  if (new Set(revealed).size >= 4) return [];
  const state = battleState[player];
  if (state.volatiles.encore || (revealedItemFor(player, speciesName).startsWith('choice') && state.lastMove)) return [];
  const entry = rosterByShowdownId.get(battleDex.species.get(speciesName).id);
  const ids = (learnsetByName.get(entry?.name) || []).map((row) => moveByChampionsId.get(row.id)?.showdownId);
  return [...new Set(ids)].map((id) => battleDex.moves.get(id)).filter((move) => {
    if (!isMoveAllowed(move) || revealed.includes(move.id) || moveBlockedByVolatile(player, move)) return false;
    if (state.activeMoveActions > 0 && ['fakeout', 'firstimpression'].includes(move.id)) return false;
    if (state.volatiles.mustrecharge) return false;
    const used = state.ppUsed?.[baseSpeciesName(speciesName)]?.[move.id] || 0;
    if (used >= move.pp * (move.noPPBoosts ? 1 : 1.6)) return false;
    return hiddenDisruptionKinds(move).length > 0;
  });
}

function hiddenDisruptionProfile(profile, move, revealed) {
  if (move.category === 'Status' && ['choiceband', 'choicespecs', 'choicescarf', 'assaultvest'].includes(profile.item)) return null;
  // 仮説はコピーにだけ挿入し、既存の構成予測や公開技を変更しない。
  const moves = [...new Set([...revealed, move.id, ...profile.moves])].slice(0, 4);
  return { ...profile, moves };
}

function hiddenDisruptionActionChance(mon, player, move) {
  if (mon.status === 'slp' && move.sleepUsable) return 1;
  if (mon.status === 'slp' && battleState[player].status !== 'slp') return 0;
  if (mon.status === 'frz' && move.flags.defrost) return 1;
  return cantMoveFactor(mon.status, player, mon.ability);
}

function hiddenDisruptionEffectBranches(move, mon) {
  if (!move) return [{ roll: 99, sample: 0, weight: 1 }];
  const effects = move.secondaries || (move.secondary ? [move.secondary] : []);
  const thresholds = [...new Set([0, 100, ...effects.map((effect) => Math.max(0, Math.min(100, effect.chance ?? 100)))])].sort((a, b) => a - b);
  const samples = move.id === 'acupressure' ? Math.max(1, Object.values(mon.boosts).filter((stage) => stage < 6).length)
    : ['triattack', 'direclaw'].includes(move.id) ? 3 : 1;
  return thresholds.slice(1).flatMap((upper, i) => Array.from({ length: samples }, (_, sample) => ({
    roll: upper - 1, sample, weight: (upper - thresholds[i]) / 100 / samples,
  })));
}

function hiddenDisruptionBoard(session, pokemon, speciesName, foePlayer) {
  const { attacker, defender } = session;
  if (!attacker.hp) return -240 + (defender.hp ? 0 : 100);
  if (!defender.hp) return 200 + attacker.hp / attacker.maxhp * 100;
  // 次のターンを実行せず、直後の能力・状態・技制限から対面の変化を測る。
  const position = projectedAilmentPosition(session, pokemon, speciesName, foePlayer, pokemon.moves, false);
  let hazards = 0;
  for (const mon of attacker.side.pokemon) {
    if (!mon.hp) continue;
    // エンジンのhasItem/hasAbilityは非アクティブ個体では無効を返す。
    // 控えの入場負担には、自分が把握している持ち物・特性を使う。
    const entryMon = mon.isActive ? mon : { status: mon.status, hasItem: (id) => mon.item === id,
      hasAbility: (id) => mon.ability === id, hasType: (type) => mon.hasType(type), getTypes: () => mon.getTypes(),
      isGrounded: () => isPokemonGrounded({ details: mon.species.name, ability: mon.ability, item: mon.item }) };
    const burden = effectHazardBurden(attacker.side, entryMon);
    const entryDamage = entryMon.hasItem('heavydutyboots') || entryMon.hasAbility('magicguard') ? 0 :
      (attacker.side.sideConditions.stealthrock ? 12.5 * getTypeMultiplier('Rock', mon.getTypes()) : 0) +
      (entryMon.isGrounded() && attacker.side.sideConditions.spikes ? [0, 12.5, 100 / 6, 25][attacker.side.sideConditions.spikes.layers || 1] : 0);
    // 控えが次の入場で倒れる盤面は、単なる設置の小さな点数とは区別する。
    hazards = Math.max(hazards, burden + (entryDamage > 0 && entryDamage >= mon.hp / mon.maxhp * 100 ? 100 : 0));
  }
  const exposed = position.incoming >= attacker.hp / attacker.maxhp * 100 - 1 &&
    position.outgoing < defender.hp / defender.maxhp * 100 - 1 && position.order < 0 ? 80 : 0;
  return attacker.hp / attacker.maxhp * 100 - defender.hp / defender.maxhp * 100 + position.value -
    effectConditionValue(attacker) + effectConditionValue(defender) - hazards - exposed;
}

function hiddenDisruptionOutcome(player, request, action, speciesName, profile, foeMove) {
  hiddenDisruptionMetrics.scenarios++;
  const foePlayer = player === 'p1' ? 'p2' : 'p1';
  const active = request.side.pokemon.find((pokemon) => pokemon.active);
  const pokemon = action.kind === 'switch' ? request.side.pokemon[action.slot - 1] : active;
  const ownBoosts = action.kind === 'switch' ? createEmptyBoosts() : battleState[player].boosts;
  // 一貫した合法の努力値配分。攻撃・耐久・速度を全て最大にした敵は作らない。
  const spread = rangedCombatant(battleDex.species.get(speciesName), profile.role === 'special' ? 'spa' : profile.role === 'bulky' ? 'def' : 'atk', 'max', battleState[foePlayer].boosts, foePlayer);
  const session = createPublicMoveSession(pokemon, speciesName, ownBoosts, battleState[foePlayer].boosts,
    player, foePlayer, 'max', { ...spread, ...profile }, true);
  const { calc, attacker, defender } = session;
  try {
    applyEffectPublicField(session, player, foePlayer);
    seedPublicEffectState(session, pokemon, player, foePlayer, action.kind === 'switch' ? null : request);
    for (const own of request.side.pokemon) {
      if (own === pokemon || own.condition.includes('fnt')) continue;
      const spec = knownCombatant({ ...own, active: false, level: own.level || BATTLE_LEVEL }, createEmptyBoosts());
      const mon = attacker.side.addPokemon(toCalcSet(spec));
      applyCombatant(mon, spec);
    }
    attacker.side.pokemonLeft = attacker.side.pokemon.length;
    // 相手の控えは公開された存在・生存だけを使う（私有チームは参照しない）。
    calc.canSwitch = (side) => side === attacker.side ? side.pokemon.filter((mon) => mon.hp && !mon.isActive).length : benchSpeciesNames(foePlayer).length;
    if (action.kind === 'switch') {
      // 新しく場に出るときの設置・特性・持ち物を、実際の入場イベントで処理。
      attacker.isStarted = false;
      calc.actions.runSwitch(attacker);
      if (!attacker.hp) return { loss: 240, order: 'opponent', moveId: foeMove.id, outcomes: [], unusableEntry: true };
    }
    const ownMove = action.kind === 'move' ? battleDex.moves.get(action.id) : null;
    if (ownMove?.stallingMove) {
      const chain = battleState[player].protectionChain;
      if (chain?.count && chain.turn === speedLearningState.turn - 1) {
        attacker.addVolatile('stall');
        for (let i = 1; i < chain.count; i++) attacker.addVolatile('stall');
      }
    }
    const speed = getSpeedEstimate(player, pokemon, ownBoosts, attacker.status, speciesName, battleState[foePlayer].boosts, defender.status, false, profile);
    const order = ownMove ? compareEstimatedMoveOrder(ownMove, foeMove, speed.ownSpeed, speed.opponentMinSpeed, speed.opponentMaxSpeed, player, pokemon, profile) : 'opponent';
    const initial = snapshotEffectSession(session);
    const ownSide = attacker.side;
    const sides = calc.sides.map((side) => ({ pokemon: side.pokemon.slice(), active: side.active.slice(), pokemonLeft: side.pokemonLeft,
      faintedThisTurn: side.faintedThisTurn, faintedLastTurn: side.faintedLastTurn, totalFainted: side.totalFainted }));
    const extra = sides.flatMap((side) => side.pokemon).map((mon) => ({ mon, state: snapshotEffectSession({ attacker: mon, defender: mon })[0],
      position: mon.position, isActive: mon.isActive, isStarted: mon.isStarted, faintQueued: mon.faintQueued }));
    const sideConditions = calc.sides.map((side) => Object.fromEntries(Object.entries(side.sideConditions).map(([id, state]) => [id, { ...state }])));
    const field = { weather: calc.field.weather, weatherState: { ...calc.field.weatherState }, terrain: calc.field.terrain, terrainState: { ...calc.field.terrainState },
      pseudoWeather: Object.fromEntries(Object.entries(calc.field.pseudoWeather).map(([id, state]) => [id, { ...state }])) };
    const reset = () => {
      session.attacker = attacker;
      // extraには両側の全個体を含む。activeを別に復元して二重にコピーしない。
      for (const row of extra) Object.assign(row.mon, snapshotEffectCopy([row.state])[0], { position: row.position, isActive: row.isActive, isStarted: row.isStarted, faintQueued: row.faintQueued });
      calc.sides.forEach((side, i) => {
        Object.assign(side, sides[i], { pokemon: sides[i].pokemon.slice(), active: sides[i].active.slice() });
        side.sideConditions = Object.fromEntries(Object.entries(sideConditions[i]).map(([id, state]) => [id, { ...state }]));
      });
      Object.assign(calc.field, { ...field, weatherState: { ...field.weatherState }, terrainState: { ...field.terrainState },
        pseudoWeather: Object.fromEntries(Object.entries(field.pseudoWeather).map(([id, state]) => [id, { ...state }])) });
      calc.queue.clear(); calc.faintQueue = []; calc.log = [];
      calc.ended = false; calc.winner = ''; calc.activeMove = null; calc.activePokemon = null; calc.activeTarget = null;
      for (const [mon, owner] of [[attacker, player], [defender, foePlayer]]) {
        mon.attackedBy = []; mon.hurtThisTurn = null; mon.moveThisTurnResult = undefined;
        mon.activeMoveActions = action.kind === 'switch' && mon === attacker ? 1 : battleState[owner].activeMoveActions + 1;
      }
      calc.random = (n = 2) => n === 16 ? 7 : n === 100 ? 99 : 0;
      calc.randomChance = (n, d) => n >= d;
      calc.sample = (values) => values[0];
    };
    const use = (mon, target, move, hits = null, effect = { roll: 99, sample: 0 }) => {
      if (!mon.hp || !target.hp || mon.forceSwitchFlag) return;
      if (!hiddenDisruptionActionChance(mon, mon === defender ? foePlayer : player, move)) return;
      if ((mon.volatiles.taunt && move.category === 'Status') || mon.volatiles.disable?.move === move.id ||
          (mon.volatiles.encore?.move && mon.volatiles.encore.move !== move.id) || (mon.volatiles.throatchop && move.flags.sound)) return;
      if (['self', 'allySide', 'allyTeam'].includes(move.target)) target = mon;
      // useMove自身がModifyType/ModifyMoveを実行するため、ここで二重に変換しない。
      const prepared = calc.dex.getActiveMove(move.id);
      prepared.pranksterBoosted = mon.hasAbility('prankster') && move.category === 'Status';
      if (move.multihit && hits !== null) prepared.multihit = hits;
      prepared.accuracy = true;
      prepared.willCrit = !!move.willCrit;
      calc.random = (n = 2, upper) => upper !== undefined ? n : n === 16 ? 7 : n === 100 ? effect.roll : 0;
      calc.sample = (values) => values[effect.sample % values.length];
      calc.randomChance = (n, d) => d === 100 ? effect.roll < n : n >= d;
      if (move.stallingMove) calc.randomChance = () => true;
      calc.setActiveMove(prepared, mon, target);
      calc.actions.useMove(prepared, mon, { target });
      calc.runEvent('Update', mon); calc.runEvent('Update', target);
    };
    // 効果が成功した枝と不発の枝を区別。低命中技や連続まもるを確実とは扱わない。
    reset();
    const prepared = prepareDamageMove(calc, defender, attacker, foeMove);
    const hitChance = readMoveHitChance(calc, defender, attacker, prepared);
    const foeChance = hiddenDisruptionActionChance(defender, foePlayer, foeMove) * hitChance;
    let guardChance = 1;
    if (ownMove?.stallingMove) {
      calc.randomChance = (n, d) => { guardChance *= n / d; return true; };
      calc.runEvent('StallMove', attacker);
    }
    const ownPrepared = ownMove ? prepareDamageMove(calc, attacker, defender, ownMove) : null;
    const ownChance = ownMove ? hiddenDisruptionActionChance(attacker, player, ownMove) *
      readMoveHitChance(calc, attacker, defender, ownPrepared) * guardChance : 0;
    const foeHitBranches = hitSpread(foeMove, defender, hitChance);
    const ownHitBranches = ownMove ? hitSpread(ownMove, attacker) : [{ hits: 1, probability: 1 }];
    // てんのめぐみ・ちからずくなどが変更した実際の追加効果を分岐へ使う。
    const foeEffectBranches = hiddenDisruptionEffectBranches(prepared || foeMove, defender);
    const ownEffectBranches = hiddenDisruptionEffectBranches(ownPrepared, attacker);
    const branch = (enemyActs, ownActs, ownFirst, blockedAfterOpponent = false, foeHits = null, ownHits = null, foeEffect, ownEffect) => {
      hiddenDisruptionMetrics.branches++;
      reset();
      if (ownMove && ownActs) {
        calc.queue.push({ choice: 'move', pokemon: attacker, move: calc.dex.getActiveMove(ownMove) });
      }
      if (enemyActs || (ownMove && ownActs && ownMove.stallingMove)) {
        calc.queue.push({ choice: 'move', pokemon: defender, move: calc.dex.getActiveMove(foeMove) });
      }
      let remainingActionChance = 1;
      const own = () => {
        if (ownMove && ownActs) {
          calc.queue.cancelAction(attacker);
          const original = hiddenDisruptionActionChance({ status: initial[0].status, ability: attacker.ability }, player, ownMove);
          const now = hiddenDisruptionActionChance(attacker, player, ownMove);
          remainingActionChance = original ? Math.min(1, now / original) : 0;
          if (attacker.volatiles.flinch && calc.runEvent('Flinch', attacker)) remainingActionChance = 0;
          if (blockedAfterOpponent || !remainingActionChance) return;
          // 連続成功率は分岐の重みに反映済み。
          if (ownMove.stallingMove) calc.randomChance = () => true;
          use(attacker, defender, ownMove, ownHits, ownEffect);
          calc.randomChance = (n, d) => n >= d;
        }
      };
      if (ownFirst) own();
      if (enemyActs) {
        calc.queue.cancelAction(defender);
        use(defender, attacker, foeMove, foeHits, foeEffect);
      }
      if (!ownFirst) own();
      if (attacker.forceSwitchFlag && attacker.hp && calc.canSwitch(ownSide)) {
        calc.actions.dragIn(ownSide, 0);
        session.attacker = ownSide.active[0];
      }
      // Protect類の一時的な防御を、直後の継続対面の強さに持ち越さない。
      for (const mon of [session.attacker, defender]) {
        for (const id of Object.keys(mon.volatiles)) if (calc.dex.moves.get(id).stallingMove) delete mon.volatiles[id];
        delete mon.volatiles.stall;
      }
      const current = session.attacker === attacker ? pokemon : request.side.pokemon.find((row) => getPokemonSpeciesName(row) === session.attacker.species.name) || pokemon;
      return { value: hiddenDisruptionBoard(session, current, speciesName, foePlayer),
        ownHpPercent: session.attacker.hp / session.attacker.maxhp * 100,
        foeHpPercent: defender.hp / defender.maxhp * 100, ownStatus: session.attacker.status, remainingActionChance };
    };
    let loss = 0;
    const outcomes = [];
    const baselines = new Map();
    const orders = order === 'uncertain' ? [[true, 0.5], [false, 0.5]] : [[order === 'own', 1]];
    for (const [ownFirst, orderWeight] of orders) {
      for (const [ownActs, weight] of [[true, ownChance], [false, 1 - ownChance]]) {
        if (!weight) continue;
        for (const foeHits of foeHitBranches) {
          for (const ownHits of ownHitBranches) {
          for (const foeEffect of foeEffectBranches) {
          for (const ownEffect of ownEffectBranches) {
            // 相手が動かない基準盤面は、相手の命中回数・追加効果では変わらない。
            const baselineKey = JSON.stringify([ownActs, ownFirst, ownHits.hits, ownEffect]);
            let baseline = hiddenDisruptionPolicy.optimize ? baselines.get(baselineKey) : null;
            if (baseline) hiddenDisruptionMetrics.baselineCacheHits++;
            else {
              baseline = branch(false, ownActs, ownFirst, false, foeHits.hits, ownHits.hits, foeEffect, ownEffect);
              if (hiddenDisruptionPolicy.optimize) baselines.set(baselineKey, baseline);
            }
            const after = branch(true, ownActs, ownFirst, false, foeHits.hits, ownHits.hits, foeEffect, ownEffect);
            const unable = !ownFirst && ownActs && after.remainingActionChance < 1
              ? branch(true, ownActs, ownFirst, true, foeHits.hits, ownHits.hits, foeEffect, ownEffect) : after;
            const value = after.value * after.remainingActionChance + unable.value * (1 - after.remainingActionChance);
            const probability = orderWeight * weight * foeChance * foeHits.probability * ownHits.probability * foeEffect.weight * ownEffect.weight;
            loss += probability * Math.max(0, baseline.value - value);
            outcomes.push({ ...after, ownFirst, weight: probability * after.remainingActionChance });
            if (unable !== after) outcomes.push({ ...unable, ownFirst, weight: probability * (1 - after.remainingActionChance) });
          }
          }
          }
        }
      }
    }
    return { loss, order, moveId: foeMove.id, outcomes };
  } finally { calc.destroy(); }
}

function hiddenDisruptionCouldKO(player, pokemon, speciesName, profile, move) {
  // 条件付きダメージは、こちらの選択を含む本計算へ回す。
  if (move.damageCallback || move.ohko || ['counter', 'mirrorcoat', 'metalburst', 'bide'].includes(move.id)) return true;
  const foe = player === 'p1' ? 'p2' : 'p1';
  const spread = rangedCombatant(battleDex.species.get(speciesName), profile.role === 'special' ? 'spa' : profile.role === 'bulky' ? 'def' : 'atk', 'max', battleState[foe].boosts, foe);
  const session = createPublicMoveSession(pokemon, speciesName, battleState[player].boosts, battleState[foe].boosts,
    player, foe, 'max', { ...spread, ...profile }, true);
  try {
    applyEffectPublicField(session, player, foe);
    const { calc, attacker, defender } = session;
    const prepared = prepareDamageMove(calc, defender, attacker, move);
    if (!prepared) return false;
    if (!calc.actions.hitStepTypeImmunity([attacker], defender, prepared)[0] || !calc.actions.hitStepTryImmunity([attacker], defender, prepared)[0]) return false;
    calc.random = () => 0;
    calc.randomChance = (n, d) => n >= d;
    prepared.willCrit = !!move.willCrit;
    const damage = Number(calc.actions.getDamage(defender, attacker, prepared, true)) || 0;
    return damage * hitBounds(prepared, defender).max >= attacker.hp;
  } finally { session.calc.destroy(); }
}

function evaluateHiddenDisruption(player, request, scoredMoves, canSwitch) {
  hiddenDisruptionMetrics.calls++;
  if (!hiddenDisruptionPolicy.enabled) { hiddenDisruptionDecisions.delete(player); return null; }
  const foe = player === 'p1' ? 'p2' : 'p1';
  const pokemon = request.side.pokemon.find((mon) => mon.active);
  const profiles = effectProfileGroups(foe, battleState[foe].species);
  const speeds = profiles.map((profile) => getSpeedEstimate(player, pokemon, battleState[player].boosts, battleState[player].status,
    battleState[foe].species, battleState[foe].boosts, battleState[foe].status, false, profile));
  const key = JSON.stringify([player, request, scoredMoves.map((row) => [row.move.id, row.slot, row.score, row.minDamagePercent, row.hitChance]), canSwitch,
    battleState, fieldState, profiles, speeds, hiddenDisruptionMoves(foe, battleState[foe].species).map((move) => move.id), hiddenDisruptionPolicy]);
  if (hiddenDisruptionCache.has(key)) {
    hiddenDisruptionMetrics.cacheHits++;
    const cached = hiddenDisruptionCache.get(key);
    hiddenDisruptionDecisions.set(player, cached);
    return cached;
  }
  const result = computeHiddenDisruption(player, request, scoredMoves, canSwitch);
  if (hiddenDisruptionCache.size >= 64) hiddenDisruptionCache.clear();
  hiddenDisruptionCache.set(key, result);
  hiddenDisruptionDecisions.set(player, result);
  if (result?.override) hiddenDisruptionMetrics.overrides++;
  return result;
}

function selectHiddenDisruption(rows, recent = [], policy = hiddenDisruptionPolicy) {
  const current = rows[0];
  const opportunityCost = (row) => {
    const switchCost = row.kind === 'switch' ? (recent.includes(row.species) ? 80 : recent.length ? 50 : 20) + recent.length * 40 : 0;
    return Math.max(0, current.score - row.score) * policy.opportunityWeight + switchCost;
  };
  const evaluated = rows.map((row) => ({ ...row, opportunityCost: opportunityCost(row),
    improvement: current.loss - row.loss, netImprovement: current.loss - row.loss - opportunityCost(row) }));
  if (current.loss < policy.limit) return { rows: evaluated, override: null, reason: 'below-severity' };
  const safe = evaluated.slice(1).filter((row) => row.loss < policy.limit && row.improvement >= policy.margin && row.netImprovement >= policy.margin)
    .sort((a, b) => a.loss + a.opportunityCost - b.loss - b.opportunityCost || b.score - a.score || a.slot - b.slot);
  return { rows: evaluated, override: safe[0] || null, reason: safe.length ? 'material-improvement' : 'no-safe-improvement' };
}

function computeHiddenDisruption(player, request, scoredMoves, canSwitch) {
  const foe = player === 'p1' ? 'p2' : 'p1';
  const species = battleState[foe].species;
  const candidates = hiddenDisruptionMoves(foe, species);
  if (!candidates.length) return null;
  const best = scoredMoves[0];
  const pokemon = request.side.pokemon.find((mon) => mon.active);
  const profiles = effectProfileGroups(foe, species);
  const revealed = getRevealedMoves(foe, species);
  // KO幅はタスキ・がんじょう・みがわり等を含む既存エンジンの結果。
  if (best.minDamagePercent >= battleState[foe].hpPercent && best.hitChance === 1 &&
      cantMoveFactor(parseCondition(pokemon.condition).status, player, pokemon.ability) === 1 && profiles.every((profile) => {
        const speed = getSpeedEstimate(player, pokemon, battleState[player].boosts, battleState[player].status, species, battleState[foe].boosts, battleState[foe].status, false, profile);
        return candidates.every((move) => compareEstimatedMoveOrder(best.move, move, speed.ownSpeed, speed.opponentMinSpeed, speed.opponentMaxSpeed, player, pokemon, profile) === 'own');
      })) return { certainFirstKO: true, slot: best.slot, override: null };
  const actions = [{ kind: 'move', id: best.move.id, slot: best.slot, score: best.score }];
  for (const row of scoredMoves) {
    if (row !== best && !row.failed && (row.move.stallingMove || row.move.category !== 'Status')) {
      actions.push({ kind: 'move', id: row.move.id, slot: row.slot, score: row.score });
    }
  }
  if (canSwitch) for (const row of evaluateSwitchCandidates(player, request, species, revealed, battleState[foe].boosts, battleState[foe].status)) actions.push({ kind: 'switch', ...row });
  if (actions.length < 2) return null;
  const rows = actions.map((action) => ({ ...action, loss: 0, threat: null, lossComplete: true }));
  for (const move of candidates) {
    for (const profile of profiles) {
      const hypothesis = hiddenDisruptionProfile(profile, move, revealed);
      if (!hypothesis) continue;
      // 威力だけでは破綻を生まない攻撃は、KO候補として数えない。
      if (hiddenDisruptionKinds(move).every((kind) => kind === 'attack')) {
        if (!hiddenDisruptionCouldKO(player, pokemon, species, hypothesis, move)) continue;
      }
      for (const row of rows) {
        // 最悪値は単調に増える。閾値以上の代替は、その後も安全候補に戻らない。
        // 元の最良行動の最悪値は全候補で求める。省略した代替値は下限として明示する。
        if (hiddenDisruptionPolicy.optimize && row !== rows[0] && row.loss >= hiddenDisruptionPolicy.limit) {
          row.lossComplete = false;
          hiddenDisruptionMetrics.skippedUnsafe++;
          continue;
        }
        const outcome = hiddenDisruptionOutcome(player, request, row, species, hypothesis, move);
        // 両立しない未公開技・構成は足さず、最悪の一手を保持する。
        if (outcome.loss > row.loss) { row.loss = outcome.loss; row.threat = move.id; }
      }
    }
  }
  return selectHiddenDisruption(rows, battleState[player].recentSpecies || []);
}

function chooseActionInternal(player, request, onScore = null, quiet = false) {
  assertRequestSupported(request);
  const console = quiet ? { log() {} } : globalThis.console;

  if (request.teamPreview) {
    return evaluateTeamPreview(player, request);
  }

  if (request.wait) {
    return null;
  }

  const opponent = player === 'p1' ? 'p2' : 'p1';

  if (request.forceSwitch?.some(Boolean)) {
    const opponentSpecies = battleState[opponent].species;

    // 相手がまだ特定できない場合だけ、
    // 従来通り最初の生存ポケモンを出す。
    if (!opponentSpecies) {
      const fallbackCandidates = request.side.pokemon
        .map((pokemon, index) => ({
          pokemon,
          slot: index + 1,
        }))
        .filter(({ pokemon }) => !pokemon.active && !pokemon.condition.includes('fnt'));

      if (!fallbackCandidates.length) {
        return null;
      }

      battleState[player].lastChoice = 'switch';

      return `switch ${fallbackCandidates[0].slot}`;
    }

    const revealedMoveIds = getRevealedMoves(opponent, opponentSpecies);

    const candidates = evaluateSwitchCandidates(player, request, opponentSpecies, revealedMoveIds, battleState[opponent].boosts, battleState[opponent].status, 'forced');

    if (!candidates.length) {
      return null;
    }

    console.log(`${player} 強制交代候補:`, candidates.map(formatSwitchCandidate).join(' / '));

    const bestSwitch = candidates[0];

    console.log(`${player} 強制交代判断: ` + `${bestSwitch.species}`);

    battleState[player].lastChoice = 'switch';

    return `switch ${bestSwitch.slot}`;
  }

  const active = request.active?.[0];

  if (!active) {
    return null;
  }

  const activePokemon = request.side.pokemon.find((pokemon) => pokemon.active);

  if (!activePokemon) {
    return null;
  }

  const usableMoves = active.moves
    .map((move, index) => ({
      move,
      slot: index + 1,
    }))
    .filter(({ move }) => !move.disabled && isMoveAllowed(battleDex.moves.get(move.id)));

  if (!usableMoves.length) {
    if (active.moves.some((move) => !move.disabled && !isMoveAllowed(battleDex.moves.get(move.id)))) {
      throw new Error('シングルで使用可能な技がありません。ダブル向けの技をチームから変更してください。');
    }
    return null;
  }

  if (usableMoves.length === 1 && usableMoves[0].move.id === 'struggle') {
    console.log(`${player} PP切れ: わるあがきで続行`);
  }

  const ownSpecies = battleState[player].species;

  const opponentSpecies = battleState[opponent].species;

  if (!ownSpecies || !opponentSpecies) {
    battleState[player].lastChoice = 'move';

    return `move ${usableMoves[0].slot}`;
  }

  const opponentHp = battleState[opponent].hpPercent;

  const revealedMoveIds = getRevealedMoves(opponent, opponentSpecies);

  if (revealedMoveIds.length > 0) {
    console.log(`${player} 相手公開技: ` + `${opponentSpecies} [` + revealedMoveIds.map((id) => battleDex.moves.get(id).name).join(', ') + `]`);
  }

  // ========================================
  // 素早さ推定
  // ========================================

  const speedEstimate = getSpeedEstimate(player, activePokemon, battleState[player].boosts, battleState[player].status, opponentSpecies, battleState[opponent].boosts, battleState[opponent].status, true);

  let speedText = '速度関係不明';

  if (speedEstimate.relation === 'own') {
    speedText = '自分が確実に速い';
  } else if (speedEstimate.relation === 'opponent') {
    speedText = '相手が確実に速い';
  }

  const ownSpeedModifiers = formatSpeedModifiers(getPublicSpeedModifiers(player, activePokemon));

  const opponentSpeedModifiers = formatSpeedModifiers(getPublicSpeedModifiers(opponent));

  console.log(`${player} 素早さ推定: ` + `${ownSpecies} ${speedEstimate.ownSpeed}${ownSpeedModifiers} / ` + `${opponentSpecies} ` + `${speedEstimate.opponentMinSpeed}〜` + `${speedEstimate.opponentMaxSpeed}${opponentSpeedModifiers} ` + `→ ${speedText}` + (speedEstimate.observations > 0 ? `（観測${speedEstimate.observations}回反映）` : ''));

  const activeFieldParts = [];

  if (fieldState.weather) {
    activeFieldParts.push(labelWithTurns(`天候:${getWeatherLabel(fieldState.weather)}`, fieldState.weatherTurns));
  }

  if (fieldState.terrain) {
    activeFieldParts.push(labelWithTurns(getTerrainLabel(fieldState.terrain), fieldState.terrainTurns));
  }

  if (fieldState.trickRoom) {
    activeFieldParts.push(labelWithTurns('トリックルーム', fieldState.trickRoomTurns));
  }

  for (const sideId of ['p1', 'p2']) {
    const side = fieldState.sides[sideId];

    if (side.reflect) {
      activeFieldParts.push(labelWithTurns(`${sideId}リフレクター`, side.reflectTurns));
    }

    if (side.lightScreen) {
      activeFieldParts.push(labelWithTurns(`${sideId}ひかりのかべ`, side.lightScreenTurns));
    }

    if (side.auroraVeil) {
      activeFieldParts.push(labelWithTurns(`${sideId}オーロラベール`, side.auroraVeilTurns));
    }

    if (side.tailwind) {
      activeFieldParts.push(labelWithTurns(`${sideId}おいかぜ`, side.tailwindTurns));
    }

    if (side.stickyWeb) {
      activeFieldParts.push(`${sideId}ねばねばネット`);
    }
  }

  if (activeFieldParts.length > 0) {
    console.log(`${player} 場: ` + activeFieldParts.join(' / '));
  }

  // ========================================
  // 技評価
  // ========================================

  const scoredMoves = usableMoves.map(({ move, slot }) => {
    const evaluation = evaluateMove(move, ownSpecies, opponentSpecies, battleState[opponent].status, battleState[player].lastMove, battleState[player].boosts, battleState[opponent].boosts, request, player, opponent, false, true);

    const baseScore = evaluation.score;

    let score = baseScore;

    let koType = null;

    const foeMove = battleDex.moves.get(move.id);

    if (evaluation.minDamagePercent > 0 && evaluation.minDamagePercent >= opponentHp) {
      score += 80 * (evaluation.hitChance ?? 1);
      koType = (evaluation.hitChance ?? 1) < 1 ? '命中' : '確定';
    } else if (evaluation.maxDamagePercent > 0 && evaluation.maxDamagePercent >= opponentHp) {
      score += 40 * (evaluation.hitChance ?? 1);
      koType = foeMove.ohko ? '命中' : '乱数';
    } else if (evaluation.critChance > 0 && evaluation.critChance < 1 && (evaluation.critMaxDamagePercent || evaluation.maxDamagePercent * (evaluation.critFactor || 1)) >= opponentHp) {
      score += Math.round(40 * evaluation.critChance * (evaluation.hitChance ?? 1));
      koType = '急所';
    }

    let switchRead = null;

    if (isDamagingMove(foeMove)) {
      const resist = resistSwitchIn(opponent, foeMove);
      const currentMultiplier = moveTypeMultiplier(foeMove, battleDex.species.get(opponentSpecies).types);
      const serious = Boolean(koType) || currentMultiplier >= 2 || opponentHp <= 40;

      if (resist) {
        const switched = estimateInferredBattleDamage({
          move: foeMove,
          attackerSpecies: battleDex.species.get(ownSpecies),
          defenderSpecies: resist.species,
          attackerPokemon: activePokemon,
          attackerBoosts: battleState[player].boosts,
          defenderPlayer: opponent,
        });

        const switchedScore = switched.immune ? 0 : switched.score - switched.recoilPercent;
        const stayWeight = koType ? 0.6 : serious ? 0.75 : 0.9;

        score = score * stayWeight + switchedScore * (1 - stayWeight);

        if (koType) {
          const incoming = evaluateIncomingRisk(activePokemon, resist.name, getRevealedMoves(opponent, resist.name), createEmptyBoosts(), player);

          score -= incoming.penalty * 0.25;
        }

        switchRead = switched.immune ? `交代読み:${resist.name}無効` : `交代読み:${resist.name}`;
      }
    }

    const turnOrder = evaluatePreMoveThreat(player, activePokemon, move, opponentSpecies, revealedMoveIds, battleState[opponent].boosts, battleState[player].boosts, battleState[player].status, battleState[opponent].status);

    let turnOrderReason = null;

    if (turnOrder.threat) {
      score -= turnOrder.threat.penalty;

      if (turnOrder.threat.order === 'opponent') {
        if (turnOrder.threat.guaranteedKo) {
          turnOrderReason = `相手の${turnOrder.threat.moveName}が先に確定KO推定`;

          // こちらの「確定1発」は
          // 撃つ前に倒されるため、
          // 実質的なKO評価として扱わない。
          koType = null;
        } else {
          turnOrderReason = `相手の${turnOrder.threat.moveName}が先に乱数KO推定`;
        }
      } else {
        turnOrderReason = `速度関係不明で${turnOrder.threat.moveName}のKO危険`;
      }
    }

    return {
      move,
      slot,
      baseScore,
      ...evaluation,
      score,
      koType,
      turnOrder,
      turnOrderReason,
      switchRead,
    };
  });

  scoredMoves.sort((a, b) => b.score - a.score);

  const bestMove = scoredMoves[0];

  // ========================================
  // 自主交代
  // ========================================

  const opponentSideForTest = player === 'p1' ? 'p2' : 'p1';

  const stealthRockTestSetupPending = STEALTH_ROCK_TEST_MODE && player === 'p1' && ownSpecies === 'Steelix' && !fieldState.sides[opponentSideForTest].stealthRock;

  if (stealthRockTestSetupPending) {
    console.log(`${player} ステルスロック検証: ` + `設置前のため自主交代を禁止`);
  }

  const canSwitch = !active.trapped && !active.maybeTrapped && !stealthRockTestSetupPending;

  const bestMoveIsUnsafe = Boolean(bestMove.turnOrder?.threat);

  const opponentDamageKnown = hasRevealedDamagingMove(revealedMoveIds);

  const hiddenDisruption = evaluateHiddenDisruption(player, request, scoredMoves, canSwitch);
  if (hiddenDisruption?.override) {
    const action = hiddenDisruption.override;
    const threat = battleDex.moves.get(hiddenDisruption.rows[0].threat).name;
    console.log(`${player} 未公開の重大な一手: ${threat} / 居座りの不利${hiddenDisruption.rows[0].loss.toFixed(1)} → ${action.kind === 'switch' ? action.species : action.id}の不利${action.loss.toFixed(1)}`);
    onScore?.(action.score);
    if (action.kind === 'switch') {
      battleState[player].recentSpecies = [...(battleState[player].recentSpecies || []), ownSpecies];
      battleState[player].lastChoice = 'switch';
      return `switch ${action.slot}`;
    }
    battleState[player].recentSpecies = [];
    battleState[player].lastChoice = 'move';
    return `move ${action.slot}`;
  }

  if (canSwitch && !hiddenDisruption?.certainFirstKO && (!bestMove.koType || bestMoveIsUnsafe || !opponentDamageKnown || bestMove.yawnPenalty > 0)) {
    const currentDefenseScore = getDefensiveMatchupScore(ownSpecies, opponentSpecies, revealedMoveIds);

    const currentRisk = evaluateIncomingRisk(activePokemon, opponentSpecies, revealedMoveIds, battleState[opponent].boosts, player);

    const residual = getEndOfTurnChange(ownSpecies, {
      abilityId: normalizeBattleEffect(activePokemon.ability),
      itemId: normalizeBattleEffect(activePokemon.item) || battleState[player].item,
      grounded: isActiveGrounded(player, battleDex.species.get(ownSpecies)),
      status: battleState[player].status,
      toxicCounter: battleState[player].toxicCounter,
      hpPercent: parseCondition(activePokemon.condition).hpPercent,
      volatiles: battleState[player].volatiles,
    });

    const trickRoomScore = trickRoomPositionScore(speedEstimate.relation);

    const endOfTurnDelta = -residual.percent + trickRoomScore;

    const ownHeldItem = normalizeBattleEffect(activePokemon.item);
    const stayItemBonus = currentRisk.damage && ownHeldItem === 'redcard' ? 16 : currentRisk.damage && ownHeldItem === 'ejectbutton' ? 8 : 0;

    const currentPositionScore = bestMove.baseScore + currentDefenseScore + getSpeedRelationScore(speedEstimate.relation) + endOfTurnDelta - currentRisk.penalty + stayItemBonus;

    if (residual.reason || trickRoomScore) {
      console.log(`${player} ターン終了: ` + `${residual.reason || 'なし'} ` + `点数${endOfTurnDelta >= 0 ? '+' : ''}${endOfTurnDelta.toFixed(1)}`);
    }

    if (currentRisk.damage) {
      console.log(`${player} 現在対面の被ダメ推定: ` + `${formatIncomingMoveName(currentRisk.damage)} ` + `${currentRisk.damage.minDamagePercent.toFixed(1)}` + `〜` + `${currentRisk.damage.maxDamagePercent.toFixed(1)}%` + (currentRisk.damage.fieldReason ? `【${currentRisk.damage.fieldReason}】` : ''));
    }

    const switchCandidates = evaluateSwitchCandidates(player, request, opponentSpecies, revealedMoveIds, battleState[opponent].boosts, battleState[opponent].status);

    if (switchCandidates.length) {
      console.log(`${player} 交代候補:`, switchCandidates.map(formatSwitchCandidate).join(' / '));

      const bestSwitch = switchCandidates[0];

      const recent = battleState[player].recentSpecies || [];

      const cycling = recent.includes(bestSwitch.species);

      const switchMargin = cycling ? 80 : recent.length ? 50 : 20;

      if (bestSwitch.score >= currentPositionScore + switchMargin && bestSwitch.score >= 25) {
        onScore?.(bestSwitch.score);
        console.log(`${player} 自主交代判断: ` + `${ownSpecies} → ` + `${bestSwitch.species}`);

        battleState[player].recentSpecies = [...(battleState[player].recentSpecies || []), ownSpecies];

        battleState[player].lastChoice = 'switch';

        return `switch ${bestSwitch.slot}`;
      }
    }
  }

  // ========================================
  // 能力ランク表示
  // ========================================

  const boosts = battleState[player].boosts;

  const boostText = Object.entries(boosts)
    .filter(([, value]) => value !== 0)
    .map(([stat, value]) => `${stat}${value > 0 ? '+' : ''}${value}`)
    .join(' ');

  if (boostText) {
    console.log(`${player} 現在能力: ${boostText}`);
  }

  // ========================================
  // 技評価表示
  // ========================================

  console.log(
    `${player} 技評価:`,
    scoredMoves
      .map((result) => {
        let text = `${result.move.move} ` + `推定` + `${result.minDamagePercent.toFixed(1)}` + `〜` + `${result.maxDamagePercent.toFixed(1)}% ` + `評価${result.score.toFixed(1)}`;

        if (result.koType === '確定') {
          text += '【推定確定1発】';
        }

        if (result.koType === '乱数') {
          text += '【推定乱数1発】';
        }

        if (result.koType === '命中') {
          text += '【命中時1発】';
        }

        if (result.koType === '急所') {
          text += '【推定急所】';
        }

        if (result.weatherReason) {
          text += `【${result.weatherReason}】`;
        }

        if (result.fieldReason) {
          text += `【${result.fieldReason}】`;
        }

        if (result.turnOrderReason) {
          text += `【${result.turnOrderReason}】`;
        }

        if (result.reason) {
          text += `【${result.reason}】`;
        }

        if (result.switchRead) {
          text += `【${result.switchRead}】`;
        }

        return text;
      })
      .join(' / '),
  );

  battleState[player].recentSpecies = [];

  battleState[player].lastChoice = 'move';

  onScore?.(bestMove.score);
  return `move ${bestMove.slot}`;
}

// ========================================
// BattleStream
// ========================================

const stream = new BattleStream();

(async () => {
  for await (const output of stream) {
    updateBattleState(output);

    if (output.startsWith('end\n')) {
      const result = JSON.parse(output.slice('end\n'.length));

      console.log('\n=== 対戦終了 ===');

      console.log(`勝者: ${result.winner}`);

      console.log(`ターン数: ${result.turns}`);

      return;
    }

    if (!output.startsWith('sideupdate\n')) {
      continue;
    }

    const lines = output.split('\n');

    const player = lines[1];

    const requestLine = lines.find((line) => line.startsWith('|request|'));

    if (!requestLine) {
      continue;
    }

    const request = JSON.parse(requestLine.slice('|request|'.length));

    latestRequests[player] = request;

    const action = chooseAction(player, request);

    if (!action) {
      continue;
    }

    console.log(`${player}: ${action}`);

    stream.write(`>${player} ${action}`);
  }
})();

// ========================================
// 対戦開始
// ========================================

stream.write(
  `>start ${JSON.stringify({
    formatid: FORMAT,
  })}`,
);

stream.write(
  `>player p1 ${JSON.stringify({
    name: 'AI-1',
    team: packedTeamA,
  })}`,
);

stream.write(
  `>player p2 ${JSON.stringify({
    name: 'AI-2',
    team: packedTeamB,
  })}`,
);
