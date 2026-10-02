// The confidence bands the pipeline reads answers with, and the defaults a run
// starts from.
//
// The bands are calibrated to Jev's own probabilities, so they do not transfer
// to a different model unchanged. A provider carries its own defaults (see
// src/providers) and callers may override them per run; nothing else needs to
// know which model answered.

/** Confidence bands, following the cookbook's 0.7 / 0.35 split. Tune on real data. */
export const FOUND = 0.7;
export const MAYBE = 0.35;

export interface Thresholds {
  found: number;
  maybe: number;
  keepContent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { found: FOUND, maybe: MAYBE, keepContent: 0.8 };

/**
 * How sure the pipeline wants to be that a skip never eats content: a phrase
 * is only skipped when it is sponsor with at least this probability. Sitting
 * through a second of a sponsor read is the price of never cutting a second
 * of the video.
 */
export const KEEP_CONTENT = 0.8;
