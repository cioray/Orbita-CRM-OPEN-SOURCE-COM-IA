import { z } from 'zod';
import { AppError } from './util.js';
import { JEV_MODEL, JEV_PROVIDER } from './config.js';

export interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface NoulQuestion { type: 'noul'; instructions: string }
export type Question = ChoiceQuestion | NoulQuestion;
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | NoulAnswer;
export interface DecisionResult { model: string; answers: Record<string, Answer>; requestId: string | null; provider: string | null }

const probability = z.number().finite().min(0).max(1);
const Choice = z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), probability), confidence: probability });
const Noul = z.object({ type: z.literal('noul'), noul: probability });
const Response = z.object({ model: z.string().min(1), answers: z.record(z.string(), z.union([Choice, Noul])), id: z.string().optional(), provider: z.string().optional() });

export function validateDecisionResponse(value: unknown, questions: Record<string, Question>): DecisionResult {
  const parsed = Response.safeParse(value);
  if (!parsed.success) throw new AppError('ai_invalid_response', 502, true);
  for (const [name, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[name];
    if (!answer || answer.type !== question.type) throw new AppError('ai_missing_answer', 502, true);
    if (answer.type === 'choice' && question.type === 'choice') {
      if (!(answer.choice in question.criteria) || Object.keys(answer.probabilities).some(option => !(option in question.criteria)) || Object.keys(question.criteria).some(option => !(option in answer.probabilities))) throw new AppError('ai_invalid_choice', 502, true);
      const sum = Object.values(answer.probabilities).reduce((total, amount) => total + amount, 0);
      if (Math.abs(sum - 1) > 0.02) throw new AppError('ai_invalid_probabilities', 502, true);
    }
  }
  return { model: parsed.data.model, answers: parsed.data.answers, requestId: parsed.data.id ?? null, provider: parsed.data.provider ?? null };
}

export async function decide(provider: string, model: string, state: unknown, questions: Record<string, Question>): Promise<DecisionResult> {
  if (provider !== JEV_PROVIDER || model !== JEV_MODEL) throw new AppError('configuration_jev_fixed_model', 503);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AppError('configuration_openrouter_key_missing', 503);
  const url = 'https://openrouter.ai/api/alpha/decisions';
  let response: globalThis.Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(60000), redirect: 'error' });
  } catch { throw new AppError('ai_network_error', 502, true); }
  if (!response.ok) throw new AppError(response.status === 401 || response.status === 403 ? `configuration_${provider}_credentials` : `ai_http_${response.status}`, 502, response.status === 429 || response.status >= 500);
  return validateDecisionResponse(await response.json(), questions);
}

export const choiceQuestion = (instructions: string, criteria: Record<string, string>): ChoiceQuestion => ({ type: 'choice', instructions, criteria });
export const chosen = (answer: Answer | undefined): string => answer?.type === 'choice' ? answer.choice : 'unknown';
export const confidence = (answer: Answer | undefined): number => answer?.type === 'choice' ? answer.confidence : 0;

export async function generateText(provider: string, model: string, content: unknown[]): Promise<string> {
  if (provider === 'openrouter') throw new AppError('configuration_media_openrouter_disallowed', 503);
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : undefined;
  if (!key || !model) throw new AppError(`configuration_${provider}_media_missing`, 503);
  throw new AppError(`configuration_${provider}_media_adapter`, 503);
}
