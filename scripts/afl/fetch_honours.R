#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Fetch AFL honours (Brownlow, All-Australian, Rising Star, coaches votes) and
# write flat CSVs that build-honours.mjs matches to players and folds into
# honours.json. Awards change once a year, so this is an occasional run.
#
# Run:
#   Rscript scripts/afl/fetch_honours.R          # 1990 -> current
#   Rscript scripts/afl/fetch_honours.R 2000 2026
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
from <- if (length(args) >= 1) as.integer(args[1]) else 1990
to   <- if (length(args) >= 2) as.integer(args[2]) else as.integer(format(Sys.Date(), "%Y"))

# Fetch season-by-season and bind (each award only exists from a certain year).
gather <- function(fn) {
  out <- list()
  for (yr in from:to) {
    d <- tryCatch(fn(yr), error = function(e) NULL)
    if (!is.null(d) && is.data.frame(d) && nrow(d) > 0) out[[as.character(yr)]] <- d
  }
  if (length(out) == 0) NULL else bind_rows(out)
}

bl <- gather(function(y) fetch_awards_brownlow(y))
if (!is.null(bl)) {
  # Votes_3 is the actual single-season 3-2-1 tally (verified vs the real 2023
  # leaderboard: Neale 31, Bontempelli 29…). The `Votes` column is a different,
  # inflated aggregate — don't use it.
  write_csv(
    bl %>% transmute(season = Season, player = Player, team = Team, votes = Votes_3),
    "scripts/afl/honours_brownlow.csv"
  )
  message(sprintf("brownlow: %d rows", nrow(bl)))
}

aa <- gather(function(y) fetch_awards_allaustralian(y))
if (!is.null(aa)) {
  write_csv(
    aa %>% transmute(season = Season, player = Player, team = Team, position = Position),
    "scripts/afl/honours_aa.csv"
  )
  message(sprintf("all-australian: %d rows", nrow(aa)))
}

rs <- gather(function(y) fetch_rising_star(y))
if (!is.null(rs)) {
  # Weekly nominees → one row per (player, season).
  rsu <- rs %>% distinct(Season, Player, Team)
  write_csv(rsu %>% transmute(season = Season, player = Player, team = Team), "scripts/afl/honours_rising.csv")
  message(sprintf("rising star: %d nominee-seasons", nrow(rsu)))
}

cv <- gather(function(y) fetch_coaches_votes(season = y))
if (!is.null(cv)) {
  # Per-match votes → season totals per player (Player.Name embeds "(TEAM)").
  cvs <- cv %>%
    group_by(Season, Player.Name) %>%
    summarise(votes = sum(Coaches.Votes, na.rm = TRUE), .groups = "drop")
  write_csv(cvs %>% transmute(season = Season, player = Player.Name, votes = votes), "scripts/afl/honours_coaches.csv")
  message(sprintf("coaches votes: %d player-seasons", nrow(cvs)))
}

message("Now run: node scripts/afl/build-honours.mjs")
