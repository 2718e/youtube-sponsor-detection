// The contract every model provider must satisfy.
//
// The pipeline in ../decisionModel/ asks typed questions and reads probabilities back.
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

export interface QuestionInstructions {
  question: string;
  definition?: string;
  shape?: string;
  rules?: string[];
  [key: string]: unknown;
}

export interface Question {
  type: 'noul' | 'choice';
  instructions: QuestionInstructions;
  criteria: Record<string, string | null>;
}

export type Questions = Record<string, Question>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer;

export interface ProviderAnswer {
  answers: Record<string, Answer>;
  usage: Usage;
  model: string | null;
}

export interface CanonicalRequest {
  state: Record<string, unknown>;
  questions: Questions;
  model?: string;
}

/** The shape a raw provider reply may take before it is normalized. */
interface RawAnswer {
  noul?: unknown;
  probabilities?: Record<string, unknown>;
}

/**
 * Fill in the parts of an answer the pipeline is allowed to assume exist.
 */
export function normalizeAnswer(result: unknown, questions: Questions = {}): ProviderAnswer {
  const answers: Record<string, Answer> = {};
  const given = (result as { answers?: Record<string, RawAnswer> } | null | undefined)?.answers ?? {};

  for (const [name, question] of Object.entries(questions)) {
    const answer = given[name];
    if (question.type === 'choice') {
      const probabilities: Record<string, number> = {};
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
  const usage = (result as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null | undefined)?.usage;
  return {
    answers,
    usage: {
      input_tokens: Number(usage?.input_tokens) || 0,
      output_tokens: Number(usage?.output_tokens) || 0
    },
    model: (result as { model?: string | null } | null | undefined)?.model ?? null
  };
}

/** The noul probability of an answer, or 0 when it is not a noul answer. */
export function noulOf(answer: Answer | undefined): number {
  return answer?.type === 'noul' ? answer.noul : 0;
}

/** The distribution of an answer, or an empty one when it is not a choice answer. */
export function probabilitiesOf(answer: Answer | undefined): Record<string, number> {
  return answer?.type === 'choice' ? answer.probabilities : {};
}

/**
 * Throw when a provider broke the contract. Used by the contract test, and by
 * providers in development, so a half-finished adapter fails loudly.
 */
export function assertCanonical(result: ProviderAnswer, questions: Questions): ProviderAnswer {
  const where = 'provider answer';
  if (!result?.answers) throw new Error(`${where}: no answers`);
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers[name];
    if (!answer) throw new Error(`${where}: "${name}" is missing`);
    if (question.type === 'choice') {
      if (answer.type !== 'choice' || !answer.probabilities) {
        throw new Error(`${where}: "${name}" has no probabilities`);
      }
      for (const key of Object.keys(question.criteria ?? {})) {
        const p = answer.probabilities[key];
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          throw new Error(`${where}: "${name}.${key}" is not a probability (${p})`);
        }
      }
    } else {
      const p = answer.type === 'noul' ? answer.noul : NaN;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(`${where}: "${name}.noul" is not a probability (${p})`);
      }
    }
  }
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    if (!Number.isFinite(result.usage?.[field])) {
      throw new Error(`${where}: usage.${field} is not a number`);
    }
  }
  return result;
}
