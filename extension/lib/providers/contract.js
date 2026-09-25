// The contract every model provider must satisfy.
//
// The pipeline in ../jev.js asks typed questions and reads probabilities back.
// That request/answer shape is the project's own language: nothing below this
// file knows which server, model or protocol answered. A provider's only job is
// to turn a canonical request into whatever its wire format is, and turn the
// reply back into the canonical answer.
//
// Canonical request:
//   { state: object, questions: { name: { type: 'noul'|'choice',
//       instructions: object, criteria: object } }, model?: string }
//
// Canonical answer:
//   { answers: { name: { noul: number } | { probabilities: { key: number } } },
//     usage: { input_tokens: number, output_tokens: number } }
//
// The rules a provider has to keep, whatever it does internally:
//   - every question name in the request gets an entry in answers
//   - noul is a probability in [0, 1]
//   - choice is a distribution over the question's own criteria keys; a key
//     that is missing counts as 0, so an adapter may omit near-zero labels
//   - usage is best effort: missing counts are reported as 0, never as NaN
//
// `normalizeAnswer` enforces the rules so an adapter can be loose about them,
// and `assertCanonical` is the same contract as a test-time check.

/** @typedef {{ noul: number }} NoulAnswer */
/** @typedef {{ probabilities: Record<string, number> }} ChoiceAnswer */
/** @typedef {NoulAnswer | ChoiceAnswer} Answer */

/**
 * Fill in the parts of an answer the pipeline is allowed to assume exist.
 * @param {any} result
 * @param {Record<string, { type: string, criteria?: Record<string, unknown> }>} [questions]
 */
export function normalizeAnswer(result, questions) {
  const answers = {};
  const given = result?.answers ?? {};

  for (const [name, question] of Object.entries(questions ?? {})) {
    const answer = given[name];
    if (question.type === 'choice') {
      const probabilities = {};
      for (const key of Object.keys(question.criteria ?? {})) {
        const p = Number(answer?.probabilities?.[key]);
        probabilities[key] = Number.isFinite(p) ? p : 0;
      }
      answers[name] = { type: 'choice', probabilities };
    } else {
      const p = Number(answer?.noul);
      answers[name] = { type: 'noul', noul: Number.isFinite(p) ? p : 0 };
    }
  }

  // Answers to questions the provider invented are dropped, not merged in: the
  // pipeline indexes answers by the names it asked for.
  return {
    answers,
    usage: {
      input_tokens: Number(result?.usage?.input_tokens) || 0,
      output_tokens: Number(result?.usage?.output_tokens) || 0
    },
    model: result?.model ?? null
  };
}

/**
 * Throw when a provider broke the contract. Used by the contract test, and by
 * providers in development, so a half-finished adapter fails loudly.
 * @param {any} result
 * @param {Record<string, { type: string, criteria?: Record<string, unknown> }>} questions
 */
export function assertCanonical(result, questions) {
  const where = 'provider answer';
  if (!result?.answers) throw new Error(`${where}: no answers`);
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers[name];
    if (!answer) throw new Error(`${where}: "${name}" is missing`);
    if (question.type === 'choice') {
      const probabilities = answer.probabilities;
      if (!probabilities || typeof probabilities !== 'object') {
        throw new Error(`${where}: "${name}" has no probabilities`);
      }
      for (const key of Object.keys(question.criteria ?? {})) {
        const p = probabilities[key];
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          throw new Error(`${where}: "${name}.${key}" is not a probability (${p})`);
        }
      }
    } else {
      const p = answer.noul;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(`${where}: "${name}.noul" is not a probability (${p})`);
      }
    }
  }
  for (const field of ['input_tokens', 'output_tokens']) {
    if (!Number.isFinite(result.usage?.[field])) {
      throw new Error(`${where}: usage.${field} is not a number`);
    }
  }
  return result;
}
