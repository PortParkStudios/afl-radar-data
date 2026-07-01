# afl-radar-data

Data file for the **AFL Radar** app — `players.json` (per-game statistical
averages + recent game logs, keyed by player and season).

- **Source:** derived from publicly available AFL statistics via the
  [fitzRoy](https://github.com/jimmyday12/fitzRoy) project (official AFL feed).
- **Purpose:** personal, non-commercial use by the AFL Radar app.
- Regenerated automatically; not affiliated with or endorsed by the AFL or
  Champion Data. Aggregated/derived data, not a raw feed.

`players.json` shape: `{ "season": <number>, "players": [ ...Player ] }`
