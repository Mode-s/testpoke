# 積み対設置の敗北分岐の確認

保存対戦の全公開ログを再現一致させ、6ターン目の公開記録と自分のrequestから判断を再計算した。実際の相手技や分岐後の結果は予測へ渡していない。判断前後の実戦状態も完全一致。

判断: switch 3。以下は勝率ではなく2ターン後の盤面評価。

| 初手 | 予測値 |
| --- | --- |
| protect | 108.18 |
| surf | 78.47 |
| shellsmash | 71.14 |
| Gyarados | 204.84 |
| icebeam | 72.81 |
| Scizor | 165.75 |

| 構成 | サンプル | 初手の相手応答と重み |
| --- | --- | --- |
| sludgewave, shadowball, nastyplot, energyball | 0 | energyball: 81.9% / nastyplot: 18.1% |
| sludgewave, shadowball, nastyplot, energyball | 1 | energyball: 81.6% / nastyplot: 18.4% |

相手の行動は初手の自分の行動を知る前に選んでいる。候補構成と応答の絞り込みが実際の行動に合うとは限らず、少数サンプルで急所・追加効果を正確に網羅しているわけでもない。この1例に合わせて配点を変更した記録ではない。

実際の当該ターンの公開ログ:

```text
|
|switch|p1a: Scizor|Scizor, L50, M|100/100
|move|p2a: Gengar|Shadow Ball|p1a: Scizor
|-crit|p1a: Scizor
|-damage|p1a: Scizor|23/100
|
|-heal|p1a: Scizor|29/100|[from] item: Leftovers
|upkeep
|turn|7
```
