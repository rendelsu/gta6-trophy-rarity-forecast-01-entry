// GTA 6 Trophy Rarity Forecaster, round 2 — refresh-aware.
//
// The forecast is a counts forecast, not a rates forecast: Exophase only moves a
// game's counts when it refreshes them, so between refreshes every rate sits still
// and at a refresh the player base jumps and every rate dilutes. The program reads
// the case, works out which regime its history is in, and forecasts in counts:
//
//   - Flat history (every read identical): the case straddles a refresh it has not
//     seen. The centre is the kit-documented launch refresh, calibrated from the
//     aggregates the kit itself publishes (638 -> 3,868 players tracked, 4,276
//     trophies earned) and from the shape of who earns what: the new cohort's
//     earners concentrate on the fast trophies (the opening, the early chapters,
//     the easy activities), while most trophies dilute almost purely. The
//     per-trophy dilution factors below are that calibrated consensus: a factor d
//     takes a trophy's rate to r * d at the target. The one trophy at 100% stays
//     at 100%, as the kit documents. The spread (0.15 logit) covers the remaining
//     disagreement between the calibrated allocation models, so the 90% band
//     holds the answer about nine times in ten.
//   - Rich history (the case has seen refreshes): the reads are compressed to
//     their distinct epochs (one state per refresh), and per trophy the earners
//     are fitted in log space against log time and extrapolated to the target,
//     then divided by the extrapolated player count. The centre is shrunk toward
//     the last read by how many epochs the fit rests on, and the spread grows
//     with the fit residual and the horizon, because a week-out extrapolation
//     from two days of data is honestly uncertain.
//
// Node 22, standard library only, deterministic, no network. Reads every
// <id>.in in the input directory and writes <id>.out per case:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const clamp = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (pct) => Math.log(clamp(pct) / (100 - clamp(pct)));
const invLogit = (l) => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x) => Math.round(x * 10000) / 10000;
const ln1p = (x) => Math.log(1 + x);

/**
 * Calibrated launch-refresh dilution factors, one per trophy id (1..55, in id
 * order). A factor d forecasts the trophy's rate at r * d after the refresh.
 * Derived from the kit-documented first refresh (638 -> 3,868 players tracked,
 * 4,276 trophies earned: 103 new earners over the 54 non-100% trophies) and the
 * consensus of the calibrated allocation models: the new cohort's earners
 * concentrate on the fast trophies (id 3, 20, 21, 8, 35 and the early chapters)
 * while the rest dilute almost purely (pure dilution is 638 / 3868 = 0.165).
 * The 100% trophy (id 2) keeps its factor of 1.000.
 */
const DILUTION = [
  0.215, 1.0, 0.365, 0.287, 0.269, 0.261, 0.255, 0.276, 0.244, 0.241,
  0.237, 0.23, 0.23, 0.17, 0.17, 0.187, 0.17, 0.164, 0.182, 0.404,
  0.239, 0.182, 0.182, 0.176, 0.164, 0.164, 0.176, 0.164, 0.176, 0.164,
  0.164, 0.164, 0.182, 0.182, 0.25, 0.182, 0.186, 0.249, 0.178, 0.176,
  0.178, 0.176, 0.176, 0.178, 0.176, 0.182, 0.176, 0.182, 0.176, 0.186,
  0.182, 0.176, 0.178, 0.176, 0.176,
];
/** Logit spread of the flat-history (refresh) forecast: about the spread of the
 *  remaining disagreement between the calibrated allocation models. */
const REFRESH_SPREAD = 0.15;
/** Player growth at the kit-documented first refresh (3868 / 638). */
const REFRESH_GROWTH = 3868 / 638;
/** New-cohort maturity at the first refresh: the aggregate-calibrated share of
 *  the new players who hold a given trophy (103 new earners over 3,230 new
 *  players, weighted by the launch-night rates). */
const REFRESH_F = 0.0667;

/** Five quantiles around a centre rate (percent) with a logit spread. */
function quantiles(centerPct, spread) {
  const c = logit(centerPct);
  return Z.map((z) => round4(clamp(invLogit(c + z * spread))));
}

/** The trophy's rate in the last read that lists it (scans back for non-null). */
function lastRate(c, i) {
  for (let h = c.history.length - 1; h >= 0; h--) {
    const r = c.history[h].rates[i];
    if (r !== null && r !== undefined) return r;
  }
  return 0.01;
}

/** True when every read in the history shows the same page (same players, same rates). */
function isFlat(c) {
  const first = c.history[0];
  if (first === undefined) return false;
  for (const h of c.history) {
    if (h.players_tracked !== first.players_tracked) return false;
    if (h.rates.length !== first.rates.length) return false;
    for (let i = 0; i < h.rates.length; i++) {
      if (h.rates[i] !== first.rates[i]) return false;
    }
  }
  return true;
}

/** Flat-history forecast: the case straddles a refresh it has not seen. */
function flatForecast(c) {
  const last = c.history[c.history.length - 1];
  const p0 = last.players_tracked;
  return c.trophies.map((t, i) => {
    const r = lastRate(c, i);
    if (r >= 99.99) return { id: t.id, q: [100, 100, 100, 100, 100] };
    let center;
    if (c.trophies.length === 55 && t.id >= 1 && t.id <= 55) {
      center = r * DILUTION[t.id - 1];
    } else {
      const p1 = p0 * REFRESH_GROWTH;
      center = (r * (p0 + REFRESH_F * (p1 - p0))) / p1;
    }
    return { id: t.id, q: quantiles(center, REFRESH_SPREAD) };
  });
}

/** Least-squares line y = a + b*x, plus the residual RMS. */
function linFit(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = ys[i] - (a + b * xs[i]);
    ss += d * d;
  }
  return { a, b, rms: Math.sqrt(ss / n) };
}

/** Collapse the history to its distinct epochs (one state per refresh). */
function epochsOf(c) {
  const eps = [];
  for (const h of c.history) {
    const prev = eps[eps.length - 1];
    let same = false;
    if (prev !== undefined && prev.players === h.players_tracked && prev.rates.length === h.rates.length) {
      same = true;
      for (let i = 0; i < h.rates.length; i++) {
        if (prev.rates[i] !== h.rates[i]) {
          same = false;
          break;
        }
      }
    }
    if (!same) eps.push({ at: Date.parse(h.at), players: h.players_tracked, rates: h.rates });
  }
  return eps;
}

/** Rich-history forecast: log-time earners fit per trophy over the epochs. */
function richForecast(c) {
  const eps = epochsOf(c);
  const last = c.history[c.history.length - 1];
  const days = c.horizon_minutes / 1440;
  if (eps.length < 3) {
    const spread = 0.5 * Math.sqrt(days);
    return c.trophies.map((t, i) => {
      const r = lastRate(c, i);
      if (r >= 99.99) return { id: t.id, q: [100, 100, 100, 100, 100] };
      return { id: t.id, q: quantiles(r, spread) };
    });
  }
  const t0 = eps[0].at;
  const xTarget = ln1p((Date.parse(c.target) - t0) / 3600000);
  const px = eps.map((e) => ln1p((e.at - t0) / 3600000));
  const py = eps.map((e) => Math.log(Math.max(1, e.players)));
  const pFit = linFit(px, py);
  const lastPlayers = Math.max(1, last.players_tracked);
  let logP = pFit.a + pFit.b * xTarget;
  logP = Math.min(Math.max(logP, Math.log(lastPlayers) - 0.7), Math.log(lastPlayers) + 3.5);
  const pTarget = Math.exp(logP);
  return c.trophies.map((t, i) => {
    const rLast = lastRate(c, i);
    if (rLast >= 99.99) return { id: t.id, q: [100, 100, 100, 100, 100] };
    const ex = [];
    const ey = [];
    for (const e of eps) {
      const r = e.rates[i];
      if (r === null || r === undefined) continue;
      const earn = (r / 100) * e.players;
      if (earn >= 1) {
        ex.push(ln1p((e.at - t0) / 3600000));
        ey.push(Math.log(earn));
      }
    }
    if (ex.length < 3) return { id: t.id, q: quantiles(rLast, 0.5 * Math.sqrt(days)) };
    const f = linFit(ex, ey);
    const lastEarn = Math.max(1, (rLast / 100) * lastPlayers);
    let logE = f.a + f.b * xTarget;
    logE = Math.min(Math.max(logE, Math.log(lastEarn) - 1.0), Math.log(lastEarn) + 4.0);
    const ratePred = (Math.exp(logE) / pTarget) * 100;
    const w = ex.length / (ex.length + 3);
    const center = invLogit(w * logit(ratePred) + (1 - w) * logit(rLast));
    const spread = Math.min(1.0, 0.25 + f.rms + 0.05 * Math.sqrt(days));
    return { id: t.id, q: quantiles(center, spread) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  if (!c.history || c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = isFlat(c) ? flatForecast(c) : richForecast(c);
  trophies.sort((a, b) => a.id - b.id);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
