# Grid Talent Catalog

`electron/grid-talents.cjs` is a deterministic, data-driven talent system for the 64x64 strategy grid. It has no runtime model or asynchronous dependency. A general carries at most one talent instance; a talent definition can contribute one or more finite, conditional additive modifiers.

## API

```js
const {
  TALENT_CATALOG, RARITIES, MATERIALS,
  rollTalent, normalizeTalent, describeTalent,
  talentModifiers, upgradeTalent
} = require("./electron/grid-talents.cjs");
```

`rollTalent(seed, instanceId)` hashes both inputs with SHA-256. The object form, `rollTalent({ seed, id, talentId?, rarity? })`, is useful for fixtures. Results are canonical and JSON-safe:

```js
{
  schema: "fyow.grid-talent/1",
  instanceId: "general-42",
  talentId: "forest-pathfinder",
  rarity: "blue",
  progress: 336,
  potency: 0.028014,
  potencyPercent: 2.80,
  version: 1
}
```

`normalizeTalent(talent, seedOrId, id)` repairs legacy or partial values, derives rarity from progress, and keeps an existing valid `talentId`. `describeTalent` returns deterministic Chinese copy with percentage values rounded to two decimal places.

## Rarity and materials

Rarity is ordered white, green, blue, purple, gold, red. Initial rolls use weighted tickets (560/250/110/50/25/5), so white is the common result and red is rare. Potency is interpolated inside a finite progress band: white `0.20-0.60%`, green `0.80-1.50%`, blue `1.80-3.00%`, purple `3.50-5.50%`, gold `6.50-9.00%`, red `11.00-16.00%`.

Materials:

| ID | Function |
| --- | --- |
| `white`, `green`, `blue`, `purple`, `gold` | Base progress is 8/20/42/78/135. Actual integer progress is a deterministic 90-110% roll keyed by seed, talent instance, material, and nonce; crossing a threshold promotes rarity. |
| `red-ascend` | Immediately moves the instance into the red band with a deterministic roll. |
| `red-reroll` | Deterministically selects a different talent definition; its rarity is rolled normally and is not guaranteed red. |

Normal-material fluctuation changes only talent progress. It never changes cultivation power, gold cost, or timing. `upgradeTalent` returns `rolledProgressDelta`, the cap-adjusted `progressDelta`, and `randomFactor`, so callers can display the authoritative result without reproducing the roll.

## Evaluation contract

```js
talentModifiers(state, {
  action: "march" | "combat" | "mining" | "training" | "cultivation" | "discovery",
  actorAccountId,
  position: { x, y },
  cell: { ownerAccountId, terrain, resourceGrade, resourceRank, population },
  attacking, armySize, neutral, hour,
  talent, // one source, or talents: [{ talent, status, location, holderAccountId, generalId }]
});
```

The return value has one numeric field per modifier plus `applied` and `evaluatedTalents`. Modifiers are additive fractions, not multiplicative chains. Global finite caps prevent excessive stacking: duration/cost reductions stop at `-45%`; combat, yield and power bonuses stop at `+60%`; discovery chance is bounded to `-3` to `+12` percentage points.

Apply one summed modifier only once at the game boundary. The live march rule is 30 seconds per cell: `durationMs = Math.round(distance * 30_000 * (1 + modifiers.marchDuration))`. Cost and yield channels use the same `base * (1 + modifier)` convention; discovery adds `discoveryChance` directly to the base probability and then clamps to the game's probability bounds.

Scopes are `carried`, `own-tile`, `neighbor-allied`, `neighbor-hostile`, and `enemy-neighbor`. The allied/hostile neighbor scopes are benefits projected by the acting player's deployed general into one of its eight adjacent cells. `enemy-neighbor` is an explicit debuff: its source must be a different account's deployed general exactly one Chebyshev step from the affected cell. Own scopes always require the talent holder to match the acting account, so an enemy benefit cannot leak into the current player's modifiers. Conditions are finite predicates over terrain, resource rank, population, neutral status, attack posture, army size, and UTC hour. An hour range may wrap midnight (`20` to `5`).

When a state object has `generals`, each general with `general.talent` is considered. For explicit fixtures, pass `talent` or `talents` to avoid coupling to the wider game state. The evaluator never calls an AI service and ignores unknown actions or predicates.

## Catalog index

The catalog contains 108 definitions. Semantic uniqueness is checked when the module loads by comparing complete effect signatures (modifier channel, scope, action, scale, and predicates).

### Marching (18)

`swift-column` 疾行纵队; `lean-baggage` 轻装辎重; `forest-pathfinder` 林径先导; `mountain-guide` 山道识途; `river-quartermaster` 临水转运; `night-march` 衔枚夜行; `day-supply` 昼行给养; `vanguard-step` 先锋急进; `peaceful-transit` 安境通行; `small-unit-drill` 小队操典; `grand-logistics` 大军转饷; `home-road` 本境驰道; `relay-post` 邻境驿传; `border-forage` 边地就粮; `neutral-survey` 无主地勘路; `rich-road-toll` 富地折券; `populous-staging` 众邑接力; `waste-route` 荒径省驮.

### Combat (24)

`battle-instinct` 临阵机断; `spearhead` 破阵锋芒; `rearguard` 殿军持重; `forest-ambush` 林间伏击; `mountain-wall` 依山成垒; `river-crossing` 济水争先; `plain-formation` 平野布阵; `night-raid` 夜袭营垒; `dawn-watch` 破晓严阵; `few-against-many` 寡兵坚志; `mass-formation` 万众一阵; `neutral-pacifier` 拓土安民; `city-defender` 大邑固守; `hamlet-shield` 小邑相援; `rich-land-contest` 膏腴必争; `poor-land-tenacity` 瘠土韧守; `allied-screen` 邻军掩护; `border-pressure` 临境威压; `garrison-command` 镇地军令; `mobile-reserve` 随军预备; `shock-and-hold` 先登后据; `border-fortifier` 边垒经营; `noon-command` 日中号令; `deep-raid` 深入疾战.

### Mining (18)

`ore-sense` 辨脉识矿; `shift-bells` 轮班鸣钟; `mountain-prospect` 山脉勘采; `river-washing` 河床淘洗; `forest-charcoal` 林地炭作; `rich-vein-care` 富脉精炼; `poor-vein-tools` 贫脉巧具; `dense-workforce` 众工协采; `sparse-prospectors` 荒邑探砂; `night-shaft` 夜井灯队; `day-assay` 日照验矿; `neighbor-tools` 邻地借械; `regional-smelter` 邻郡共炉; `frontier-salvage` 边境采遗; `neutral-claim-survey` 无主矿籍; `carried-assayer` 随行矿师; `low-grade-sorting` 杂矿分选; `high-grade-caution` 精矿稳采.

### Troop training (18)

`drillmaster` 操练严整; `frugal-barracks` 营务节用; `recruiting-office` 募兵成册; `city-muster` 大邑点兵; `village-militia` 乡勇简训; `rich-armory` 富地军械; `poor-kit-reuse` 旧甲再用; `plain-drill` 原野列阵; `mountain-recruits` 山民入伍; `forest-rangers` 林地乡射; `night-drill` 夜操轮训; `morning-rations` 晨炊定额; `allied-instructors` 邻军教习; `joint-recruitment` 邻邑合募; `border-volunteers` 边民应募; `threatened-economy` 临敌省饷; `field-instructor` 随军教头; `balanced-barracks` 营制均衡.

### Cultivation (15)

`focused-cultivation` 凝神修习; `simple-retreat` 简居省资; `mountain-retreat` 山中闭关; `forest-meditation` 林间澄心; `river-breathing` 临流调息; `academy-city` 大邑讲武; `quiet-hamlet` 小邑静修; `rich-elixirs` 丰地药资; `scarce-discipline` 困境砺志; `midnight-study` 子夜参悟; `dawn-practice` 晨起行功; `neighbor-lecture` 邻郡论武; `shared-dojo` 同盟道场; `frontier-tempering` 临敌磨砺; `measured-progress` 循序精进.

### General discovery (15)

`keen-eye` 慧眼识才; `local-reputation` 乡里声望; `allied-recommendation` 邻邦荐贤; `frontier-defector` 边境归心; `city-talent-pool` 大邑群贤; `hidden-hermit` 荒邑访隐; `rich-patronage` 丰资礼贤; `poor-land-scout` 瘠地求士; `mountain-hermit` 入山访士; `forest-ranger-search` 林中寻杰; `river-travellers` 津渡问贤; `night-visitor` 夜访名士; `morning-market` 早市访才; `neutral-pioneers` 拓荒招贤; `wartime-recruiter` 军中拔擢.
