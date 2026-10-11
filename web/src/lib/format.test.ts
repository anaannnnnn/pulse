import { describe, it, expect } from 'vitest';
import { strategyLabel } from './format';

describe('strategyLabel', () => {
  it('maps cascade strategy ids to readable labels', () => {
    expect(strategyLabel('parse')).toBe('Filename parser');
    expect(strategyLabel('studio+date')).toBe('Studio + date');
    expect(strategyLabel('words')).toBe('Word-by-word');
    expect(strategyLabel('hash')).toBe('File hash');
    expect(strategyLabel('something-new')).toBe('something-new');
    expect(strategyLabel(null)).toBe('');
  });
});
