import { describe, expect, it } from 'vitest';
import { choiceQuestion, validateDecisionResponse } from '../src/ai.js';
import { moneyCandidates } from '../src/taxonomy.js';

const questions = { intent: choiceQuestion('Classifique', { sale: 'Venda', unknown: 'Inconclusivo' }) };
describe('typed decision validation', () => {
  it('accepts only the declared answer types and labels', () => {
    expect(validateDecisionResponse({ model: 'jev', answers: { intent: { type: 'choice', choice: 'sale', confidence: 1, probabilities: { sale: 1, unknown: 0 } } }, usage: { cost: 1 } }, questions).answers.intent).toMatchObject({ choice: 'sale' });
  });
  it('rejects invented labels, missing answers and invalid distributions', () => {
    expect(() => validateDecisionResponse({ model: 'jev', answers: {} }, questions)).toThrow('ai_missing_answer');
    expect(() => validateDecisionResponse({ model: 'jev', answers: { intent: { type: 'choice', choice: 'hacked', confidence: 1, probabilities: { sale: 1, unknown: 0 } } } }, questions)).toThrow('ai_invalid_choice');
    expect(() => validateDecisionResponse({ model: 'jev', answers: { intent: { type: 'choice', choice: 'sale', confidence: 1, probabilities: { sale: 1, unknown: 1 } } } }, questions)).toThrow('ai_invalid_probabilities');
  });
  it('does not store provider billing data', () => {
    const result = validateDecisionResponse({ model: 'jev', answers: { intent: { type: 'choice', choice: 'sale', confidence: 1, probabilities: { sale: 1, unknown: 0 } } }, usage: { cost: 1 } }, questions);
    expect(result).not.toHaveProperty('usage');
  });
});

describe('money candidates preserve exact evidence', () => {
  it('handles Brazilian currency without floating point arithmetic', () => {
    expect(moneyCandidates('R$ 1.234,56 e R$ 1000 e R$ 0,10').map(candidate => candidate.decimal)).toEqual(['1234.56', '1000.00', '0.10']);
  });
  it('uses Unicode codepoint offsets', () => {
    const text = '👋 Valor R$ 12,50';
    const candidate = moneyCandidates(text)[0]!;
    expect([...text].slice(candidate.start, candidate.end).join('')).toBe('R$ 12,50');
  });
  it('does not infer currency for arbitrary telephone numbers', () => {
    expect(moneyCandidates('11999999999; encontro às 20')).toEqual([]);
  });
});
