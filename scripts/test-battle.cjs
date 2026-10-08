const {
  BattleStream,
  Dex,
  Teams,
  TeamValidator,
} = require("../vendor/pokemon-showdown/dist/sim");

Dex.includeFormats();

const FORMAT = "gen9championsbssregmc";

// -------------------------
// AI-1 の6匹
// -------------------------

const team1 = [
  {
    species: "Venusaur",
    ability: "Overgrow",
    moves: ["Giga Drain"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Charizard",
    ability: "Blaze",
    moves: ["Flamethrower"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Blastoise",
    ability: "Torrent",
    moves: ["Surf"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Gengar",
    ability: "Cursed Body",
    moves: ["Shadow Ball"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Steelix",
    ability: "Sturdy",
    moves: ["Earthquake"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Arcanine",
    ability: "Intimidate",
    moves: ["Flamethrower"],
    nature: "Hardy",
    level: 100,
  },
];

// -------------------------
// AI-2 の6匹
// -------------------------

const team2 = [
  {
    species: "Arcanine",
    ability: "Intimidate",
    moves: ["Flamethrower"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Steelix",
    ability: "Sturdy",
    moves: ["Earthquake"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Gengar",
    ability: "Cursed Body",
    moves: ["Shadow Ball"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Blastoise",
    ability: "Torrent",
    moves: ["Surf"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Charizard",
    ability: "Blaze",
    moves: ["Flamethrower"],
    nature: "Hardy",
    level: 100,
  },
  {
    species: "Venusaur",
    ability: "Overgrow",
    moves: ["Giga Drain"],
    nature: "Hardy",
    level: 100,
  },
];

// -------------------------
// チームが合法かチェック
// -------------------------

const validator = new TeamValidator(FORMAT);

const team1Problems = validator.validateTeam(team1);
const team2Problems = validator.validateTeam(team2);

if (team1Problems) {
  console.error("AI-1 のチームに問題があります:");
  console.error(team1Problems);
  process.exit(1);
}

if (team2Problems) {
  console.error("AI-2 のチームに問題があります:");
  console.error(team2Problems);
  process.exit(1);
}

console.log("チームチェック: OK");

// Showdown用の形式に変換
const packedTeam1 = Teams.pack(team1);
const packedTeam2 = Teams.pack(team2);

// -------------------------
// BattleStream
// -------------------------

const stream = new BattleStream();

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function chooseAction(request) {
  // -------------------------
  // 6匹から3匹を選出
  // -------------------------

  if (request.teamPreview) {
    return "team 123";
  }

  if (request.wait) {
    return null;
  }

  // -------------------------
  // 瀕死時の交代
  // -------------------------

  if (request.forceSwitch?.some(Boolean)) {
    const switchablePokemon = request.side.pokemon
      .map((pokemon, index) => ({
        pokemon,
        slot: index + 1,
      }))
      .filter(
        ({ pokemon }) =>
          !pokemon.active &&
          !pokemon.condition.endsWith("fnt")
      );

    if (switchablePokemon.length === 0) {
      return null;
    }

    const selected = randomItem(switchablePokemon);

    return `switch ${selected.slot}`;
  }

  // -------------------------
  // 技をランダム選択
  // -------------------------

  const active = request.active?.[0];

  if (active) {
    const usableMoves = active.moves
      .map((move, index) => ({
        move,
        slot: index + 1,
      }))
      .filter(
        ({ move }) =>
          !move.disabled &&
          move.pp > 0
      );

    if (usableMoves.length > 0) {
      const selected = randomItem(usableMoves);

      return `move ${selected.slot}`;
    }
  }

  return null;
}

// -------------------------
// Showdownからの要求を処理
// -------------------------

(async () => {
  for await (const output of stream) {
    if (output.startsWith("end\n")) {
      console.log("\n=== 対戦終了 ===");
      console.log(output);
      return;
    }

    if (!output.startsWith("sideupdate\n")) {
      continue;
    }

    const lines = output.split("\n");

    const player = lines[1];

    const requestLine = lines.find((line) =>
      line.startsWith("|request|")
    );

    if (!requestLine) {
      continue;
    }

    const request = JSON.parse(
      requestLine.slice("|request|".length)
    );

    const action = chooseAction(request);

    if (!action) {
      continue;
    }

    console.log(`${player}: ${action}`);

    stream.write(`>${player} ${action}`);
  }
})();

// -------------------------
// Champions M-C開始
// -------------------------

stream.write(
  `>start ${JSON.stringify({
    formatid: FORMAT,
  })}`
);

stream.write(
  `>player p1 ${JSON.stringify({
    name: "AI-1",
    team: packedTeam1,
  })}`
);

stream.write(
  `>player p2 ${JSON.stringify({
    name: "AI-2",
    team: packedTeam2,
  })}`
);