#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Backfill BASIC pre-2012 player stats from AFL Tables (via fitzRoy).
#
# The official AFL / Champion Data feed (fetch_afl.R) only goes back to 2012,
# so a long career (e.g. Pendlebury, debut 2006) shows a truncated games/goals
# tally. AFL Tables has the historical box scores — but only the BASIC columns:
# kicks, handballs, disposals, marks, tackles (1987+), goals, behinds, hit-outs.
# The advanced metrics the radars need (contested poss, clearances, metres
# gained, score involvements, intercepts, ground-ball gets) DO NOT exist here,
# which is exactly why these rows are flagged `historical` and kept off radars.
#
# One-time setup (in R):
#   install.packages(c("fitzRoy", "readr", "dplyr"))
#
# Run:
#   Rscript scripts/afl/fetch_afltables.R            # 1990 -> 2011
#   Rscript scripts/afl/fetch_afltables.R 1985 2011  # custom range
#
# Writes scripts/afl/afltables_season.csv (one row per player-season). The Node
# build (build-players.mjs) merges these onto existing persons by name (+ DOB
# when available), only for seasons that predate their Champion Data coverage.
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
from <- if (length(args) >= 1) as.integer(args[1]) else 1990
to   <- if (length(args) >= 2) as.integer(args[2]) else 2011

message(sprintf("Fetching AFL Tables player stats %d-%d ...", from, to))

all <- list()
for (yr in from:to) {
  d <- tryCatch(
    fetch_player_stats_afltables(season = yr),
    error = function(e) {
      message(sprintf("  %d: error - %s", yr, conditionMessage(e)))
      NULL
    }
  )
  if (is.null(d) || nrow(d) == 0) {
    message(sprintf("  %d: no data", yr))
    next
  }
  message(sprintf("  %d: %d match rows", yr, nrow(d)))
  all[[as.character(yr)]] <- d
}
if (length(all) == 0) {
  message("No data for the requested season(s) — nothing written.")
  quit(status = 0)
}
raw <- bind_rows(all)

# Safe column accessor — AFL Tables naming, tolerant of a missing column.
col <- function(df, name) if (name %in% names(df)) df[[name]] else NA

tidy <- tibble(
  id        = as.character(col(raw, "ID")),
  firstName = col(raw, "First.name"),
  surname   = col(raw, "Surname"),
  season    = as.integer(col(raw, "Season")),
  team      = col(raw, "Playing.for"),
  kicks     = suppressWarnings(as.numeric(col(raw, "Kicks"))),
  handballs = suppressWarnings(as.numeric(col(raw, "Handballs"))),
  disposals = suppressWarnings(as.numeric(col(raw, "Disposals"))),
  marks     = suppressWarnings(as.numeric(col(raw, "Marks"))),
  tackles   = suppressWarnings(as.numeric(col(raw, "Tackles"))),
  goals     = suppressWarnings(as.numeric(col(raw, "Goals"))),
  behinds   = suppressWarnings(as.numeric(col(raw, "Behinds"))),
  hitouts   = suppressWarnings(as.numeric(col(raw, "Hit.Outs")))
)

# Disposals may be blank in older data — derive from kicks + handballs.
tidy$disposals <- ifelse(
  is.na(tidy$disposals), tidy$kicks + tidy$handballs, tidy$disposals
)

# Per player-season: games played + per-game averages (modal team for the year).
modal <- function(x) {
  x <- x[!is.na(x) & x != ""]
  if (!length(x)) return(NA_character_)
  names(sort(table(x), decreasing = TRUE))[1]
}
mean1 <- function(x) {
  x <- x[!is.na(x)]
  if (!length(x)) return(NA_real_)
  round(mean(x), 1)
}
# Exact whole-season total (summing per-match values). Paired with mean1 so the
# build can store true totals AND per-game averages.
sum0 <- function(x) {
  x <- x[!is.na(x)]
  if (!length(x)) return(NA_real_)
  round(sum(x))
}

# Aggregate per player-season. IMPORTANT: compute averages and totals in two
# separate passes, each reading the ORIGINAL per-match columns, then join. Doing
# both in one summarise() and reusing a column name (e.g. `disposals = mean(...)`
# then `sum(disposals)`) makes the second expression sum the already-averaged
# scalar — silently turning every total into round(average). The join keeps each
# aggregate reading the raw data, so order/shadowing can't corrupt it.
STAT_KEYS <- c("disposals", "kicks", "handballs", "marks", "tackles", "goals", "behinds", "hitouts")
grp <- tidy %>%
  filter(!is.na(id), !is.na(season)) %>%
  group_by(id, firstName, surname, season)

avgs <- grp %>% summarise(across(all_of(STAT_KEYS), mean1), .groups = "drop")
tots <- grp %>% summarise(
  team = modal(team),
  games = n(),
  across(all_of(STAT_KEYS), sum0, .names = "{.col}_tot"),
  .groups = "drop"
)
agg <- left_join(tots, avgs, by = c("id", "firstName", "surname", "season"))

# Optional DOB for a stronger name+DOB join (best-effort — skipped if the
# details endpoint is unavailable).
agg$dob <- NA_character_
det <- tryCatch(fetch_player_details_afltables(), error = function(e) NULL)
if (!is.null(det) && "ID" %in% names(det)) {
  dobcol <- intersect(c("Date.of.Birth", "DOB", "Born.Date"), names(det))[1]
  if (!is.na(dobcol)) {
    d2 <- det %>%
      transmute(id = as.character(ID), dob = as.character(.data[[dobcol]])) %>%
      distinct(id, .keep_all = TRUE)
    agg <- agg %>% left_join(d2, by = "id", suffix = c("", ".join"))
    agg$dob <- ifelse(is.na(agg$dob) & !is.na(agg$dob.join), agg$dob.join, agg$dob)
    agg$dob.join <- NULL
    message(sprintf("Attached DOB for %d players", sum(!is.na(agg$dob))))
  }
}

out <- "scripts/afl/afltables_season.csv"
write_csv(agg, out)
message(sprintf("Wrote %d player-seasons to %s", nrow(agg), out))
message("Now run: npm run data:build")
