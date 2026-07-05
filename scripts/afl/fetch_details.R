#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# Pull AFL player BIOS (date of birth, height) from the official AFL source via
# fitzRoy, so the app can compute age and show height. Complements fetch_afl.R
# (which pulls match stats). Writes scripts/afl/afl_details.csv keyed by
# providerId (matches player.player.player.playerId in the stats feed).
#
#   Rscript scripts/afl/fetch_details.R              # 2012 -> current year (full history)
#   Rscript scripts/afl/fetch_details.R 2015 2026    # custom range
# ---------------------------------------------------------------------------
suppressMessages({
  library(fitzRoy)
  library(readr)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
from <- if (length(args) >= 1) as.integer(args[1]) else 2012
to   <- if (length(args) >= 2) as.integer(args[2]) else as.integer(format(Sys.Date(), "%Y"))

message(sprintf("Fetching AFL player bios %d-%d ...", from, to))

all <- list()
for (yr in from:to) {
  d <- tryCatch(
    fetch_player_details(season = yr, source = "AFL"),
    error = function(e) { message(sprintf("  %d: error - %s", yr, conditionMessage(e))); NULL }
  )
  if (is.null(d) || nrow(d) == 0) { message(sprintf("  %d: no data", yr)); next }
  d$season <- yr
  message(sprintf("  %d: %d players", yr, nrow(d)))
  all[[as.character(yr)]] <- d
}
if (length(all) == 0) { message("No bios fetched — nothing written."); quit(status = 0) }

combined <- bind_rows(all)
# Bio join key is providerId (matches the stats feed). Draft/recruited/debut are
# populated for genuine draftees (~half of players); blank for trades/rookies/
# mature-age — which is fine, the app just shows what's present. (weightInKg is
# all-zero from this source, so it's not kept.)
keep <- c(
  "providerId", "dateOfBirth", "heightInCm",
  "draftYear", "draftPosition", "recruitedFrom", "debutYear",
  "season"
)
combined <- combined[, intersect(keep, names(combined)), drop = FALSE]

# Latest bio per player (DOB is constant; height barely changes) — smallest file.
combined <- combined %>%
  arrange(providerId, desc(season)) %>%
  distinct(providerId, .keep_all = TRUE)

out <- "scripts/afl/afl_details.csv"
readr::write_csv(combined, out)
message(sprintf("Wrote %d player bios to %s", nrow(combined), out))
