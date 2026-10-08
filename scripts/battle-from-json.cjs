const fs = require('node:fs');

const { Battle, BattleStream, Dex, Side, Teams, TeamValidator } = require('../vendor/pokemon-showdown/dist/sim');

Dex.includeFormats();

const FORMAT = 'gen9championsbssregmc';
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

    const showdownMoves = member.moves.map((moveName) => findByName(moves, moveName, 'わざ').showdownId);

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

const validator = new TeamValidator(FORMAT);

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
    item: null,
    ability: null,
    revealedAbilities: {},
    unburden: false,
    toxicCounter: 0,
    lastChoice: null,
    statusAge: 0,
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
    item: null,
    ability: null,
    revealedAbilities: {},
    unburden: false,
    toxicCounter: 0,
    lastChoice: null,
    statusAge: 0,
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

    side.reflectTurns = conditions.reflect?.duration ?? null;

    side.lightScreenTurns = conditions.lightscreen?.duration ?? null;

    side.auroraVeilTurns = conditions.auroraveil?.duration ?? null;

    side.tailwindTurns = conditions.tailwind?.duration ?? null;

    const active = liveSide.active?.[0];

    battleState[sideId].smackDown = Boolean(active?.volatiles?.smackdown);

    battleState[sideId].magnetRise = Boolean(active?.volatiles?.magnetrise);

    // プロトコルに出た状態だけ。ねむりの残りターンは非公開なので写さない。
    const publicVolatileIds = ['focusenergy', 'laserfocus', 'taunt', 'encore', 'disable', 'attract', 'confusion', 'throatchop', 'saltcure', 'curse', 'leechseed', 'substitute', 'yawn'];

    const nextVolatiles = {};

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
  }
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
  const revealed = battleState[player].revealedMoves[species];

  if (!revealed) {
    return [];
  }

  return [...revealed];
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

    // ====================================
    // Team Preview の公開情報
    // ====================================

    if (parts[1] === 'clearpoke') {
      battleState.p1.previewSpecies = [];
      battleState.p2.previewSpecies = [];
      battleState.p1.faintedSpecies.clear();
      battleState.p2.faintedSpecies.clear();
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
        if (battleState[sideId].status === 'tox') {
          battleState[sideId].toxicCounter = Math.min((battleState[sideId].toxicCounter || 1) + 1, 15);
        }
      }
    }

    if (parts[1] === 'cant') {
      const player = parts[2]?.slice(0, 2);
      const reason = normalizeBattleEffect(parts[3]);

      if (battleState[player] && (reason === 'slp' || reason === 'frz' || reason === 'par')) {
        battleState[player].statusAge = (battleState[player].statusAge || 0) + 1;
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
      }
    }

    if (parts[1] === 'switch' || parts[1] === 'drag') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const condition = parseCondition(parts[4]);

      battleState[player].species = parts[3]?.split(',')[0].trim();

      battleState[player].gender = genderOf(parts[3]);

      battleState[player].volatiles = {};

      // 復活して再登場した場合は、再び交代候補にできる。
      if (condition.hpPercent > 0) {
        battleState[player].faintedSpecies.delete(baseSpeciesName(battleState[player].species));
      }

      battleState[player].hpPercent = condition.hpPercent;

      battleState[player].ability = null;

      battleState[player].unburden = false;

      rememberStatus(player, condition.status);

      resetBoosts(player);
      battleState[player].lastMove = null;
      battleState[player].item = null;
    }

    if (parts[1] === '-item' || parts[1] === '-enditem') {
      const player = parts[2]?.slice(0, 2);

      const itemId = normalizeBattleEffect(parts[3]);

      const state = battleState[player];

      if (state && itemId) {
        if (parts[1] === '-item') {
          if (state.item !== itemId) {
            state.item = itemId;

            console.log(`${player} 持ち物公開: ${itemLabel(itemId)}`);
          }
        } else if (state.item === itemId) {
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

      battleState[player].hpPercent = condition.hpPercent;

      rememberStatus(player, condition.status, true);
    }

    if (parts[1] === '-status') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      rememberStatus(player, parts[3]);

      console.log(`${player} 状態異常: ${parts[3]}`);
    }

    if (parts[1] === '-curestatus') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      rememberStatus(player, null);

      console.log(`${player} 状態異常が治りました`);
    }

    if (parts[1] === 'move') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const move = battleDex.moves.get(parts[3]);

      recordMoveForSpeedLearning(player, parts[3]);

      battleState[player].lastMove = move.id;

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

      console.log(`${player} 能力変化: ` + `${stat} -${amount} → ` + `${battleState[player].boosts[stat]}`);
    }

    if (parts[1] === '-setboost') {
      const player = parts[2]?.slice(0, 2);

      const stat = parts[3];

      const amount = Number(parts[4]);

      if (!battleState[player] || !(stat in battleState[player].boosts)) {
        continue;
      }

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

    if (parts[1] === '-formechange') {
      const player = parts[2]?.slice(0, 2);

      if (!battleState[player]) {
        continue;
      }

      const oldSpecies = battleState[player].species;

      const newSpecies = parts[3];

      if (oldSpecies && battleState[player].revealedMoves[oldSpecies]) {
        battleState[player].revealedMoves[newSpecies] = battleState[player].revealedMoves[oldSpecies];
      }

      battleState[player].species = newSpecies;
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

  if (!state?.item || !state.species) {
    return '';
  }

  return battleDex.species.get(state.species).name === speciesName ? state.item : '';
}

function rangedCombatant(species, statName, endpoint, boosts, player) {
  const spread = spreadForEndpoint(statName, endpoint);

  const state = player ? battleState[player] : null;

  return {
    species: species.name,
    ability: revealedAbilityFor(player, species.name),
    item: revealedItemFor(player, species.name),
    status: state?.status ?? null,
    boosts: {
      ...createEmptyBoosts(),
      ...(boosts ?? {}),
    },
    hpPercent: state?.hpPercent ?? 100,
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
    moves: ['Tackle'],
    nature: combatant.nature || 'Serious',
    evs: combatant.evs || emptyEvs(),
    level: currentBattleLevel(),
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

  const percent = combatant.hpPercent ?? 100;

  mon.hp = Math.max(1, Math.round((mon.maxhp * percent) / 100));
}

function copyLiveField(calc, source) {
  const live = stream?.battle;

  if (!live?.field) {
    return;
  }

  if (live.field.weather) {
    calc.field.setWeather(live.field.weather, source);
  }

  if (live.field.terrain) {
    calc.field.setTerrain(live.field.terrain, source);
  }

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

function hitSpread(move, attacker) {
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

  if (attacker?.ability === 'skilllink') {
    return [
      {
        hits: max,
        probability: 1,
      },
    ];
  }

  if (move.multiaccuracy) {
    const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
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
    if (attacker?.item === 'loadeddice') {
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

  if (typeof spec === 'number' && spec === 10 && attacker?.item === 'loadeddice') {
    return [4, 5, 6, 7, 8, 9, 10].map((hits) => ({
      hits,
      probability: 1 / 7,
    }));
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

function showdownDamagePercent(calc, attacker, defender, move, roll) {
  calc.randomChance = () => false;

  calc.random = (n = 2) => (n === 16 ? roll : 0);

  const berryHalve = resistBerryHalve(defender.item, move.type, defender.getTypes?.() ?? []);

  if (berryHalve) {
    defender.item = '';
  }

  const spread = hitSpread(move, attacker);
  const maxHits = spread.reduce((highest, row) => Math.max(highest, row.hits), 1);
  const minHits = spread.reduce((lowest, row) => Math.min(lowest, row.hits), maxHits);

  function hitDamage(hit, willCrit, parentalBond) {
    const activeMove = calc.dex.getActiveMove(move.id);

    if (move.id === 'struggle') {
      activeMove.type = '???';
    }

    activeMove.hit = parentalBond ? 2 : hit;
    activeMove.willCrit = willCrit;

    if (parentalBond) {
      activeMove.multihitType = 'parentalbond';
    }

    const damage = calc.actions.getDamage(attacker, defender, activeMove, true);

    if (damage === false || damage == null) {
      return null;
    }

    return damage;
  }

  function collect(willCrit) {
    const damages = [];

    for (let hit = 1; hit <= maxHits; hit++) {
      const damage = hitDamage(hit, willCrit, false);

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
      bond = hitDamage(1, willCrit, true) || 0;
    }

    const sumTo = (hits) => damages.slice(0, hits).reduce((sum, damage) => sum + damage, 0) + bond;

    const expected = spread.reduce((sum, row) => sum + sumTo(Math.min(row.hits, damages.length)) * row.probability, 0);

    return {
      expected,
      min: sumTo(Math.min(minHits, damages.length)),
      max: sumTo(damages.length),
    };
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

  const scale = (amount) => (berryHalve ? amount * 0.5 : amount);
  const expected = scale(normal.expected);

  let recoilHp = 0;

  if (move.struggleRecoil || move.id === 'struggle') {
    recoilHp = Math.floor(attacker.maxhp / 4);
  } else if (move.mindBlownRecoil || move.chloroblastRecoil) {
    recoilHp = Math.round(attacker.maxhp / 2);
  } else if (move.recoil && attacker.ability !== 'rockhead' && attacker.ability !== 'magicguard') {
    recoilHp = Math.max(1, Math.round((expected * move.recoil[0]) / move.recoil[1]));
  }

  let drainHp = 0;

  if (move.drain) {
    drainHp = Math.round((expected * move.drain[0]) / move.drain[1]);

    if (defender.ability === 'liquidooze') {
      recoilHp += drainHp;
      drainHp = 0;
    }
  }

  if (attacker.item === 'lifeorb' && attacker.ability !== 'magicguard' && attacker.ability !== 'sheerforce' && expected > 0) {
    recoilHp += Math.round(attacker.maxhp / 10);
  }

  if (move.hasCrashDamage && attacker.ability !== 'magicguard') {
    const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;

    recoilHp += (1 - accuracy) * (attacker.maxhp / 2);
  }

  return {
    immune: false,
    percent: (expected / defender.maxhp) * 100,
    minPercent: (scale(normal.min) / defender.maxhp) * 100,
    maxPercent: (scale(normal.max) / defender.maxhp) * 100,
    critPercent: (scale(crit.expected) / defender.maxhp) * 100,
    critMinPercent: (scale(crit.min) / defender.maxhp) * 100,
    critMaxPercent: (scale(crit.max) / defender.maxhp) * 100,
    critChance,
    recoilPercent: ((recoilHp - drainHp) / attacker.maxhp) * 100,
  };
}

function createDamageBattle(attackerSpec, defenderSpec, defenderPlayer) {
  const calc = new Battle({
    formatid: FORMAT,
    send() {},
  });

  const defenderIndex = defenderPlayer === 'p1' ? 0 : 1;

  const attackerIndex = defenderIndex === 0 ? 1 : 0;

  const sets = [];
  sets[attackerIndex] = toCalcSet(attackerSpec);
  sets[defenderIndex] = toCalcSet(defenderSpec);

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

  copyLiveField(calc, source);

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

function measureShowdownDamage(attackerSpec, defenderSpec, move, weather, defenderPlayer, roll, attackerPlayer = null) {
  const session = createDamageBattle(attackerSpec, defenderSpec, defenderPlayer);

  try {
    useWeather(session.calc, weather, session.source);
    applyPublicCritVolatiles(session.attacker, attackerPlayer);

    return showdownDamagePercent(session.calc, session.attacker, session.defender, move, roll);
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

function estimateBattleDamage({ move, attackerSpecies, defenderSpecies, attackerPokemon = null, defenderPokemon = null, attackerBoosts = null, defenderBoosts = null, attackerPlayer = null, defenderPlayer = null, weather = fieldState.weather }) {
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

  const defenseBoostTable = defenderBoosts ?? (defenderPlayer ? battleState[defenderPlayer].boosts : createEmptyBoosts());

  const resolvedAttacker = attackerPlayer ?? (defenderPlayer === 'p1' ? 'p2' : defenderPlayer === 'p2' ? 'p1' : null);

  const attackerGrounded = attackerPokemon ? isPokemonGrounded(attackerPokemon) : isActiveGrounded(resolvedAttacker, attackerSpecies);

  const defenderGrounded = defenderPokemon ? isPokemonGrounded(defenderPokemon) : isActiveGrounded(defenderPlayer, defenderSpecies);

  const failReason = getTerrainFailReason(move, defenderGrounded, resolvedAttacker, attackerPokemon);

  if (failReason) {
    return {
      ...empty,
      immune: true,
      failReason,
    };
  }

  const lowAttacker = attackerPokemon ? knownCombatant(attackerPokemon, attackBoostTable) : rangedCombatant(attackerSpecies, attackStatName, 'min', attackBoostTable, resolvedAttacker);

  const highAttacker = attackerPokemon ? lowAttacker : rangedCombatant(attackerSpecies, attackStatName, 'max', attackBoostTable, resolvedAttacker);

  const bulkyDefender = defenderPokemon ? knownCombatant(defenderPokemon, defenseBoostTable) : rangedCombatant(defenderSpecies, defenseStatName, 'max', defenseBoostTable, defenderPlayer);

  const frailDefender = defenderPokemon ? bulkyDefender : rangedCombatant(defenderSpecies, defenseStatName, 'min', defenseBoostTable, defenderPlayer);

  const low = measureShowdownDamage(lowAttacker, bulkyDefender, move, weather, defenderPlayer, 15, resolvedAttacker);

  const high = measureShowdownDamage(highAttacker, frailDefender, move, weather, defenderPlayer, 0, resolvedAttacker);

  if (low.immune || high.immune) {
    return {
      ...empty,
      immune: true,
    };
  }

  const accuracy = move.accuracy === true ? 100 : move.accuracy;

  const context = describeSimDamage(move, lowAttacker.status, attackerGrounded, defenderGrounded, defenderPlayer);

  const critChance = low.critChance || 0;
  const alwaysCrit = critChance >= 1;
  const expectedLow = low.percent * (1 - critChance) + low.critPercent * critChance;
  const expectedHigh = high.percent * (1 - critChance) + high.critPercent * critChance;
  const critFactor = high.percent > 0 ? high.critPercent / high.percent : 1.5;

  const hits = hitBounds(move, lowAttacker);

  const fieldParts = [context.fieldReason, hits.expected > 1 ? `連続${hits.expected.toFixed(1)}回` : null, critChance >= 1 / 8 ? `急所${Math.round(critChance * 100)}%` : null].filter(Boolean);

  return {
    immune: false,
    minDamagePercent: alwaysCrit ? low.critMinPercent : low.minPercent,
    maxDamagePercent: alwaysCrit ? high.critMaxPercent : high.maxPercent,
    score: ((expectedLow + expectedHigh) / 2) * (accuracy / 100),
    recoilPercent: (low.recoilPercent + high.recoilPercent) / 2,
    weatherReason: context.weatherReason,
    fieldReason: fieldParts.join(' / ') || null,
    failReason: null,
    critChance,
    critFactor,
    critMaxDamagePercent: high.critMaxPercent,
  };
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

function evaluateProtectMove(activePokemon, attackerPlayer, opponentSpeciesName, opponentBoosts, ownBoosts, ownStatus, opponentStatus) {
  if (!attackerPlayer) {
    return null;
  }

  const opponent = attackerPlayer === 'p1' ? 'p2' : 'p1';

  const threat = evaluatePreMoveThreat(attackerPlayer, activePokemon, { id: 'tackle' }, opponentSpeciesName, getRevealedMoves(opponent, opponentSpeciesName), opponentBoosts, ownBoosts, ownStatus, opponentStatus);

  if (!threat.threat) {
    return {
      score: 10,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: '先に倒される危険なし',
    };
  }

  const koLabel = threat.threat.guaranteedKo ? '確定KO' : '乱数KO';
  const protectScale = threat.threat.guaranteedKo && threat.threat.order === 'opponent' && !String(threat.threat.moveName).startsWith('予想:') ? 0.65 : 0.35;

  return {
    score: Math.round(threat.threat.penalty * protectScale),
    minDamagePercent: 0,
    maxDamagePercent: 0,
    reason: `相手の${threat.threat.moveName}が先に` + `${koLabel}するためまもる`,
  };
}

const STANDARD_FIELD_TURNS = 5;

function baseSpeciesName(name) {
  const species = battleDex.species.get(name);

  return species.exists ? species.baseSpecies : name;
}

function benchSpeciesNames(defenderPlayer) {
  const state = battleState[defenderPlayer];
  const active = state?.species ? baseSpeciesName(state.species) : null;

  return (state?.previewSpecies ?? []).filter((name) => name && baseSpeciesName(name) !== active && !state.faintedSpecies.has(baseSpeciesName(name)));
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

function evaluateSandSnowSetup(move, activePokemon) {
  const turns = heldFieldTurns(move.id, activePokemon?.item);

  if (move.id === 'sandstorm') {
    return {
      score: 6.25 * turns,
      reason: `砂嵐ダメージ 約${turns}ターン`,
    };
  }

  if (move.id === 'snowscape' || move.id === 'hail') {
    return {
      score: 8 * turns,
      reason: `雪で防御上昇 約${turns}ターン`,
    };
  }

  return null;
}

function evaluateFieldSetupMove(move, activePokemon, opponentSpecies, opponentBoosts, opponentStatus, attackerPlayer, defenderPlayer) {
  if (move.id === 'trickroom') {
    return evaluateTrickRoomMove(attackerPlayer, activePokemon, opponentSpecies.name, opponentBoosts, opponentStatus);
  }

  return evaluateHazardSetupMove(move, defenderPlayer) || evaluateScreenSetupMove(move, activePokemon, opponentSpecies, opponentBoosts, attackerPlayer, defenderPlayer) || evaluateTerrainSetupMove(move, activePokemon, attackerPlayer) || evaluateSandSnowSetup(move, activePokemon);
}

// ========================================
// 技評価
// ========================================

function statusBlockedByAbility(status, abilityId) {
  if (!abilityId) {
    return null;
  }

  if (['comatose', 'shieldsdown', 'goodasgold'].includes(abilityId)) {
    return '特性で変化技無効';
  }

  if (abilityId === 'leafguard' && fieldState.weather === 'sun') {
    return 'リーフガード';
  }

  if (status === 'par' && abilityId === 'limber') {
    return 'じゅうなん';
  }

  if (status === 'brn' && ['waterveil', 'waterbubble', 'thermalexchange'].includes(abilityId)) {
    return 'やけど無効';
  }

  if ((status === 'psn' || status === 'tox') && ['immunity', 'pastelveil'].includes(abilityId)) {
    return 'どく無効';
  }

  if ((status === 'slp' || status === 'confusion') && ['insomnia', 'vitalspirit', 'sweetveil'].includes(abilityId)) {
    return 'ねむり無効';
  }

  if (status === 'frz' && abilityId === 'magmaarmor') {
    return 'こおり無効';
  }

  if (status === 'confusion' && abilityId === 'owntempo') {
    return 'こんらん無効';
  }

  return null;
}

function choiceLockedMove(player) {
  const item = battleState[player]?.item;

  if (!['choiceband', 'choicespecs', 'choicescarf'].includes(item)) {
    return null;
  }

  return battleState[player].lastMove || null;
}

function evaluateUtilityStatusMove(move, activePokemon, opponentSpecies, ownBoosts, defenderPlayer = null, attackerPlayer = null, opponentBoosts = null, opponentStatus = null) {
  const accuracy = move.accuracy === true ? 100 : move.accuracy;

  const opponentAbility = defenderPlayer ? battleState[defenderPlayer]?.ability : null;

  const blocked = statusBlockedByAbility(move.status || move.id, opponentAbility);

  if (blocked && move.target !== 'self' && move.target !== 'allySide' && move.target !== 'all') {
    return {
      score: -100,
      reason: blocked,
    };
  }

  if (move.heal) {
    const hp = parseCondition(activePokemon.condition).hpPercent;
    const healPercent = (100 * move.heal[0]) / move.heal[1];

    if (hp >= 95) {
      return {
        score: -15,
        reason: '体力が満タン',
      };
    }

    const restored = Math.min(healPercent, 100 - hp);

    return {
      score: restored * 0.8,
      reason: `回復${restored.toFixed(0)}%`,
    };
  }

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

  if (move.id === 'yawn') {
    return {
      score: 24,
      reason: 'あくび',
    };
  }

  if (move.id === 'tailwind') {
    if (attackerPlayer && fieldState.sides[attackerPlayer]?.tailwind) {
      return {
        score: -100,
        reason: 'すでにおいかぜ',
      };
    }

    if (attackerPlayer && activePokemon) {
      const estimate = getSpeedEstimate(attackerPlayer, activePokemon, ownBoosts, battleState[attackerPlayer]?.status ?? null, opponentSpecies.name, opponentBoosts ?? createEmptyBoosts(), opponentStatus);

      if (estimate.relation === 'opponent') {
        return {
          score: 36,
          reason: 'おいかぜで先に動く',
        };
      }

      if (estimate.relation === 'own') {
        return {
          score: 8,
          reason: 'おいかぜ すでに速い',
        };
      }
    }

    return {
      score: 18,
      reason: 'おいかぜ',
    };
  }

  if (move.id === 'leechseed') {
    if (opponentSpecies.types?.includes('Grass')) {
      return {
        score: -100,
        reason: 'やどりぎ無効',
      };
    }

    return {
      score: 26,
      reason: 'やどりぎのタネ',
    };
  }

  if (move.id === 'taunt') {
    return {
      score: 22,
      reason: 'ちょうはつ',
    };
  }

  if (move.id === 'encore') {
    return {
      score: 20,
      reason: 'アンコール',
    };
  }

  if (move.id === 'disable') {
    return {
      score: 18,
      reason: 'かなしばり',
    };
  }

  if (move.id === 'trick' || move.id === 'switcheroo') {
    return {
      score: 16,
      reason: '持ち物を入れ替える',
    };
  }

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
    const types = opponentSpecies.types ?? [];

    if (move.status === 'par' && types.includes('Electric')) {
      return {
        score: -100,
        reason: 'まひ無効',
      };
    }

    if (move.status === 'brn' && types.includes('Fire')) {
      return {
        score: -100,
        reason: 'やけど無効',
      };
    }

    if ((move.status === 'psn' || move.status === 'tox') && (types.includes('Poison') || types.includes('Steel'))) {
      return {
        score: -100,
        reason: 'どく無効',
      };
    }

    const values = {
      par: 36,
      brn: 32,
      tox: 28,
      psn: 16,
      slp: 40,
    };

    return {
      score: (values[move.status] ?? 12) * (accuracy / 100),
      reason: '状態異常',
    };
  }

  if (move.id === 'helpinghand') {
    return {
      score: -100,
      reason: 'シングルではてだすけ不可',
    };
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
    const ownHp = parseCondition(activePokemon.condition).hpPercent;
    const foeHp = battleState[defenderPlayer].hpPercent ?? 100;
    const gained = (ownHp + foeHp) / 2 - ownHp;

    return {
      score: gained * 0.8,
      reason: `いたみわけ ${gained >= 0 ? '+' : ''}${gained.toFixed(0)}%`,
    };
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

  if (move.boosts && move.target !== 'self') {
    if (opponentAbility === 'mirrorarmor') {
      return {
        score: -18,
        reason: 'ミラーアーマーで跳ね返る',
      };
    }

    const weights = {
      atk: 25,
      spa: 25,
      def: 10,
      spd: 10,
      spe: 18,
    };

    let score = 0;

    for (const [stat, stages] of Object.entries(move.boosts)) {
      if (stages < 0) {
        score += Math.abs(stages) * (weights[stat] || 8);
      }
    }

    if (score > 0) {
      return {
        score: score * (accuracy / 100),
        reason: '能力を下げる',
      };
    }
  }

  return null;
}

function addedEffectScore(move, activePokemon, opponentStatus, attackerBoosts, defenderBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName) {
  if (normalizeBattleEffect(activePokemon?.ability) === 'sheerforce') {
    return {
      score: 0,
      reason: null,
    };
  }

  const effects = [move.secondary, ...(move.secondaries ?? [])].filter(Boolean);

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

  const serene = normalizeBattleEffect(activePokemon?.ability) === 'serenegrace' ? 2 : 1;
  let score = 0;
  const reasons = [];

  for (const effect of effects) {
    const chance = Math.min(100, (effect.chance ?? 100) * serene) / 100;

    const abilityBlock = statusBlockedByAbility(effect.status, defenderPlayer ? battleState[defenderPlayer]?.ability : null);

    if (!abilityBlock && !opponentStatus && effect.status === 'brn') {
      score += chance * 28;
      reasons.push('やけど');
    } else if (!abilityBlock && !opponentStatus && effect.status === 'par') {
      score += chance * 22;
      reasons.push('まひ');
    } else if (!abilityBlock && !opponentStatus && effect.status === 'tox') {
      score += chance * 18;
      reasons.push('もうどく');
    } else if (!abilityBlock && !opponentStatus && effect.status === 'psn') {
      score += chance * 12;
      reasons.push('どく');
    } else if (!abilityBlock && !opponentStatus && effect.status === 'frz') {
      score += chance * 20;
      reasons.push('こおり');
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

    if (effect.volatileStatus === 'confusion' && statusBlockedByAbility('confusion', defenderPlayer ? battleState[defenderPlayer]?.ability : null)) {
      // こんらん無効のときは点数を足さない。
    } else if (volatileValue[effect.volatileStatus]) {
      const [value, label] = volatileValue[effect.volatileStatus];

      score += chance * value;
      reasons.push(label);
    }

    if (effect.volatileStatus === 'partiallytrapped' || effect.volatileStatus === 'leechseed') {
      score += chance * 14;
      reasons.push(effect.volatileStatus === 'leechseed' ? 'やどりぎ' : 'まきつく');
    }

    if (effect.volatileStatus === 'flinch' && attackerPlayer) {
      const order = getSpeedEstimate(attackerPlayer, activePokemon, attackerBoosts, battleState[attackerPlayer]?.status ?? null, opponentSpeciesName, defenderBoosts, opponentStatus);

      if (order.relation !== 'opponent') {
        score += chance * 24;
        reasons.push('ひるみ');
      }
    }

    const boosts = effect.boosts ?? {};

    for (const [stat, stages] of Object.entries(boosts)) {
      if (stages < 0) {
        score += chance * Math.abs(stages) * 8;
        reasons.push('能力下降');
      }
    }

    for (const [stat, stages] of Object.entries(effect.self?.boosts ?? {})) {
      if (stages > 0) {
        score += chance * stages * 8;
        reasons.push('追加で能力上昇');
      }
    }
  }

  return {
    score,
    reason: reasons.length ? reasons[0] : null,
  };
}

function focusSashHolds(item, hpPercent, move) {
  if (normalizeBattleEffect(item) !== 'focussash' || hpPercent < 100) {
    return false;
  }

  const hits = move?.multihit;

  if (!hits) {
    return true;
  }

  if (typeof hits === 'number') {
    return hits <= 1;
  }

  return hits[1] <= 1;
}

function cantMoveFactor(status, player = null) {
  const age = player ? battleState[player]?.statusAge || 0 : 0;
  let factor = 1;

  // ねむりの内部残りターンは非公開。動けなかった回数だけを使う。こおりは毎ターン20%で溶ける。
  if (status === 'slp') {
    const earlyBird = player && battleState[player]?.ability === 'earlybird';
    const asleep = earlyBird ? [2 / 3, 1 / 3, 0][Math.min(age, 2)] : [1, 2 / 3, 1 / 3, 0][Math.min(age, 3)];

    factor = 1 - (asleep ?? 0);
  } else if (status === 'frz') {
    factor = 0.2;
  } else if (status === 'par') {
    factor = 0.75;
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

  return false;
}

function evaluateMove(moveRequest, ownSpeciesName, opponentSpeciesName, opponentStatus, lastMoveId, ownBoosts, opponentBoosts, request, attackerPlayer = null, defenderPlayer = null) {
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

  if ((ownStatus === 'slp' || ownStatus === 'frz') && !move.sleepUsable) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: ownStatus === 'slp' ? 'ねむっていて動けない' : 'こおっていて動けない',
    };
  }

  const lockedMove = attackerPlayer ? choiceLockedMove(attackerPlayer) : null;

  if (lockedMove && lockedMove !== move.id) {
    return {
      score: -100,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: 'こだわりで使えない',
    };
  }

  const ownAbility = normalizeBattleEffect(activePokemon.ability) || (attackerPlayer ? battleState[attackerPlayer]?.ability : null);

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
    const fieldMoveRepeatReason = getFieldMoveRepeatReason(move.id, attackerPlayer);

    if (fieldMoveRepeatReason) {
      return {
        score: -100,
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

    const fieldSetupEvaluation = evaluateFieldSetupMove(move, activePokemon, opponentPokemon, opponentBoosts, opponentStatus, attackerPlayer, defenderPlayer);

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
      const previousMove = lastMoveId ? battleDex.moves.get(lastMoveId) : null;

      if (previousMove?.stallingMove) {
        return {
          score: -50,
          minDamagePercent: 0,
          maxDamagePercent: 0,
          reason: '前ターンもまもる系',
        };
      }

      const protectEvaluation = evaluateProtectMove(activePokemon, attackerPlayer, opponentSpeciesName, opponentBoosts, ownBoosts, attackerPlayer ? battleState[attackerPlayer].status : null, opponentStatus);

      if (protectEvaluation) {
        return protectEvaluation;
      }
    }

    const selfBoosts = {
      ...(move.target === 'self' && move.boosts ? move.boosts : {}),
      ...(move.self?.boosts ?? {}),
    };

    const boostEntries = Object.entries(selfBoosts);

    if (boostEntries.length > 0) {
      let boostScore = 0;
      let changed = false;

      const weights = {
        atk: 25,
        spa: 25,
        def: 10,
        spd: 10,
        spe: 12,
      };

      for (const [stat, amount] of boostEntries) {
        if (!(stat in weights)) {
          continue;
        }

        const currentStage = ownBoosts[stat] ?? 0;

        const nextStage = clampBoost(currentStage + amount);

        if (currentStage === nextStage) {
          continue;
        }

        changed = true;

        const currentMultiplier = getBoostMultiplier(currentStage);

        const nextMultiplier = getBoostMultiplier(nextStage);

        const improvement = nextMultiplier / currentMultiplier - 1;

        boostScore += improvement * weights[stat];
      }

      if (!changed) {
        return {
          score: -50,
          minDamagePercent: 0,
          maxDamagePercent: 0,
          reason: '能力ランク上限',
        };
      }

      const condition = parseCondition(activePokemon.condition);

      if (condition.hpPercent <= 30) {
        boostScore *= 0.35;
      } else if (condition.hpPercent <= 50) {
        boostScore *= 0.65;
      }

      return {
        score: 10 + boostScore,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: '積み技',
      };
    }

    const sleepEvaluation = evaluateSleepStatusMove(move, activePokemon, opponentPokemon, opponentBoosts, defenderPlayer, attackerPlayer);

    if (sleepEvaluation) {
      return sleepEvaluation;
    }

    const utilityEvaluation = evaluateUtilityStatusMove(move, activePokemon, opponentPokemon, ownBoosts, defenderPlayer, attackerPlayer, opponentBoosts, opponentStatus);

    if (utilityEvaluation) {
      return {
        score: utilityEvaluation.score,
        minDamagePercent: 0,
        maxDamagePercent: 0,
        reason: utilityEvaluation.reason,
      };
    }

    return {
      score: 10,
      minDamagePercent: 0,
      maxDamagePercent: 0,
      reason: null,
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

  const damageRange = estimateBattleDamage({
    move,
    attackerSpecies: ownPokemon,
    defenderSpecies: opponentPokemon,
    attackerPokemon: activePokemon,
    attackerBoosts: ownBoosts,
    defenderBoosts: opponentBoosts,
    defenderPlayer,
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

  const added = addedEffectScore(move, activePokemon, opponentStatus, ownBoosts, opponentBoosts, attackerPlayer, defenderPlayer, opponentSpeciesName);

  let contactChip = 0;

  if (move.flags?.contact && defenderPlayer && battleState[defenderPlayer]?.item === 'rockyhelmet') {
    const hits = hitBounds(move, {
      ability: normalizeBattleEffect(activePokemon.ability),
      item: normalizeBattleEffect(activePokemon.item),
    });

    contactChip = (100 / 6) * hits.expected * ((move.accuracy === true ? 100 : move.accuracy) / 100);
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

  const selfDrop = move.self?.boosts && Object.values(move.self.boosts).some((value) => value < 0);

  if (selfDrop && normalizeBattleEffect(activePokemon?.item) === 'ejectpack') {
    itemPenalty += 18;
    itemReason = 'だっしゅつパック';
  }

  let knockOffBonus = 0;

  if (move.id === 'knockoff' && defenderItem) {
    knockOffBonus = 18;
    itemReason = itemReason ? `${itemReason} はたきおとす` : 'はたきおとす';
  }

  const reasons = [move.id === 'struggle' ? 'わるあがき反動' : null, damageRange.recoilPercent > 0.5 ? '反動' : null, damageRange.recoilPercent < -0.5 ? '吸収' : null, defenderPlayer && battleState[defenderPlayer]?.ability === 'liquidooze' && move.drain ? 'ヘドロえき' : null, added.reason, contactChip > 0 ? 'ゴツゴツメット' : null, itemReason].filter(Boolean);

  return {
    score: damageRange.score - damageRange.recoilPercent + added.score - contactChip - itemPenalty + knockOffBonus,
    minDamagePercent: damageRange.minDamagePercent,
    maxDamagePercent: damageRange.maxDamagePercent,
    weatherReason: damageRange.weatherReason,
    fieldReason: damageRange.fieldReason,
    reason: reasons.join(' ') || null,
    critChance: damageRange.critChance ?? 0,
    critFactor: damageRange.critFactor ?? 1,
    critMaxDamagePercent: damageRange.critMaxDamagePercent ?? 0,
  };
}

// ========================================
// ポケモン名取得
// ========================================

function getPokemonSpeciesName(pokemon) {
  return pokemon.details?.split(',')[0].trim();
}

function usesFixedDamage(move) {
  return move?.damage != null || typeof move?.damageCallback === 'function';
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

function estimatePokemonAttackScore(pokemon, opponentSpeciesName, defenderPlayer = null) {
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

    const damageRange = estimateBattleDamage({
      move,
      attackerSpecies: ownPokemon,
      defenderSpecies: opponentPokemon,
      attackerPokemon: pokemon,
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

function estimateIncomingDamage(defender, opponentSpeciesName, moveId, opponentBoosts, defenderPlayer = null, weather = fieldState.weather) {
  const defenderSpeciesName = getPokemonSpeciesName(defender);

  const defenderSpecies = battleDex.species.get(defenderSpeciesName);

  const opponentSpecies = battleDex.species.get(opponentSpeciesName);

  const move = battleDex.moves.get(moveId);

  if (!isDamagingMove(move)) {
    return null;
  }

  const damageRange = estimateBattleDamage({
    move,
    attackerSpecies: opponentSpecies,
    defenderSpecies,
    defenderPokemon: defender,
    attackerBoosts: opponentBoosts,
    defenderPlayer,
    weather,
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
    fieldReason: damageRange.fieldReason,
  };
}

// ========================================
// 交代時の危険度
// ========================================

const learnedDamagingMoveIds = new Map();

const guessedStabDamageCache = new Map();

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

function guessIncomingDamage(defender, opponentSpeciesName, opponentBoosts, defenderPlayer, excludeMoveIds = []) {
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
    const damage = estimateIncomingDamage(defender, opponentSpeciesName, candidate.moveId, opponentBoosts, defenderPlayer);

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

function hiddenIncomingThreat(defender, opponentSpeciesName, opponentBoosts, defenderPlayer, revealedMoveIds) {
  const openSlots = Math.max(4 - revealedMoveIds.length, 0);

  if (!openSlots) {
    return null;
  }

  const guessed = guessIncomingDamage(defender, opponentSpeciesName, opponentBoosts, defenderPlayer, revealedMoveIds);

  if (!guessed?.options?.length) {
    return null;
  }

  const considered = [];
  const usedTypes = new Set();

  for (const damage of guessed.options) {
    const move = battleDex.moves.get(damage.moveId || damage.moveName);
    const type = move?.type;

    if (type && usedTypes.has(type)) {
      continue;
    }

    if (type) {
      usedTypes.add(type);
    }

    considered.push(damage);

    if (considered.length >= Math.min(3, openSlots)) {
      break;
    }
  }

  if (!considered.length) {
    considered.push(guessed.options[0]);
  }

  const weight = hiddenMoveWeight(openSlots);

  const average = considered.reduce((sum, damage) => sum + damage.expectedDamagePercent, 0) / considered.length;

  const mixed = guessed.expectedDamagePercent * 0.6 + average * 0.4;

  return {
    ...guessed,
    guessed: true,
    moveName: considered.map((damage) => damage.moveName).join('/'),
    minDamagePercent: guessed.minDamagePercent * weight,
    maxDamagePercent: guessed.maxDamagePercent * weight,
    expectedDamagePercent: mixed * weight,
  };
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

    const damage = estimateIncomingDamage(pokemon, opponentSpeciesName, moveId, opponentBoosts, defenderPlayer);

    if (!damage) {
      continue;
    }

    if (!worstDamage || damage.expectedDamagePercent > worstDamage.expectedDamagePercent) {
      worstDamage = damage;
    }
  }

  const encored = attackerPlayer ? battleState[attackerPlayer]?.volatiles?.encoreMove : null;

  if (encored) {
    const encoredDamage = estimateIncomingDamage(pokemon, opponentSpeciesName, encored, opponentBoosts, defenderPlayer);

    worstDamage = encoredDamage && encoredDamage.expectedDamagePercent > 0 ? encoredDamage : worstDamage;
  }

  const locked = attackerPlayer ? choiceLockedMove(attackerPlayer) : null;

  if (locked) {
    const lockedDamage = estimateIncomingDamage(pokemon, opponentSpeciesName, locked, opponentBoosts, defenderPlayer);

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

  const defenderItem = pokemon.item || (defenderPlayer ? battleState[defenderPlayer]?.item : null);

  const sash = focusSashHolds(defenderItem, condition.hpPercent, null);

  if (!sash && !worstDamage.guessed && worstDamage.minDamagePercent >= condition.hpPercent) {
    penalty += 40;

    koRisk = '確定で倒れる危険';
  } else if (!sash && !worstDamage.guessed && worstDamage.maxDamagePercent >= condition.hpPercent) {
    penalty += 20;

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
  if (normalizeBattleEffect(pokemon.ability) !== 'intimidate') {
    return null;
  }

  const reaction = opponentPlayer ? intimidateReaction(battleState[opponentPlayer]?.ability) : null;

  if (reaction === 'immune') {
    return {
      boosts: opponentBoosts,
      bonus: 0,
      note: 'いかく無効',
    };
  }

  if (reaction === 'defiant') {
    return {
      boosts: opponentBoosts,
      bonus: -20,
      note: 'いかくで攻撃上昇',
    };
  }

  if (reaction === 'competitive') {
    return {
      boosts: opponentBoosts,
      bonus: -16,
      note: 'いかくで特攻上昇',
    };
  }

  if (reaction === 'contrary') {
    return {
      boosts: {
        ...opponentBoosts,
        atk: clampBoost((opponentBoosts?.atk ?? 0) + 1),
      },
      bonus: -24,
      note: 'たんじゅんで攻撃上昇',
    };
  }

  if (reaction === 'mirrorarmor') {
    return {
      boosts: opponentBoosts,
      bonus: -18,
      note: 'ミラーアーマー',
    };
  }

  const currentAtk = opponentBoosts?.atk ?? 0;
  const nextAtk = clampBoost(currentAtk - 1);

  if (nextAtk === currentAtk) {
    return {
      boosts: opponentBoosts,
      bonus: 0,
      note: 'いかく不可',
    };
  }

  return {
    boosts: {
      ...opponentBoosts,
      atk: nextAtk,
    },
    // 技が未公開のときだけ、物理技が来た場合の分を小さく足す。
    bonus: revealedMoveIds.length === 0 ? 12 : 0,
    note: 'いかく',
  };
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

      const attackScore = estimatePokemonAttackScore(pokemon, opponentSpeciesName, opponentPlayer);

      const defenseScore = getDefensiveMatchupScore(species, opponentSpeciesName, revealedMoveIds);

      const condition = parseCondition(pokemon.condition);

      const hpFactor = Math.max(0.25, condition.hpPercent / 100);

      const intimidate = getIntimidateSwitch(pokemon, opponentBoosts, revealedMoveIds, opponentPlayer);

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

function getOpponentSpeedRange(observer, opponentSpeciesName, opponentBoosts, opponentStatus) {
  const knowledge = ensureSpeedKnowledge(observer, opponentSpeciesName);

  const opponent = observer === 'p1' ? 'p2' : 'p1';

  const range = getEffectiveCandidateRange(knowledge.candidates, opponentBoosts.spe, opponentStatus, getPublicSpeedModifiers(opponent));

  return {
    ...range,
    observations: knowledge.observations,
  };
}

function getSpeedEstimate(observer, activePokemon, ownBoosts, ownStatus, opponentSpeciesName, opponentBoosts, opponentStatus) {
  const ownSpeed = getEffectiveSpeed(activePokemon.stats.spe, ownBoosts.spe, ownStatus, getPublicSpeedModifiers(observer, activePokemon));

  const opponentSpeedRange = getOpponentSpeedRange(observer, opponentSpeciesName, opponentBoosts, opponentStatus);

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

function compareEstimatedMoveOrder(ownMove, opponentMove, ownSpeed, opponentMinSpeed, opponentMaxSpeed, observer = null, ownPokemon = null) {
  const opponentPlayer = observer === 'p1' ? 'p2' : observer === 'p2' ? 'p1' : null;
  const ownPriority = effectiveMovePriority(ownMove, observer, ownPokemon);
  const opponentPriority = effectiveMovePriority(opponentMove, opponentPlayer, null);

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
  const opponentFractional = fractionalMovePriority(opponentMove, opponentPlayer, null);

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

  const speedEstimate = getSpeedEstimate(observer, activePokemon, ownBoosts, ownStatus, opponentSpeciesName, opponentBoosts, opponentStatus);

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

    const damage = estimateIncomingDamage(activePokemon, opponentSpeciesName, moveId, opponentBoosts, observer);

    if (!damage) {
      continue;
    }

    const order = compareEstimatedMoveOrder(ownMove, opponentMove, speedEstimate.ownSpeed, speedEstimate.opponentMinSpeed, speedEstimate.opponentMaxSpeed, observer, activePokemon);

    // 自分が先なら、この技で
    // 行動前に倒されることはない。
    if (order === 'own') {
      continue;
    }

    const sash = focusSashHolds(activePokemon.item, condition.hpPercent, opponentMove);

    const guaranteedKo = !sash && damage.minDamagePercent >= condition.hpPercent;

    const possibleKo = !sash && damage.maxDamagePercent >= condition.hpPercent;

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

  const guessed = choiceLockedMove(opponentPlayer) ? null : hiddenIncomingThreat(activePokemon, opponentSpeciesName, opponentBoosts, observer, revealedMoveIds);

  const guessedId = guessed?.options?.[0]?.moveId || guessed?.options?.[0]?.moveName;
  const guessedMove = guessedId ? battleDex.moves.get(guessedId) : null;

  if (guessed && guessedMove?.exists) {
    const minDamagePercent = guessed.minDamagePercent;

    const maxDamagePercent = guessed.maxDamagePercent;

    const order = compareEstimatedMoveOrder(ownMove, guessedMove, speedEstimate.ownSpeed, speedEstimate.opponentMinSpeed, speedEstimate.opponentMaxSpeed, observer, activePokemon);

    const sash = focusSashHolds(activePokemon.item, condition.hpPercent, guessedMove);

    const guaranteedKo = !sash && minDamagePercent >= condition.hpPercent;

    const possibleKo = !sash && maxDamagePercent >= condition.hpPercent;

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

function chooseAction(player, request) {
  syncFieldStateFromBattle();

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
    .filter(({ move }) => !move.disabled);

  if (!usableMoves.length) {
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

  const speedEstimate = getSpeedEstimate(player, activePokemon, battleState[player].boosts, battleState[player].status, opponentSpecies, battleState[opponent].boosts, battleState[opponent].status);

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
    const evaluation = evaluateMove(move, ownSpecies, opponentSpecies, battleState[opponent].status, battleState[player].lastMove, battleState[player].boosts, battleState[opponent].boosts, request, player, opponent);

    const baseScore = evaluation.score;

    let score = baseScore;

    let koType = null;

    const foeMove = battleDex.moves.get(move.id);

    const foeSash = focusSashHolds(battleState[opponent].item, opponentHp, foeMove);

    if (!foeSash && evaluation.minDamagePercent > 0 && evaluation.minDamagePercent >= opponentHp) {
      score += 80;
      koType = '確定';
    } else if (!foeSash && evaluation.maxDamagePercent > 0 && evaluation.maxDamagePercent >= opponentHp) {
      score += 40;
      koType = '乱数';
    } else if (!foeSash && evaluation.critChance > 0 && evaluation.critChance < 1 && (evaluation.critMaxDamagePercent || evaluation.maxDamagePercent * (evaluation.critFactor || 1)) >= opponentHp) {
      score += Math.round(40 * evaluation.critChance);
      koType = '急所';
    }

    let switchRead = null;

    if (isDamagingMove(foeMove)) {
      const resist = resistSwitchIn(opponent, foeMove);
      const currentMultiplier = moveTypeMultiplier(foeMove, battleDex.species.get(opponentSpecies).types);
      const serious = Boolean(koType) || currentMultiplier >= 2 || opponentHp <= 40;

      if (resist) {
        const switched = estimateBattleDamage({
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

  if (canSwitch && (!bestMove.koType || bestMoveIsUnsafe || !opponentDamageKnown)) {
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
