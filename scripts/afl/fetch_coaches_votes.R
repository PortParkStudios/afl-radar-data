#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Pull AFLCA (AFL Coaches Association) player-of-the-year votes via fitzRoy and
# write season-total-per-player rows to scripts/afl/honours_coaches.csv, which
# build-honours.mjs folds into honours.json's `coaches` field (the app already
# renders it).
#
#   Rscript scripts/afl/fetch_coaches_votes.R              # 2013 -> current year
#   Rscript scripts/afl/fetch_coaches_votes.R 2026 2026    # just the current season
#
# Coaches votes ACCUMULATE every round and are published live-weekly, so unlike
# the once-a-year Brownlow/AA/Rising CSVs this file is refreshed on the daily
# pipeline (refresh-data.yml). A single-season run MERGES: it refreshes only the
# fetched season(s) and preserves every other season already in the CSV, so the
# daily current-season refresh never wipes the backfilled history.
#
# The feed gives per-round rows: Season, Round, Home.Team, Away.Team,
# Player.Name ("Name (TEAM)"), Coaches.Votes (TEXT). We coerce votes to numeric
# and sum to a per-player season total. Player.Name carries the team abbrev in
# parentheses, which build-honours.mjs uses to disambiguate the match.
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(dplyr)
  library(readr)
})

args <- commandArgs(trailingOnly = TRUE)
from <- if (length(args) >= 1) as.integer(args[1]) else 2013
to   <- if (length(args) >= 2) as.integer(args[2]) else as.integer(format(Sys.Date(), "%Y"))
OUT  <- "scripts/afl/honours_coaches.csv"

message(sprintf("Fetching AFLCA coaches votes %d-%d ...", from, to))

# --- Live-season round cap ---------------------------------------------------
# The AFLCA feed publishes rounds AHEAD of our own games feed, so summing the
# whole season overcounts the live "votes so far this season". Read the round
# we've actually played from our OWN players.json game logs and cap the live
# season there. AFL "Opening Round" (2024+) is round 0 for us but round 1 in the
# feed (a +1 offset, auto-detected from a round-0 game); the Champion Player
# award is home-and-away only, so freeze at the last H&A round once finals begin.
live_season <- NA_integer_
live_cutoff <- Inf
if (file.exists("players.json")) {
  pj <- tryCatch(jsonlite::fromJSON("players.json", simplifyVector = FALSE),
                 error = function(e) NULL)
  ps <- if (!is.null(pj) && !is.null(pj$players)) pj$players else NULL
  if (!is.null(ps)) {
    seasons <- suppressWarnings(vapply(ps,
      function(p) if (is.null(p$season)) NA_integer_ else as.integer(p$season), integer(1)))
    live_season <- suppressWarnings(max(seasons, na.rm = TRUE))
    rmax <- -Inf; rmin <- Inf
    for (p in ps) {
      if (is.null(p$season) || as.integer(p$season) != live_season || is.null(p$gameLog)) next
      for (g in p$gameLog) {
        r <- g$round
        if (is.null(r) || !is.numeric(r)) next
        if (r > rmax) rmax <- r
        if (r < rmin) rmin <- r
      }
    }
    if (is.finite(rmax)) {
      offset  <- if (rmin == 0) 1 else 0   # Opening Round: round 0 for us, 1 in the feed
      last_ha <- if (offset == 1) 24 else 23
      live_cutoff <- min(rmax, last_ha) + offset
      message(sprintf("Live season %d: capping coaches votes at feed round <= %d (played round %d, offset %d)",
                      live_season, live_cutoff, rmax, offset))
    }
  }
}

all <- list()
for (yr in from:to) {
  d <- tryCatch(
    fetch_coaches_votes(season = yr, comp = "AFLM"),
    error = function(e) { message(sprintf("  %d: error - %s", yr, conditionMessage(e))); NULL }
  )
  if (is.null(d) || nrow(d) == 0) { message(sprintf("  %d: no data", yr)); next }
  # Cap the live season at the round we've played (see the block above); past
  # seasons are complete and sum in full.
  if (!is.na(live_season) && yr == live_season && is.finite(live_cutoff)) {
    d <- d %>% filter(suppressWarnings(as.integer(Round)) <= live_cutoff)
  }
  # Votes come back as TEXT -> coerce, then sum per player to a season total.
  agg <- d %>%
    mutate(
      season = as.integer(Season),
      player = as.character(Player.Name),
      v = suppressWarnings(as.numeric(Coaches.Votes))
    ) %>%
    filter(!is.na(player), player != "") %>%
    group_by(season, player) %>%
    summarise(votes = sum(v, na.rm = TRUE), .groups = "drop") %>%
    filter(votes > 0)
  message(sprintf("  %d: %d players with votes (%d round rows)", yr, nrow(agg), nrow(d)))
  all[[as.character(yr)]] <- agg
}

fresh <- if (length(all)) {
  bind_rows(all)
} else {
  data.frame(season = integer(), player = character(), votes = numeric())
}

# Merge: keep seasons OUTSIDE the fetched range so a current-season refresh
# doesn't drop the backfilled history; replace the fetched season(s) with fresh
# totals (votes accumulate, so the latest fetch supersedes).
if (file.exists(OUT)) {
  existing <- tryCatch(suppressMessages(readr::read_csv(OUT, show_col_types = FALSE)),
                       error = function(e) NULL)
  if (!is.null(existing) && all(c("season", "player", "votes") %in% names(existing))) {
    existing <- existing %>% filter(!(season %in% seq(from, to)))
    fresh <- bind_rows(existing, fresh)
  }
}

fresh <- fresh %>%
  distinct(season, player, .keep_all = TRUE) %>%
  arrange(desc(season), desc(votes), player)

readr::write_csv(fresh, OUT)
message(sprintf("Wrote %d season-player coaches-vote total(s) to %s", nrow(fresh), OUT))
