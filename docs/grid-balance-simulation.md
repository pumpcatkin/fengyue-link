# Grid balance simulation

`scripts/simulate-grid-balance.cjs` is a deterministic 20-player, 30-day measurement pass for the 64x64 world. It is a planning model, not a replacement for server settlement. A seed gives the same cells, rolls, and report every time.

The requested GPT-6 delegation was not available in this session's subagent selector; the calculation and audit used `gpt-5.6-sol` plus the reproducible Node simulation and engine regression tests, not GPT-6.

## Baseline

- 20 players, 30 days, one seeded capital cell each.
- Marching uses Manhattan path length and **30 seconds per cell**. Cost is `distance * (10 + ceil(soldiers / 100))` gold.
- Mining is settled at 100% uptime while the automatic job remains valid, matching the engine. Cycle time remains 60-3,600 seconds. Base hourly income is `(400 + population * 0.09) * (1 + rank * 0.08)` and each cycle pays `max(1, round(hourly income * cycleSeconds / 3600))` gold.
- The first cultivation attempt unlocks **6 real elapsed hours after joining the world**. This is an eligibility gate, not a six-hour action duration and not cumulative online time. Later gates use the same wall-clock basis.
- Troop recruitment uses the engine formulas: `2 * soldiers` gold and `60 + ceil(soldiers / 5)` seconds, capped at one hour.
- General discovery is rolled only after a victorious neutral conquest, at the target cell's 2.00-25.00% population-scaled chance. Battles award no gold.
- Treasure supply is one author-triggered scatter, not a periodic roll. The default is 240 ordinary materials; re-scattering replaces unclaimed positions and red counts default to zero.

Run it with:

```powershell
node scripts/simulate-grid-balance.cjs > output/grid-balance-simulation.json
```

Or consume it from a test/tool:

```js
const { runSimulation } = require("../scripts/simulate-grid-balance.cjs");
const report = runSimulation({ seed: "review-1", players: 20, days: 30 });
```

## Cultivation schedule

The ranges below are design targets mirrored from the engine. A gate is only an eligibility time; it does not guarantee that a player can afford the attempt at that instant.

| Attempt | Real elapsed-time gate | Gold range | Power gain range |
| --- | ---: | ---: | ---: |
| 1 | 6 hours | 5,000-8,000 | 6.00-10.00% |
| 2 | 48 hours | 12,000-18,000 | 9.00-14.00% |
| 3 | 168 hours | 30,000-45,000 | 13.00-20.00% |
| 4 | 360 hours | 70,000-100,000 | 18.00-28.00% |
| 5 | 576 hours (day 24) | 160,000-240,000 | 25.00-40.00% |

Across all five attempts the gold envelope is **277,000-411,000** per player. The exact gold paid is linearly mapped inside that attempt's power-gain range, so gold affects combat power and never talent progress.

Every attempt selects and consumes **exactly one** available material. The player may choose white, green, blue, purple, gold, red-ascend, or red-reroll. Ordinary tiers add 8/20/42/78/135 talent progress. Red-ascend and red-reroll are special operations, not numeric progress grants. Materials do not change combat-power gain, gold cost, or the next time gate. Players start with zero materials.

The author scatter defaults to 240 ordinary materials with weights 30% white, 30% green, 22% blue, 12% purple, and 6% gold. For 20 players this is 12 items per player against five required, or 240.00% aggregate coverage. Supply is sufficient only if the author scatters once and claims are reasonably distributed. The engine has no automatic refresh, per-player reservation, or claim-rate guarantee; a player must arrive on the exact cell first. The simulation's 45.00% success per six-hour targeted-travel window is explicitly a sampling assumption, not an engine rule.

## Implemented engine audit

The default `actual` model mirrors the implemented engine formula, including integer rounding once per cycle. The default seed's full 4,096-cell measurement gives these results before talent modifiers:

- 3,301 cells, **80.59%**, produce enough for 5,000 gold by hour 6 from the 500-gold start.
- Time-to-afford 5,000 gold is 3.24h at p25, 4.09h at median, 5.53h at p75, and 7.23h at p90.
- The fixed 20-player sample is volatile (17/20 can afford at hour 6), which is why the full-map rate is the decision metric.
- At identical population, every higher resource rank has strictly higher realized hourly income even after per-cycle rounding. In the seeded map population mix, D- has about 840 gold/hour at the median and S+ about 1,805 gold/hour.
- Funds can therefore be available near hour 4 for a typical capital, but the first action remains blocked until the hard 6-hour wall-clock gate.
- An eight-cell march takes 240 seconds and costs 88 gold with 100 soldiers or 160 gold with 1,000 soldiers.
- Training 100 soldiers costs 200 gold and takes 80 seconds; training 1,000 costs 2,000 gold and takes 260 seconds before modifiers.
- In the default simulation, 196 victorious neutral conquests produce 16.04 expected general discoveries (0.80/player); the seeded observation is 26 and is reported separately from the expectation.

Operational conclusions:

1. Keep the 5,000-8,000 first band: the implemented formula reaches the intended 80% full-map affordability target while the hard 6-hour gate prevents earlier cultivation.
2. Show affordability and unlock time separately. Gold readiness around hour 4 does not mean the action is unlocked.
3. Keep 240 as a workable 20-player scatter baseline, expose remaining global supply, and warn that re-scatter replaces unclaimed items. Red materials remain unavailable until the author explicitly sets nonzero counts.

### Fixed-sample progression

The implemented formula is:

```text
hourlyGold = (400 + population * 0.09) * (1 + resourceRank * 0.08)
cycleYield = max(1, round(hourlyGold * cycleSeconds / 3600))
```

The 400 base is intentional. Before integer cycle rounding, the initially considered 300 base reached 5,000 gold by hour 6 on 71.70% of map cells, while 400 reached 81.81%. The exact implemented, cycle-rounded result is **80.59%**. The existing 1-60 minute cycle is unchanged, and the underlying rate increases by 8.00% per resource rank at equal population.

Actual-model results for the fixed 20-player sample:

- 17/20 can afford 5,000 gold at hour 6; the full-map rate is 80.59%.
- Six-hour balances are 4,097 minimum, 6,680 median, and 13,868 maximum.
- Time-to-afford is 3.24h at p25, 4.09h median, 5.53h at p75, and 7.23h at p90.
- With one manual 240-item scatter and the documented claim policy, cultivation completion is 20/20 for all five attempts; attempts 3-5 complete at their 168/360/576h gates for all players.
- Only 4/20 complete attempt one exactly at hour 6 despite 17/20 having enough gold, because zero starting materials makes actual treasure collection the other gate. Attempt one averages 15.90h and the latest sample completion is 54h. Attempt two averages 49.50h; attempts 3-5 finish at their gates for all 20 players.
- The deterministic scatter contains 72 white, 73 green, 52 blue, 34 purple, 9 gold, and zero red materials. All 20 capitals are within five Manhattan cells of at least one scattered item, but this is global availability rather than player reservation.

This is the implemented baseline, not a guarantee: territory count, mining uptime, spending, treasure competition, and talent modifiers change actual affordability.

These findings are measurements, not a balance guarantee. The [Kongregate idle-game math reference](https://www.kongregate.com/en/pages/the-math-of-idle-games-part-i) describes the core tension: costs commonly grow exponentially while production grows linearly or polynomially, so the practical control variable is time-to-afford. The five hard gates and gold bands should therefore be evaluated against the measured affordability distribution after every economy change.

### Legacy regression comparison

`runSimulation({ miningModel: "legacy" })` retains the former formula only for comparison. It produced 41.16% six-hour map coverage and a 7.10h median time-to-afford. Its short cycles also inverted the grade reward: D- measured about 3,420 gold/hour at the median versus about 445 for S+. The implemented formula removes that inversion; this legacy option is not the default and does not describe current gameplay.

## Talent potency

Progress thresholds are 0/100/220/360/520/700 with a hard progress cap of 1,000. Potency bands are 0.20-0.60%, 0.80-1.50%, 1.80-3.00%, 3.50-5.50%, 6.50-9.00%, and 11.00-16.00% for white through red. Modifier caps keep accumulated effects bounded: duration/cost channels bottom out at -45%, combat/mining/training/cultivation power channels top out at +60%, and discovery chance tops out at +12 percentage points.

## Availability interpretation

General discovery uses the engine's 2.00-25.00% population-scaled chance per victorious neutral conquest. Treasure availability is reported as global scattered supply, claimed supply, and remaining supply. It is not represented as a daily probability.

All percentages in the report are rounded to two decimals. The simulation advances in six-hour steps, so its cultivation timeline reports earliest, average, and latest completion hours for all 20 players. Because the RNG is seeded, balance changes can be compared by changing one constant or formula and rerunning the same seed.
