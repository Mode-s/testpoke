const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isMoveAllowed, moveRestriction } = require('./battle-rules.cjs');

// 対戦は起動せず、AIと同じ技データ・分類を読む。
const source = fs.readFileSync(path.join(__dirname, 'battle-from-json.cjs'), 'utf8');
const context = vm.createContext({ require, process, console: { ...console, log() {} } });
vm.runInContext(source.slice(0, source.indexOf('const stream = new BattleStream();')) + '\nconst stream = { battle: null };', context);
const { moves, battleDex, hasProjectedStateEffect, moveEffectEvaluationKind, hasHandledAdditionalEffect } = vm.runInContext('({ moves, battleDex, hasProjectedStateEffect, moveEffectEvaluationKind, hasHandledAdditionalEffect })', context);

const individualStatus = new Set([
  'rest', 'sleeptalk', 'batonpass', 'substitute', 'yawn', 'tailwind', 'leechseed', 'taunt', 'encore', 'disable',
  'trick', 'switcheroo', 'roar', 'whirlwind', 'destinybond', 'haze', 'perishsong', 'stickyweb', 'helpinghand',
  'attract', 'curse', 'painsplit', 'strengthsap', 'courtchange', 'stealthrock', 'spikes', 'toxicspikes',
  'reflect', 'lightscreen', 'auroraveil', 'trickroom',
  'sunnyday', 'raindance', 'sandstorm', 'snowscape', 'hail',
  'electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain',
  'synthesis', 'morningsun', 'moonlight', 'shoreup',
]);
const secondaryStatuses = new Set(['brn', 'par', 'tox', 'psn', 'frz']);
const secondaryVolatiles = new Set(['confusion', 'attract', 'saltcure', 'curse', 'throatchop', 'yawn', 'healblock', 'partiallytrapped', 'leechseed', 'flinch', 'syrupbomb', 'sparklingaria']);
const handledCallbacks = new Set(['knockoff', 'rapidspin', 'mortalspin', 'clearsmog', 'spectralthief', 'burnup', 'doubleshock']);
const records = moves.map((entry) => {
  const move = battleDex.moves.get(entry.showdownId);
  const projected = hasProjectedStateEffect(move);
  const gaps = [];
  let evaluation;
  if (move.category === 'Status') {
    evaluation = moveEffectEvaluationKind(move) || (move.heal || move.stallingMove || move.status || individualStatus.has(move.id) ? '個別ルール' : '未対応（0点、理由を表示）');
    if (evaluation.startsWith('未対応')) gaps.push('変化技の効果');
  } else {
    evaluation = moveEffectEvaluationKind(move) || (hasHandledAdditionalEffect(move) ? '主ダメージ＋公開履歴・行動順に応じた追加効果' : '主ダメージ＋対応済み追加効果');
    const effects = move.secondaries || (move.secondary ? [move.secondary] : []);
    for (const effect of effects) {
      if (effect.status && !secondaryStatuses.has(effect.status)) gaps.push(`追加状態:${effect.status}`);
      if (effect.volatileStatus && !secondaryVolatiles.has(effect.volatileStatus)) gaps.push(`追加一時効果:${effect.volatileStatus}`);
      if (effect.self?.volatileStatus) gaps.push(`自分の追加一時効果:${effect.self.volatileStatus}`);
      if (effect.onHit && hasHandledAdditionalEffect(move)) continue;
      else if (effect.onHit && !['triattack', 'direclaw', 'throatchop', 'spiritshackle'].includes(move.id)) gaps.push('追加効果のコールバック（要個別確認）');
    }
    if (!projected && !handledCallbacks.has(move.id) && !hasHandledAdditionalEffect(move) && (move.onHit || move.onAfterHit || move.onAfterMoveSecondarySelf)) gaps.push('主ダメージ以外のコールバック（要個別確認）');
  }
  return { name: entry.name, id: move.id, category: move.category, allowed: isMoveAllowed(move), restriction: moveRestriction(move), evaluation, gaps: [...new Set(gaps)] };
});

const status = records.filter((entry) => entry.category === 'Status');
const restricted = records.filter((entry) => !entry.allowed);
const availableStatus = status.filter((entry) => entry.allowed);
const statusGaps = status.filter((entry) => entry.gaps.length);
const attackGaps = records.filter((entry) => entry.category !== 'Status' && entry.gaps.length);
const report = [
  '# チャンピオンズの技効果評価の棚卸し', '',
  'この一覧は同梱マスターデータとAIの分岐を照合したもの。対応分類は全条件・全組合せの保証ではなく、個別ルールには近似評価も含む。コールバックはダメージ計算そのものに含まれる場合もあるため、要確認として保守的に列挙する。', '',
  `対象${records.length}技。シングルの利用制限で対象外${restricted.length}技。利用可能な変化技${availableStatus.length}技のうち、評価経路あり${availableStatus.length - statusGaps.length}技、未対応${statusGaps.length}技。攻撃技の追加確認対象${attackGaps.length}技。`, '',
  '## シングルでは登録・選択できない技', '',
  '| 技 | ID | 制限理由 |', '| --- | --- | --- |',
  ...restricted.map((entry) => `| ${entry.name} | ${entry.id} | ${entry.restriction} |`), '',
  '## 評価未対応の変化技', '',
  '| 技 | ID | 現在の扱い |', '| --- | --- | --- |',
  ...(statusGaps.length ? statusGaps.map((entry) => `| ${entry.name} | ${entry.id} | ${entry.evaluation} |`) : ['| なし | — | 今回の一覧に未対応の変化技なし |']), '',
  '## 攻撃の追加確認対象', '',
  '| 技 | ID | 未評価または確認が必要な効果 |', '| --- | --- | --- |',
  ...(attackGaps.length ? attackGaps.map((entry) => `| ${entry.name} | ${entry.id} | ${entry.gaps.join('、')} |`) : ['| なし | — | 今回の追加確認対象をすべて対応 |']), '',
  '## 全技の評価経路', '',
  '| 技 | ID | 評価経路 |', '| --- | --- | --- |',
  ...records.map((entry) => `| ${entry.name} | ${entry.id} | ${entry.evaluation} |`), '',
].join('\n');
fs.writeFileSync('battle-effect-coverage.md', report);
fs.writeFileSync('battle-effect-coverage.json', JSON.stringify(records, null, 2) + '\n');
console.log(`対象${records.length}技、未対応の変化技${statusGaps.length}技、攻撃の追加確認対象${attackGaps.length}技`);
