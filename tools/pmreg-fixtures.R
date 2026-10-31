# Reference taut-string fits from ftnonpar's pmreg (Davies & Kovac), for test/fixtures/pmreg.json.
#
# ftnonpar was archived from CRAN and its Fortran parts need gfortran, so this compiles only the C file
# pmreg needs (src/strings.c) from an extracted source tarball instead of installing the package:
#
#   curl -LO https://cran.r-project.org/src/contrib/Archive/ftnonpar/ftnonpar_0.1-88.tar.gz
#   tar xzf ftnonpar_0.1-88.tar.gz
#   node tools/pmreg-inputs.mjs > pmreg-inputs.json
#   Rscript tools/pmreg-fixtures.R ftnonpar pmreg-inputs.json test/fixtures/pmreg.json
#
# pmregPaper below is ftnonpar's pmreg with the settings of the paper (appendix 7.3): threshold
# sqrt(tau log n) * sigma with tau = 3 and a given sigma, dyadic intervals (dyad.factor = 2), local
# squeezing by 1/2, and none of pmreg's extras: no further global squeezing after convergence, no
# setting extremes to local means, no isotonic post-processing. Requires jsonlite.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 3)
    stop("usage: Rscript tools/pmreg-fixtures.R <ftnonpar-source-dir> <inputs.json> <out.json>")
src <- file.path(args[1], "src", "strings.c")
build <- tempfile("ftnonpar-")
dir.create(build)
file.copy(src, build)
so <- file.path(build, paste0("strings", .Platform$dynlib.ext))
old <- setwd(build)
status <- system2(file.path(R.home("bin"), "R"), c("CMD", "SHLIB", "strings.c"))
setwd(old)
if (status != 0)
    stop("compiling strings.c failed")
dyn.load(so)

tautstring <- function(ttt, fdist, y.low, y.up, y1, yn) {
    tmp <- .C("tautstring", as.double(fdist), as.double(ttt), as.double(y.low), as.double(y.up),
              as.double(y1), as.double(yn), as.integer(length(y.low)),
              tautstring = double(length(y.low) - 1), knotsind = integer(length(y.low)),
              knotst = double(length(y.low)), knotsy = double(length(y.low)), nknots = integer(1),
              nmax = integer(1), extrmean = as.integer(FALSE))
    list(string = tmp$tautstring, nmax = tmp$nmax)
}

multiwdwr <- function(y, thresh, firstwidth = 1, dyad.factor = 2) {
    .C("multiwdwr", y = as.double(y), as.integer(length(y)), as.double(thresh),
       as.integer(firstwidth), as.double(dyad.factor))$y
}

pmregPaper <- function(y, sigma, tau = 3, squeezing.factor = 0.5, max.iter = 200) {
    nsamp <- length(y)
    fdist <- c(0, cumsum(y)) / nsamp
    fdistx <- seq(0, 1, len = nsamp + 1)
    d <- max(fdist) - min(fdist)
    eps <- rep(d, nsamp + 1)
    iter <- 0
    repeat {
        tstring <- tautstring(fdistx, fdist, fdist - eps, fdist + eps, 0, fdist[nsamp + 1])
        iter <- iter + 1
        residuals <- y - tstring$string
        residuals <- residuals - mean(residuals)
        ind <- abs(multiwdwr(residuals, sqrt(tau * log(nsamp)) * sigma)) > 1e-10
        if (!any(ind) || iter >= max.iter)
            break
        ind2 <- c(FALSE, ind) | c(ind, FALSE)
        eps[ind2] <- eps[ind2] * squeezing.factor
    }
    list(y = tstring$string, nmax = tstring$nmax, iterations = iter, converged = !any(ind))
}

inputs <- jsonlite::fromJSON(args[2], simplifyVector = FALSE)
out <- lapply(inputs, function(case) {
    y <- unlist(case$y)
    fit <- pmregPaper(y, sigma = case$sigmaHat, tau = case$tau)
    c(case, list(pmreg = list(f = fit$y, nmax = fit$nmax, iterations = fit$iterations,
                              converged = fit$converged)))
})
meta <- list(source = "ftnonpar 0.1-88 src/strings.c via tools/pmreg-fixtures.R",
             r = R.version.string, cases = out)
writeLines(jsonlite::toJSON(meta, auto_unbox = TRUE, digits = NA), args[3])
cat("wrote", length(out), "cases to", args[3], "\n")
