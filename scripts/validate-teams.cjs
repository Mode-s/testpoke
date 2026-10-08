const fs = require("node:fs");

const {
  Dex,
  TeamValidator,
} = require("../vendor/pokemon-showdown/dist/sim");

Dex.includeFormats();

const FORMAT = "gen9championsbssregmc";

function loadMaster(path) {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));

  if (Array.isArray(data)) {
    return data;
  }

  const array = Object.values(data).find(
    (value) =>
      Array.isArray(value) &&
      value.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "name" in entry &&
          "showdownId" in entry
      )
  );

  if (!array) {
    throw new Error(`マスターデータが見つかりません: ${path}`);
  }

  return array;
}

function loadTeam(path) {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));

  if (Array.isArray(data)) {
    return data;
  }

  throw new Error(`チームデータが配列ではありません: ${path}`);
}

const roster = loadMaster("./data/champions-roster.json");
const moves = loadMaster("./data/champions-moves.json");
const items = loadMaster("./data/champions-items.json");
const abilities = loadMaster("./data/champions-abilities.json");
const natures = loadMaster("./data/champions-natures.json");

function findByName(data, name, type) {
  const found = data.find((entry) => entry.name === name);

  if (!found) {
    throw new Error(`${type}が見つかりません: ${name}`);
  }

  return found;
}

function convertTeam(path) {
  const team = loadTeam(path);

  return team.map((member) => {
    const pokemon = findByName(
      roster,
      member.pokemon,
      "ポケモン"
    );

    const ability = findByName(
      abilities,
      member.ability,
      "とくせい"
    );

    const nature = findByName(
      natures,
      member.nature,
      "せいかく"
    );

    const item = member.item
      ? findByName(items, member.item, "もちもの")
      : null;

    const showdownMoves = member.moves.map((moveName) => {
      const move = findByName(
        moves,
        moveName,
        "わざ"
      );

      return move.showdownId;
    });

    return {
      species: pokemon.showdownId,
      ability: ability.showdownId,
      item: item?.showdownId ?? "",
      nature: nature.showdownId,
      moves: showdownMoves,
      level: 100,
    };
  });
}

const teamA = convertTeam("./teams/team-a.json");
const teamB = convertTeam("./teams/team-b.json");

const validator = new TeamValidator(FORMAT);

const problemsA = validator.validateTeam(teamA);
const problemsB = validator.validateTeam(teamB);

console.log("=== Team A ===");
console.dir(teamA, { depth: null });

console.log("\n=== Team B ===");
console.dir(teamB, { depth: null });

console.log("\n=== Champions M-C チェック ===");

console.log(
  "Team A:",
  problemsA ?? "OK"
);

console.log(
  "Team B:",
  problemsB ?? "OK"
);