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
