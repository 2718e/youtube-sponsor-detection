// The questions the decision model is asked, and the words they are asked in.
//
// Each pass of the pipeline (scan, refine, cut) has a builder here that turns
// transcript lines or phrases into a `Questions` object: a noul ("does this
// happen?") or a choice between labelled lines. Nothing in this file calls a
// model or reads a probability back; the pass modules own that.
//
// Nothing here asks Jev for a number: it names a line or phrase ID and code
// reads the timestamp off it.

import { type Line, type Phrase } from '../transcript.js';
import { type Questions } from '../providers/contract.js';

export const NO_START = 'none';
export const RUNS_PAST_EXCERPT = 'continues_past_excerpt';

/**
 * What counts as a sponsor segment. Written for a model that reads literally:
 * the lead-in is spelled out because the naive reading ("the line that names
 * the sponsor") misses everything the creator says to set the pitch up.
 */
export const SPONSOR = {
  definition:
    'A sponsor segment is the part of a video that exists to promote a third party that paid ' +
    'for placement: a product, service, app or company. It is usually read by the creator.',
  shape: [
    'A sponsor segment normally has three parts, and it begins with the first one:',
    '1. a lead-in, where the creator leaves the subject of the video and starts a story, an anecdote, ' +
      'a problem, a question, a joke or a "quick break" whose only purpose is to arrive at the sponsor;',
    '2. the pitch, where the sponsor or its product is named and described;',
    '3. the offer, with a link, discount code, free trial, QR code or "link in the description".',
    'The lead-in can last several minutes and can sound like normal content until the sponsor is named. ' +
      'It still belongs to the sponsor segment from its first line.'
  ].join(' '),
  not_a_sponsor_segment: [
    'The creator promoting their own merchandise, membership, Patreon, newsletter, courses or other videos.',
    'Asking viewers to like, comment, subscribe or share.',
    'Thanking viewers, patrons or the crew.',
    'Content that stays on the subject of the video.'
  ]
};

/** One scan request: "is a sponsor segment in here, and where is the sponsor named?" */
export function scanQuestions(lines: Line[]): Questions {
  const options: Record<string, string | null> = {};
  for (const line of lines) options[line.id] = null;
  options[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  return {
    sponsor_starts_here: {
      type: 'noul',
      instructions: {
        question: 'Does a sponsor segment begin somewhere in this excerpt of the video transcript?',
        ...SPONSOR
      },
      criteria: {
        true: 'Somewhere in this excerpt the creator leaves the subject of the video and starts a sponsor segment: a lead-in, a pitch or an offer for a paying third party.',
        false: 'No sponsor segment begins in this excerpt. Either it is all regular content, or a sponsor segment that started before this excerpt is still running through it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'For example "thanks to X for sponsoring", "X is an app that", "today\'s video is brought to you by X", ' +
          'or a discount code or link for X. Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Refine, request one: confirm the segment, pin the line that names the
 * sponsor, and find the last line.
 */
export function anchorQuestions(lines: Line[]): Questions {
  const anchorOptions: Record<string, string | null> = {};
  for (const line of lines) anchorOptions[line.id] = null;
  anchorOptions[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  const endOptions: Record<string, string | null> = {};
  for (const line of lines) endOptions[line.id] = null;
  endOptions[RUNS_PAST_EXCERPT] = 'The sponsor segment is still running at the end of this excerpt.';
  endOptions[NO_START] = 'This excerpt contains no sponsor segment.';

  return {
    has_sponsor: {
      type: 'noul',
      instructions: { question: 'Does this excerpt of the video transcript contain a sponsor segment?', ...SPONSOR },
      criteria: {
        true: 'A sponsor segment for a paying third party is in this excerpt: its lead-in, its pitch, its offer, or all three.',
        false: 'This excerpt is the video\'s own content with no sponsor segment in it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: anchorOptions
    },
    end_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the LAST line of the sponsor segment: the final line of the pitch or the offer, ' +
          'after which the creator returns to the video\'s own content, signs off, or the video ends?',
        ...SPONSOR
      },
      criteria: endOptions
    }
  };
}

/**
 * Refine, request two: with the naming line known and in the state, read
 * backwards for the first line of the lead-in.
 */
export function startQuestions(lines: Line[]): Questions {
  const options: Record<string, string | null> = {};
  for (const line of lines) options[line.id] = null;

  return {
    start_line: {
      type: 'choice',
      instructions: {
        question:
          'The sponsor is named on the line given in `sponsor_named_at`. Reading backwards from that line, ' +
          'which labelled line is the FIRST line of the sponsor segment: the moment the creator leaves the ' +
          'subject of the video (`video_title`) and begins the lead-in that ends at the sponsor?',
        rules: [
          'The lead-in belongs to the sponsor segment from its first line, even when it sounds like a personal story, an anecdote, a problem or a question and the sponsor is only named minutes later.',
          'A lead-in exists to arrive at the sponsor: the story, problem or question it raises is what the sponsor answers.',
          'Lines that are still about the subject of the video are not part of the sponsor segment, even the ones immediately before it.',
          'Wrapping up the video, thanking hosts, guests, crew or viewers, and a closing call for comments, likes or subscriptions belong to the video, not to the sponsor segment, even right before the sponsor is named.',
          'If there is no lead-in and the segment opens by naming the sponsor, choose the line given in `sponsor_named_at`.'
        ],
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Search pass, one round: which group of the span still in play holds the
 * edge. Each round halves (or thirds) the candidates, so the edge costs about
 * log(n) questions rather than one per phrase.
 */
export function searchQuestions(
  phrases: Phrase[],
  bounds: [number, number][],
  edge: 'start' | 'end'
): Questions {
  // Each group needs the ids of the phrases it covers, and they have to be
  // stable across requests, so the state carries the parent's numbering and
  // every group names the phrases it holds.
  const criteria: Record<string, string | null> = {};
  bounds.forEach(([from, to], i) => {
    criteria[`group_${i}`] = `${edgeRange(phrases, from, to, edge)}`;
  });

  const labels = bounds.map((_, i) => `group_${i}`).join(', ');
  return {
    search_group: {
      type: 'choice',
      instructions: {
        question:
          `The sponsor segment's ${edge === 'start' ? 'first' : 'last'} phrase in \`phrases\` is in exactly one ` +
          `of the groups below. Which group holds it? Choose one of ${labels}.`,
        ...SPONSOR
      },
      criteria
    }
  };
}

/** A range of phrases, written out so the option stands alone. */
function edgeRange(phrases: Phrase[], from: number, to: number, edge: 'start' | 'end'): string {
  const span =
    from === to ? `phrase ${phrases[from].id} ("${phrases[from].text}")` : `phrases ${phrases[from].id} to ${phrases[to].id}`;
  return edge === 'start'
    ? `The sponsor segment begins at ${span}: ${phrases[from].id} is the first phrase that belongs to it.`
    : `The sponsor segment ends at ${span}: ${phrases[to].id} is the last phrase that belongs to it.`;
}

/**
 * Search pass, last round: is the phrase the search landed on really part of
 * the sponsor segment? The same judgment the census asks per phrase, put once
 * to the one phrase that matters, and what turns an answer into a cut.
 */
export function confirmQuestions(phrase: Phrase, edge: 'start' | 'end'): Questions {
  return {
    is_edge_phrase: {
      type: 'noul',
      instructions: {
        question:
          `Does phrase ${phrase.id} in \`phrases\` belong to the sponsor segment rather than to the video's own content? ` +
          `It is where the sponsor segment is thought to ${edge === 'start' ? 'begin' : 'end'}.`,
        ...SPONSOR
      },
      criteria: {
        true: `Phrase ${phrase.id} is part of the sponsor segment: its lead-in, its pitch or its offer.`,
        false: `Phrase ${phrase.id} is the video's own content: on the subject of the video (\`video_title\`), a hand-back, a sign-off, or a call to like, comment or subscribe.`
      }
    }
  };
}

/**
 * Cut pass: the lines at a boundary split into phrases of a few words, and
 * one noul per phrase: is this phrase part of the sponsor segment? Asking per
 * phrase rather than "which phrase is first" keeps each judgment narrow, and
 * the answers read as a profile that code cuts at (see cutPoint). Costs one
 * question per phrase, so the search pass above is the default.
 */
export function cutQuestions(phrases: Phrase[]): Questions {
  const questions: Questions = {};
  for (const phrase of phrases) {
    questions[phrase.id] = {
      type: 'noul',
      instructions: {
        question:
          `Does phrase ${phrase.id} in \`phrases\` belong to the sponsor segment rather than to the video's own content? ` +
          'The phrases are consecutive pieces of the transcript, a few words each; `before` and `after` are the ' +
          'surrounding transcript, and the sponsor is named at `sponsor_named_at_text`.',
        ...SPONSOR
      },
      criteria: {
        true: `Phrase ${phrase.id} is part of the sponsor segment: its lead-in, its pitch or its offer.`,
        false: `Phrase ${phrase.id} is the video's own content: on the subject of the video (\`video_title\`), a hand-back like "now back to the video", a sign-off, or a call to like, comment or subscribe.`
      }
    };
  }
  return questions;
}
