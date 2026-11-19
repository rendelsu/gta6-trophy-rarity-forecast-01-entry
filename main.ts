// GTA 6 trophy rarity forecaster (gta6-trophy-rarity-forecast-01).
//
// Forecasts, for every GTA VI PS5 trophy, five quantiles of its earn rate on
// Exophase at the case's target, from the house's reads of the trophy page
// before the case's checkpoint. Node 22, standard library only, no network,
// deterministic, one case file in, one forecast file out.
//
// The model thinks in EARner counts, not rates. A trophy's rate is
// earners / players_tracked, and Exophase refreshes its counts on its own
// schedule: between refreshes the page is frozen, at a refresh the tracked
// player count jumps and every rate moves. So the program models the two
// counts separately and divides at the target:
//
//   * players: log players_tracked is fitted against ln(1 + hours since the
//     first read) over the distinct refresh states, recency-weighted, and
//     read at the target (players never fall, growth is capped);
//   * earners: per trophy, log earners is fitted against log players over
//     the same states, giving an elasticity beta (beta = 1 means earners
//     grow with the player base and the rate holds; beta = 0 means earners
//     stall and the rate is diluted away). Beta is shrunk toward 0.75 when
//     few states exist and clamped to [0, 1.5];
//   * rate at target = 100 * earners(target) / players(target).
//
// The spread is the fit's residual plus the house's random-walk term
// (0.5 logit per sqrt day), combined in quadrature, so a longer horizon or
// a noisier fit honestly widens the band.
//
// When the history shows no refresh at all (a single distinct player
// count, as on launch night), there is nothing to fit: the program falls
// back to a dilution prior. Launch night's first refresh took players
// 638 -> 3,868 while new players had earned almost nothing yet, so every
// rate but the one at 100% fell; the fallback therefore keeps the median at
// the last rate and opens a wide LOWER tail only (the upper quantiles sit
// at the median: a rate can only rise if newcomers earn faster than the
// launch cohort did, which the launch-night totals rule out). The lower
// spread grows with the square root of the horizon. On the practice cases
// this beats the house baseline at every point of a synthetic-refresh
// sweep (maturity factor 0 to 1); see the lab notes beside the entry.
//
// Plain JavaScript syntax throughout (no type annotations): the grader
// runs Node 22 without type stripping, so an annotation would fail the run.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The quantile levels the contest scores, in the order each row lists them.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// The standard normal's quantile at each level.
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
// Random-walk spread, in logit units per square-root day (the house's term).
const SIGMA_RW = 0.5;
// Fallback (flat history) lower-tail spread per square-root day: 0.92 makes
// it 0.23 logit over the practice's 90-minute horizon.
const FALLBACK_SLOPE = 0.92;
// Prior elasticity of earners to players when a trophy has little history:
// 0.75 leans slightly toward dilution (new players dilute a rate) while
// staying close to persistence (1.0); with many states the fit dominates.
const BETA_PRIOR = 0.75;
const BETA_PRIOR_WEIGHT = 2;
// Residual floor (logit) so a perfect-looking short fit is never trusted.
const RESID_FLOOR = 0.2;
const RESID_CAP = 1.2;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clampRate = (x) => clamp(x, 0.01, 99.99);
const logit = (pct) => Math.log(clampRate(pct) / (100 - clampRate(pct)));
const invLogit = (l) => 100 / (1 + Math.exp(-l));
// x rounded to 4 decimals.
const round4 = (x) => Math.round(x * 10000) / 10000;

// Weighted least squares of y on x. Returns { a, b, resid } where
// y ~= a + b * x and resid is the weighted residual standard deviation.
function weightedFit(xs, ys, ws) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sse += ws[i] * r * r;
  }
  // Weighted mean squared residual: the typical log-scale miss of the fit.
  const resid = Math.sqrt(sse / sw);
  return { a, b, resid };
}

// One forecast row for a trophy whose last rate is r and whose history is
// flat (no refresh seen): median at r, wide lower tail, upper tail at r.
function fallbackRow(id, r, horizonMinutes) {
  const dDays = horizonMinutes / 1440;
  const sLo = FALLBACK_SLOPE * Math.sqrt(dDays);
  const c = logit(r);
  const q = Z.map((z, k) => {
    const s = k < 2 ? sLo : 0;
    return round4(clampRate(invLogit(c + z * s)));
  });
  for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
  return { id, q };
}

// Full forecast for one case: earner-space model when the history holds at
// least two distinct refresh states, the dilution fallback otherwise.
function forecast(c) {
  if (!c.history || c.history.length === 0) throw new Error('case has no history');
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const horizonMinutes = c.horizon_minutes;
  const dDays = horizonMinutes / 1440;
  const last = c.history[c.history.length - 1];
  const nTrophies = c.trophies.length;

  // Distinct refresh states: one entry per distinct players_tracked value,
  // keeping the first read that shows it (reads between refreshes repeat
  // the same page). A state also needs a timestamp and a rate per trophy.
  const states = [];
  const seenPlayers = new Set();
  for (const read of c.history) {
    if (read.players_tracked == null || read.players_tracked <= 0) continue;
    if (seenPlayers.has(read.players_tracked)) continue;
    seenPlayers.add(read.players_tracked);
    states.push(read);
  }
  if (states.length < 2) {
    return c.trophies.map((t, i) => fallbackRow(t.id, last.rates[i] ?? 0, horizonMinutes));
  }

  const t0 = Date.parse(states[0].at);
  const tLast = Date.parse(states[states.length - 1].at);
  const tTarget = Date.parse(c.target);
  const hoursSinceFirst = (t) => Math.max(0, (t - t0) / 3600000);
  // Recency weight: a state a day old counts half as much as the latest.
  const weight = (t) => 1 / (1 + Math.max(0, (tLast - t) / 86400000));

  // Players at the target: log players against ln(1 + hours since first).
  const px = states.map((s) => Math.log(1 + hoursSinceFirst(Date.parse(s.at))));
  const py = states.map((s) => Math.log(s.players_tracked));
  const pw = states.map((s) => weight(Date.parse(s.at)));
  const pFit = weightedFit(px, py, pw);
  const xTarget = Math.log(1 + hoursSinceFirst(tTarget));
  let playersTarget = Math.exp(pFit.a + pFit.b * xTarget);
  const playersLast = last.players_tracked;
  playersTarget = clamp(playersTarget, playersLast, playersLast * 50);

  const rows = [];
  for (let i = 0; i < nTrophies; i++) {
    const trophy = c.trophies[i];
    // Earners per state for this trophy; skip states that lack the rate.
    const xs = [];
    const ys = [];
    const ws = [];
    for (const s of states) {
      const r = s.rates[i];
      if (r == null) continue;
      const earners = Math.max((r / 100) * s.players_tracked, 0.5);
      xs.push(Math.log(s.players_tracked));
      ys.push(Math.log(earners));
      ws.push(weight(Date.parse(s.at)));
    }
    // Earners in the last read itself (the last read may repeat an earlier
    // player count, so it is not necessarily one of the fitted states).
    let lastRate = last.rates[i];
    if (lastRate == null) {
      for (let j = c.history.length - 1; j >= 0; j--) {
        if (c.history[j].rates[i] != null) { lastRate = c.history[j].rates[i]; break; }
      }
    }
    const earnersLast = lastRate == null ? null : Math.max((lastRate / 100) * playersLast, 0.5);
    if (earnersLast === null || xs.length < 2) {
      rows.push(fallbackRow(trophy.id, last.rates[i] ?? 0, horizonMinutes));
      continue;
    }
    const eFit = weightedFit(xs, ys, ws);
    let beta = (xs.length * eFit.b + BETA_PRIOR_WEIGHT * BETA_PRIOR) / (xs.length + BETA_PRIOR_WEIGHT);
    beta = clamp(beta, 0, 1.5);
    const earnersTarget = earnersLast * Math.pow(playersTarget / playersLast, beta);
    const rateMedian = clampRate((100 * earnersTarget) / playersTarget);
    const resid = clamp(eFit.resid, RESID_FLOOR, RESID_CAP);
    const spread = Math.sqrt(resid * resid + SIGMA_RW * SIGMA_RW * dDays);
    const center = logit(rateMedian);
    const q = Z.map((z) => round4(clampRate(invLogit(center + z * spread))));
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    rows.push({ id: trophy.id, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  const trophies = forecast(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
