# AFL data pipeline (fitzRoy → app)

Turns real AFL player stats into the app's `Player` shape. Two steps: **fetch**
(R, occasional) → **transform** (Node) → the app imports the result.

```
fetch_afl.R   ──►  afl_raw.csv  ──►  build-players.mjs  ──►  src/data/seed/players.ts
 (R + fitzRoy)     (per-match rows)     (Node, no deps)        (per-game averages)

fetch_afltables.R ──► afltables_season.csv ──┘  (optional pre-2012 backfill)
 (R + fitzRoy)         (per player-season)      merged onto matching persons
```

Source is the **official AFL / Champion Data** feed (via fitzRoy `source="AFL"`).
Richer than the fryzigg cache: real **positions** (→ accurate roles), real
**jumper numbers**, and it covers the **current, in-progress season**.

## One-time setup

Install R (https://cran.r-project.org), then in an R console:

```r
install.packages(c("fitzRoy", "readr", "dplyr"))
```

> Windows note: if `install.packages` fails with an SSL error / can't find
> binaries for a brand-new R version, install from Posit's package manager:
> `options(repos=c(CRAN='https://packagemanager.posit.co/cran/latest'), pkgType='binary')`
> then re-run the install.

## Refresh the data

```bash
# 1) Pull official AFL stats (positions, jumper numbers, current season)
npm run data:fetch            # default 2020 → current year
#   or a custom range:
Rscript scripts/afl/fetch_afl.R 2015 2026

# 2) Aggregate to per-game averages and write players.ts
npm run data:build            # ALL seasons in the file, ≥8 games
#   or restrict to one season:
node scripts/afl/build-players.mjs --season 2026 --min-games 6
```

Re-run both steps after each round to refresh the current season.

### Optional: backfill pre-2012 seasons (AFL Tables)

The Champion Data feed only reaches back to 2012, so long careers show a
truncated games/goals tally (e.g. Pendlebury, debut 2006). AFL Tables has the
historical box scores — but only **basic** stats (kicks, handballs, disposals,
marks, tackles from 1987, goals, behinds, hit-outs), not the advanced radar
metrics. Backfill them:

```bash
Rscript scripts/afl/fetch_afltables.R      # 1990 → 2011 → afltables_season.csv
npm run data:build                         # picks the CSV up automatically
```

`build-players.mjs` merges each pre-2012 player-season onto the person already
in the dataset (matched by **name**, or **name + DOB** when both sides have it),
but **only** for seasons that predate their Champion Data coverage. These rows
are flagged `historical: true`, so the app counts them in the **seasons table**
and **career totals** but keeps them out of **every radar/percentile pool** and
the radar season stepper. Players who never played in the CD era (retired before
2012) and unresolvable same-name duplicates are skipped (the build logs counts).
Delete `afltables_season.csv` to drop the backfill on the next build.

That's it — `src/data/seed/players.ts` is regenerated in place, so the app picks
it up with **no code changes** (the repository/UI already import from there).

**Multi-season:** by default `data:build` emits **every season** found in the CSV
(one row per player per season, all sharing a `personId`), so the app's season
selector, radar overlay, and career view use real history. Fetch a range, build
without `--season`, and you get all of it. Use `--season YYYY` only if you want
just one.

## Advanced stats + official AFL Player Rating

The AFL/Champion Data feed (`source="AFL"`) exposes the full advanced stat set
**and** CD's official **AFL Player Rating** (`ratingPoints`), fully populated back
to 2012 — the same live feed already used for the basics. `fetch_afl.R` keeps
these columns and `build-players.mjs` maps them into each player's season `stats`
/`totals` and per-game `gameLog` (with `pos`, the on-field position):

`ratingPoints`, `contestedMarks`, `interceptMarks`, `spoils`, `onePercenters`,
`contestDefOneOnOnes`, `defHalfPressureActs`, `pressureActs`, `tacklesInside50`,
`scoreLaunches`, `marksOnLead`, `hitoutsToAdvantage`, `ruckContests`,
`effectiveDisposals`, `centreClearances`, `stoppageClearances`, `goalAssists`,
`clangers`, `turnovers`, `timeOnGroundPercentage` (a %, so averaged not totalled).

Live path = AFL API (current season, refreshed by `refresh-data.yml` /
`refresh-live.yml`). Historical seasons pick the fields up on a **merge**-rebuild
(`--merge`), which enriches 2012+ while preserving the pre-2012 `historical` rows.
Fryzigg (`fetch_player_stats_fryzigg`) has the same fields historically but is a
fallback only — it has **no** current-season data and needs name-matching, whereas
the AFL API shares our `personId`.

## Coaches votes (AFLCA)

`fetch_coaches_votes.R` pulls AFLCA player-of-the-year votes
(`fetch_coaches_votes(season, comp="AFLM")`), sums them to a per-player **season
total**, and writes `scripts/afl/honours_coaches.csv` (`season,player,votes`).
`build-honours.mjs` folds that into `honours.json`'s `coaches` field (the app
already renders it). Votes accumulate weekly, so unlike the once-a-year
Brownlow/AA/Rising CSVs this one refreshes on the **daily** `refresh-data.yml`
cadence — a current-season run merges (keeps the backfilled history):

```bash
Rscript scripts/afl/fetch_coaches_votes.R            # 2013 → current (full backfill)
Rscript scripts/afl/fetch_coaches_votes.R 2026 2026  # current season only (merge)
node scripts/afl/build-honours.mjs --players players.json
```

## Deep per-game history export (`gamelogs.csv`)

`players.json` keeps per-game `gameLog` for only the **2 most recent seasons** (to
stay app-loadable). For a full training / analysis dataset, `build-gamelogs.mjs`
emits **one row per player per match for every season (2012→now)** to
`gamelogs.csv` — ~135k rows, all 57 stat keys (same names as `players.json`), plus
match context (`matchId`, `team`, `opponent`, `homeAway`, `venue`, `round`,
`utcStartTime`, `pos`). Reuses `afl_raw.csv` from the fetch step — no extra API
calls.

```bash
Rscript scripts/afl/fetch_afl.R                 # 2012 → current (whole history)
node scripts/afl/build-gamelogs.mjs             # -> gamelogs.csv (all seasons)
node scripts/afl/build-gamelogs.mjs --merge     # current-season only, keep history
```

The daily `refresh-data.yml` runs the `--merge` form (afl_raw.csv holds just the
current season), so `gamelogs.csv` stays current without dropping the backfill.
`matchId` + the carried metadata mean a normalised `matches` table can be split
off later without a re-pull.

## Options (`build-players.mjs`)

| Flag | Default | Meaning |
|------|---------|---------|
| `--in` | `scripts/afl/fryzigg_raw.csv` | Input CSV from the R step |
| `--out` | `src/data/seed/players.ts` | Output TS module |
| `--season` | *all seasons in file* | Restrict to one season |
| `--min-games` | `8` | Skip players below this game count (per season) |

## Roles

fryzigg has no position field, so `build-players.mjs` **infers** a role from each
player's averaged profile (ruck via hit-outs, key fwd via goals + marks inside 50,
etc.). To override, create `scripts/afl/roles.json`:

```json
{ "CD_I1000942": "REBOUND_DEFENDER", "CD_I998532": "WING" }
```

Keys are fryzigg `player_id`s (see the CSV); values are any `PlayerRole`.

## If a metric shows as missing

The transform prints a warning listing any radar metric with no matching CSV
column (fryzigg occasionally renames columns between updates). Open
`build-players.mjs`, add the new column name to `METRIC_SOURCES[<metric>]`, and
re-run `npm run data:build`.

## Sources & licensing

- **fryzigg** (via fitzRoy) — Champion Data-grade, ~2010→present. Best for radars.
- **AFL Tables** — deep history (1897+); use `fetch_player_stats(source="afltables")`
  if you want pre-2010 seasons (fewer advanced metrics before 1998).
- Champion Data owns the commercial rights to official AFL stats — fine for a
  personal project; get a licence before shipping commercially. Cache locally;
  don't hammer source sites.
