// 対戦形式ごとの利用制限。技マスター・エンジンの定義は削除しない。
// doubles の技制限は定義済みだが、複数対象・味方・同時行動を扱うAIは未実装。
const BATTLE_MODES = Object.freeze({
  singles: Object.freeze({ gameType: 'singles', format: 'gen9championsbssregmc', activeSlots: 1, implemented: true }),
  doubles: Object.freeze({ gameType: 'doubles', format: null, activeSlots: 2, implemented: false }),
});
const ACTIVE_BATTLE_RULES = BATTLE_MODES.singles;

// 味方専用の target は下で一括判定。self / normal 対象でもシングルで失敗する技。
const SINGLES_UNAVAILABLE_IDS = new Set(['followme', 'ragepowder', 'afteryou', 'quash', 'allyswitch']);
const toId = (value) => String(value?.id || value?.showdownId || value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function battleMode(gameType) {
  const rules = BATTLE_MODES[gameType];
  if (!rules) throw new Error(`未定義の対戦形式: ${gameType}`);
  return rules;
}

function moveRestriction(move, rules = ACTIVE_BATTLE_RULES) {
  battleMode(rules.gameType);
  if (rules.gameType === 'singles' && (move.target === 'adjacentAlly' || SINGLES_UNAVAILABLE_IDS.has(toId(move)))) {
    return 'シングルでは使えないダブル向けの技';
  }
  return null;
}

function isMoveAllowed(move, rules = ACTIVE_BATTLE_RULES) {
  return !moveRestriction(move, rules);
}

function assertMoveAllowed(move, owner = '', rules = ACTIVE_BATTLE_RULES) {
  const reason = moveRestriction(move, rules);
  if (reason) throw new Error(`${owner ? `${owner}: ` : ''}${move.name || toId(move)} は${reason}です。別の技を設定してください。`);
}

function assertBattleModeSupported(rules = ACTIVE_BATTLE_RULES) {
  if (!battleMode(rules.gameType).implemented || !rules.format) {
    throw new Error(`${rules.gameType} の対戦処理は未実装です。現在はシングルのみ対応しています。`);
  }
}

function createBattleTeamValidator(TeamValidator, Dex, rules = ACTIVE_BATTLE_RULES) {
  assertBattleModeSupported(rules);
  const dex = Dex.forFormat(rules.format);
  if (dex.formats.get(rules.format).gameType !== rules.gameType) throw new Error('対戦形式とルール設定が一致しません。');
  const validator = new TeamValidator(rules.format);
  const validateEngineTeam = validator.validateTeam.bind(validator);
  validator.validateTeam = (team, ...args) => {
    // エンジンの形式上の合法性とは別に、プロジェクトの利用制限を適用する。
    const restricted = team.flatMap((member) => (member.moves || []).flatMap((id) => {
      const move = dex.moves.get(id);
      const reason = moveRestriction(move, rules);
      return reason ? [`${member.name || member.species}: ${move.name} は${reason}です。`] : [];
    }));
    const errors = [...restricted, ...(validateEngineTeam(team, ...args) || [])];
    return errors.length ? errors : null;
  };
  return validator;
}

function assertRequestSupported(request, rules = ACTIVE_BATTLE_RULES) {
  assertBattleModeSupported(rules);
  if ((request.active?.length || 0) > rules.activeSlots || (request.forceSwitch?.length || 0) > rules.activeSlots ||
      (request.side?.pokemon?.filter((mon) => mon.active).length || 0) > rules.activeSlots) {
    throw new Error('複数のポケモンが同時に場に出る対戦は未対応です。現在はシングルのみ対応しています。');
  }
}

module.exports = { BATTLE_MODES, ACTIVE_BATTLE_RULES, moveRestriction, isMoveAllowed, assertMoveAllowed,
  assertBattleModeSupported, createBattleTeamValidator, assertRequestSupported };
