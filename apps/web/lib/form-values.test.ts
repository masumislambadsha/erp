import { describe, expect, it } from 'vitest';
import type { FormField } from '@erp/meta';
import { fromValues, showCell, toPayload } from './form-values.js';

const L = { en: 'x', bn: 'x' };
const f = (name: string, type: FormField['type']): FormField => ({
  name,
  label: L,
  type,
  required: false,
  attrs: {},
});
const fields = [
  f('title', 'text'),
  f('fee', 'money'),
  f('rooms', 'number'),
  f('urgent', 'boolean'),
  f('due', 'date'),
];

describe('form values', () => {
  it('sends money and dates as strings, numbers as numbers, and leaves empty fields out', () => {
    expect(
      toPayload(fields, { title: 'Roof', fee: '1250.50', rooms: '3', urgent: true, due: '' }),
    ).toEqual({ title: 'Roof', fee: '1250.50', rooms: 3, urgent: true });
    expect(toPayload(fields, { title: '', fee: '', rooms: '', urgent: false, due: '' })).toEqual(
      {},
    );
  });
  it('never turns money into a number', () => {
    expect(typeof toPayload(fields, { fee: '0.10' }).fee).toBe('string');
  });
  it('round-trips stored values into inputs', () => {
    const state = fromValues(fields, { title: 'Roof', fee: '1250.50', rooms: 3, urgent: true });
    expect(state).toEqual({ title: 'Roof', fee: '1250.50', rooms: '3', urgent: true, due: '' });
    expect(toPayload(fields, state)).toEqual({
      title: 'Roof',
      fee: '1250.50',
      rooms: 3,
      urgent: true,
    });
  });
  it('shows cells', () => {
    expect([
      showCell(undefined),
      showCell(true),
      showCell(false),
      showCell('a'),
      showCell(2),
    ]).toEqual(['', '✓', '', 'a', '2']);
  });
});
