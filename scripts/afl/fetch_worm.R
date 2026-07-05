#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Fetch AFL score progression (the "worm") for recent/live matches and write a
# flat CSV that build-worm.mjs turns into worm.json.
#
# Source is the AFL API (Champion Data) via fitzRoy — the same feed as the
# player stats, NOT Squiggle — so this belongs in the match-window job, not the
# Cloudflare Worker.
#
# Run:
#   Rscript scripts/afl/fetch_worm.R            # last completed round + current
#   Rscript scripts/afl/fetch_worm.R 18 20      # a round range
#
# Writes scripts/afl/worm_raw.csv (one row per scoring progression point).
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
year <- as.integer(format(Sys.Date(), "%Y"))

fx <- fetch_fixture_afl(year)

playing <- tolower(as.character(fx$status)) %in% c("concluded", "live")
cur <- suppressWarnings(max(fx$round.roundNumber[playing], na.rm = TRUE))
if (!is.finite(cur)) {
  message("No concluded/live matches yet this season — nothing to do.")
  quit(status = 0)
}
from <- if (length(args) >= 1) as.integer(args[1]) else max(1, cur - 1)
to   <- if (length(args) >= 2) as.integer(args[2]) else cur

# LIVE_ONLY=1 (set by the match-window job) fetches only in-progress matches, so
# frequent runs don't re-pull already-final worms — those are merged/kept by the
# build step instead.
statuses <- if (Sys.getenv("LIVE_ONLY") == "1") c("LIVE") else c("CONCLUDED", "LIVE")
sel <- fx %>%
  filter(round.roundNumber >= from, round.roundNumber <= to,
         toupper(as.character(status)) %in% statuses)
message(sprintf("Score worm: %d match(es), rounds %d-%d [%s]",
                nrow(sel), from, to, paste(statuses, collapse = "/")))

rows <- list()
for (i in seq_len(nrow(sel))) {
  row <- sel[i, ]
  mid <- as.character(row$providerId)
  d <- tryCatch(
    fetch_score_worm_data(match_id = mid),
    error = function(e) {
      message(sprintf("  %s: %s", mid, conditionMessage(e)))
      NULL
    }
  )
  if (is.null(d) || nrow(d) == 0) next
  rows[[mid]] <- tibble(
    match_id  = mid,
    year      = year,
    round     = row$round.roundNumber,
    homeName  = row$home.team.name,
    awayName  = row$away.team.name,
    homeScore = row$home.score.totalScore,
    awayScore = row$away.score.totalScore,
    status    = as.character(row$status),
    secs      = as.numeric(d$cumulativeSeconds),
    margin    = as.numeric(d$scoreDifference), # home - away, running
    quarter   = as.integer(d$periodNumber)
  )
  message(sprintf("  %s R%s: %d points", mid, row$round.roundNumber, nrow(d)))
}
if (length(rows) == 0) {
  message("No worm data returned — nothing written.")
  quit(status = 0)
}
out <- bind_rows(rows)
write_csv(out, "scripts/afl/worm_raw.csv")
message(sprintf("Wrote %d progression points to scripts/afl/worm_raw.csv", nrow(out)))
message("Now run: node scripts/afl/build-worm.mjs")
