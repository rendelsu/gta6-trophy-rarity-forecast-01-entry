# gta6-trophy-rarity-forecast-01-entry

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/rendelsu/gta6-trophy-rarity-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/rendelsu/gta6-trophy-rarity-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every GTA VI PS5 trophy's Exophase earn rate at 2026-11-26T00:00Z as five quantiles (5/25/50/75/95%), scored by mean pinball loss on the logit scale.

Round 3 replaces round 2's symmetric band with the Bayes posterior-predictive quantile: seven candidate truths for how a refresh's new earners split across trophies (uniform-f plus six concentrated shapes that reproduce the house baseline's stated practice numbers), and each level's quantile is the exact pinball minimiser for that discrete posterior. On the same calibrated proxy as round 2 this scores E[loss] 0.0657 against round 2's 0.0843. When the case history has several distinct reads (the final case), each trophy is forecast by a least-squares fit of ln(earners) on ln(1+hours) and ln(players), extrapolated to the target and shrunk toward the last observed rate.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Plain JavaScript in `main.ts` (Node 22, standard library only, no network). Reads every `*.in` case in the input directory and writes one `*.out` forecast per case: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}]}`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rkkz4bh8&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
