#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Pull AFL player stats from the OFFICIAL AFL / Champion Data source via fitzRoy.
# Richer than the fryzigg cache: includes real positions and jumper numbers, and
# covers the CURRENT (in-progress) season — updated as rounds are played.
#
# One-time setup (in R):
#   install.packages(c("fitzRoy", "readr", "dplyr"))
#
# Run:
#   Rscript scripts/afl/fetch_afl.R              # 2012 → current year (full history)
#   Rscript scripts/afl/fetch_afl.R 2015 2026    # custom range
#
# 2012 is as far back as the official AFL / Champion Data feed goes with the
# advanced metrics this app needs (contested poss, disposal eff, metres gained,
# score involvements, intercepts, ground-ball gets are all complete from 2012;
# 2010-2011 return nothing from this source).
#
# Writes scripts/afl/afl_raw.csv (only the columns the transform needs).
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
from <- if (length(args) >= 1) as.integer(args[1]) else 2012
to   <- if (length(args) >= 2) as.integer(args[2]) else as.integer(format(Sys.Date(), "%Y"))
# Optional 3rd arg: a single round to fetch (round-scoped, cheap) — used by the
# match-window job for near-live current-round stats. Omitted => whole season.
rnd  <- if (length(args) >= 3) as.integer(args[3]) else NULL

message(sprintf("Fetching AFL (official) player stats %d-%d%s ...",
                from, to, if (is.null(rnd)) "" else sprintf(" round %d", rnd)))

# Fetch season by season and bind — robust to the current season being partial
# or a season returning nothing.
all <- list()
for (yr in from:to) {
  d <- tryCatch(
    if (is.null(rnd)) {
      fetch_player_stats(season = yr, source = "AFL")
    } else {
      fetch_player_stats(season = yr, round_number = rnd, source = "AFL")
    },
    error = function(e) {
      message(sprintf("  %d: error - %s", yr, conditionMessage(e)))
      NULL
    }
  )
  if (is.null(d) || nrow(d) == 0) {
    message(sprintf("  %d: no data", yr))
    next
  }
  message(sprintf("  %d: %d rows", yr, nrow(d)))
  all[[as.character(yr)]] <- d
}
if (length(all) == 0) {
  message("No data for the requested season(s) — nothing written (e.g. off-season).")
  quit(status = 0)
}
combined <- bind_rows(all)

# Keep only the columns the Node transform reads (also avoids list-column issues
# and keeps the CSV small).
keep <- c(
  "compSeason.shortName", "utcStartTime", "round.roundNumber", "team.name", "teamId",
  "player.player.player.playerId", "player.player.player.givenName",
  "player.player.player.surname", "player.player.player.playerJumperNumber",
  "player.jumperNumber", "player.player.position",
  "goals", "behinds", "kicks", "handballs", "disposals", "marks", "tackles",
  "contestedPossessions", "uncontestedPossessions", "inside50s", "marksInside50",
  "hitouts", "disposalEfficiency", "rebound50s", "intercepts", "scoreInvolvements",
  "metresGained", "clearances.centreClearances", "clearances.stoppageClearances",
  "clearances.totalClearances", "extendedStats.groundBallGets",
  # --- Champion Data advanced stats + official AFL Player Rating (all present in
  # the AFL/CD feed back to 2012, fully populated). Same live path as the basics
  # above; historical seasons pick them up on a full merge-rebuild.
  "ratingPoints", "contestedMarks", "onePercenters", "tacklesInside50",
  "timeOnGroundPercentage", "goalAssists", "clangers", "turnovers",
  "extendedStats.spoils", "extendedStats.interceptMarks",
  "extendedStats.contestDefOneOnOnes", "extendedStats.defHalfPressureActs",
  "extendedStats.pressureActs", "extendedStats.scoreLaunches",
  "extendedStats.marksOnLead", "extendedStats.hitoutsToAdvantage",
  "extendedStats.ruckContests", "extendedStats.effectiveDisposals",
  # --- Remaining AFL/CD feed columns: box-score extras, contest breakdowns,
  # kick-ins, efficiency %s. Percentages are 0-100 (like disposalEfficiency).
  # goalEfficiency/shotEfficiency/superGoals/ranking come back EMPTY from this
  # source across all seasons — kept here so they flow through automatically if
  # the feed ever populates them.
  "bounces", "dreamTeamPoints", "freesFor", "freesAgainst",
  "shotsAtGoal", "goalEfficiency", "shotEfficiency", "superGoals", "ranking",
  "extendedStats.centreBounceAttendances", "extendedStats.contestDefLosses",
  "extendedStats.contestDefLossPercentage", "extendedStats.contestOffOneOnOnes",
  "extendedStats.contestOffWins", "extendedStats.contestOffWinsPercentage",
  "extendedStats.effectiveKicks", "extendedStats.f50GroundBallGets",
  "extendedStats.hitoutToAdvantageRate", "extendedStats.hitoutWinPercentage",
  "extendedStats.kickEfficiency", "extendedStats.kickins", "extendedStats.kickinsPlayon"
)
combined <- combined[, intersect(keep, names(combined)), drop = FALSE]

out <- "scripts/afl/afl_raw.csv"
readr::write_csv(combined, out)
message(sprintf("Wrote %d rows (%d columns) to %s", nrow(combined), ncol(combined), out))
message("Now run: npm run data:build")
