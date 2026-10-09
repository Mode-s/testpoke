# 導入前に防御した17場面の判断比較

前回保存した対戦の同じ公開盤面・自分のrequestから深さ0/1/2で判断する。元の対戦ログの再現一致を確認。実際の相手行動や、前回監査の分岐勝敗は先読みへ渡さない。ここでの予測値は勝率ではない。各場面の採用後の勝敗は、別の同条件対戦比較で確認する。

| 編成・乱数 | ターン | 元の防御 | 深さ0 | 深さ1 | 深さ2 | 深さ2の比較状況 |
| --- | --- | --- | --- | --- | --- | --- |
| bulky / 17,29,41,53 | 9 | banefulbunker | banefulbunker | switch Corviknight | switch Corviknight | 深さ2・complete・336回 |
| bulky / 17,29,41,53 | 10 | banefulbunker | banefulbunker | switch Corviknight | switch Corviknight | 深さ2・complete・336回 |
| bulky / 17,29,41,53 | 11 | banefulbunker | banefulbunker | switch Corviknight | switch Corviknight | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 11 | banefulbunker | banefulbunker | banefulbunker | toxic | 深さ2・complete・280回 |
| bulky / 31,43,59,71 | 14 | banefulbunker | banefulbunker | recover | switch Slowbro | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 16 | banefulbunker | banefulbunker | recover | switch Slowbro | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 18 | banefulbunker | banefulbunker | banefulbunker | switch Slowbro | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 20 | banefulbunker | banefulbunker | banefulbunker | banefulbunker | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 21 | banefulbunker | banefulbunker | banefulbunker | banefulbunker | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 22 | banefulbunker | banefulbunker | banefulbunker | banefulbunker | 深さ2・complete・336回 |
| bulky / 31,43,59,71 | 23 | banefulbunker | banefulbunker | banefulbunker | banefulbunker | 深さ2・complete・336回 |
| setup / 17,29,41,53 | 6 | protect | protect | protect | switch Scizor | 深さ2・complete・168回 |
| setup / 31,43,59,71 | 2 | protect | protect | protect | protect | 深さ2・complete・336回 |
| hazard / 17,29,41,53 | 3 | protect | protect | protect | protect | 深さ2・complete・420回 |
| hazard / 17,29,41,53 | 4 | protect | protect | protect | protect | 深さ2・complete・420回 |
| hazard / 31,43,59,71 | 3 | protect | protect | protect | protect | 深さ2・completed-candidates-only・377回 |
| hazard / 31,43,59,71 | 4 | protect | protect | protect | protect | 深さ2・completed-candidates-only・407回 |
