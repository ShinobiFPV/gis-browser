import { describe, expect, it } from 'vitest';
import { parsePrompt } from './parse';

describe('parsePrompt', () => {
  it('extracts the place name from the brief’s own example', () => {
    const p = parsePrompt('Give me the outline shape for Parry Island First Nation');
    // The full name must survive, because "First Nation" is part of it.
    expect(p.placeNames).toContain('parry island first nation');
    expect(p.featureTypeHint).toBe('indian_reserve');
    expect(p.via).toBe('keyword');
  });

  it('also offers the type-stripped form, since the qualifier may not be part of the name', () => {
    const p = parsePrompt('the federal riding of Parry Sound—Muskoka');
    expect(p.placeNames[0]).toBe('parry sound-muskoka');
    expect(p.featureTypeHint).toBe('federal_electoral_district');
  });

  it('keeps both forms so a wrong guess costs nothing', () => {
    const p = parsePrompt('Parry Island First Nation');
    expect(p.placeNames).toContain('parry island');
    expect(p.placeNames).toContain('parry island first nation');
  });

  it('prefers the longest matching type phrase', () => {
    expect(parsePrompt('provincial electoral district of Toronto Centre').featureTypeHint).toBe(
      'provincial_electoral_district',
    );
    expect(parsePrompt('federal electoral district of Toronto Centre').featureTypeHint).toBe(
      'federal_electoral_district',
    );
    // A bare "riding" means federal in Canadian newsroom usage.
    expect(parsePrompt('the riding of Sudbury').featureTypeHint).toBe('federal_electoral_district');
  });

  it('recognises a province and removes it from the name', () => {
    const p = parsePrompt('every reserve in Ontario');
    expect(p.jurisdictionHint).toBe('ON');
    expect(p.featureTypeHint).toBe('indian_reserve');
    expect(p.placeNames[0]).toBe('every');
  });

  it('recognises a two-letter province code standing alone', () => {
    expect(parsePrompt('school districts in BC').jurisdictionHint).toBe('BC');
  });

  it('does not mistake a province code buried in a word', () => {
    // "Onaping" starts with "on" but is not Ontario.
    expect(parsePrompt('Onaping Falls').jurisdictionHint).toBeNull();
  });

  it('picks up a vintage year and a representation order', () => {
    expect(parsePrompt('federal ridings, 2023 representation order').vintageHint).toBe('2023 representation order');
    expect(parsePrompt('census subdivisions 2021').vintageHint).toBe('2021');
  });

  it('strips request boilerplate', () => {
    for (const prompt of [
      'I need the boundary of Nunavut',
      'show me the outline of Nunavut',
      'please give me Nunavut',
      'Nunavut',
    ]) {
      expect(parsePrompt(prompt).placeNames[0], prompt).toBe('nunavut');
    }
  });

  it('normalises em dashes and accents the same way the aliases were stored', () => {
    expect(parsePrompt('Thunder Bay—Supérieur-Nord').placeNames[0]).toBe('thunder bay-superieur-nord');
  });

  it('never returns an empty place name', () => {
    for (const prompt of ['', '   ', 'give me the outline of']) {
      for (const n of parsePrompt(prompt).placeNames) expect(n.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('reports what it recognised, so a bad parse is visible in the UI', () => {
    expect(parsePrompt('federal riding of Sudbury in Ontario').notes).toMatch(/type|jurisdiction/);
    expect(parsePrompt('Sudbury').notes).toMatch(/no hints/);
  });

  it('de-duplicates identical variants', () => {
    const p = parsePrompt('Nunavut');
    expect(new Set(p.placeNames).size).toBe(p.placeNames.length);
  });
});
