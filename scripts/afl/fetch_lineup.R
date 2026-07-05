#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Fetch AFL team sheets (named lineups) for recent/current rounds and write a
# flat CSV that build-lineup.mjs turns into lineups.json.
#
# AFL API (Champion Data) via fitzRoy — same track as the worm (match-window
# job, not the Squiggle Worker).
#
# Run:
#   Rscript scripts/afl/fetch_lineup.R          # last 2 rounds .. next round
#   Rscript scripts/afl/fetch_lineup.R 16 18    # a round range
#
# Writes scripts/afl/lineup_raw.csv (one row per named player).
# ---------------------------------------------------------------------------

suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
year <- as.integer(format(Sys.Date(), "%Y"))

fx <- fetch_fixture_afl(year)
played <- tolower(as.character(fx$status)) %in% c("concluded", "live")
cur <- suppressWarnings(max(fx$round.roundNumber[played], na.rm = TRUE))
if (!is.finite(cur)) cur <- 0
from <- if (length(args) >= 1) as.integer(args[1]) else max(0, cur - 2)
to   <- if (length(args) >= 2) as.integer(args[2]) else cur + 1

message(sprintf("Lineups: rounds %d-%d", from, to))

# Prefer round-scoped calls (few AFL API requests); fall back to a full-season
# fetch + filter only if round scoping isn't supported.
fetch_round <- function(r) {
  tryCatch(
    fetch_lineup(season = year, round_number = r),
    error = function(e) tryCatch(
      fetch_lineup(season = year, round = r),
      error = function(e2) NULL
    )
  )
}
parts <- lapply(from:to, fetch_round)
ok <- !vapply(parts, is.null, logical(1))
if (any(ok)) {
  lu <- bind_rows(parts[ok])
} else {
  message("Round-scoped fetch unsupported — fetching full season and filtering.")
  lu <- fetch_lineup(season = year)
  lu <- lu[lu$round.roundNumber >= from & lu$round.roundNumber <= to, ]
}

if (is.null(lu) || nrow(lu) == 0) {
  message("No lineups for the requested round(s) — teams may not be named yet.")
  quit(status = 0)
}

# Round-scoped fetches omit `lateChanges` when a round has none, while the
# full-season fetch includes it. Add it if missing so the transmute is stable.
if (!"lateChanges" %in% names(lu)) lu$lateChanges <- NA_character_

out <- lu %>%
  transmute(
    providerId,
    round      = round.roundNumber,
    teamName,
    teamType,
    position,
    jumper     = player.playerJumperNumber,
    surname    = player.playerName.surname,
    captain    = player.captain,
    teamStatus,
    lateChange = lateChanges
  )
write_csv(out, "scripts/afl/lineup_raw.csv")
message(sprintf("Wrote %d lineup rows to scripts/afl/lineup_raw.csv", nrow(out)))
message("Now run: node scripts/afl/build-lineup.mjs")
