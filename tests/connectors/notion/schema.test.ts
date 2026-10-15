import { describe, expect, it } from 'vitest';
import { schemaProblems } from '../../../src/connectors/notion/schema.js';
import { COLLECTION_PROPERTIES } from './fake-client.js';

describe('schemaProblems', () => {
  it('accepts the collection schema, with extra properties', () => {
    expect(schemaProblems(COLLECTION_PROPERTIES)).toEqual([]);
    expect(schemaProblems({ ...COLLECTION_PROPERTIES, Rating: { type: 'number' } })).toEqual([]);
  });

  it('reports every missing or mistyped property', () => {
    const { Metadata: _metadata, ...rest } = COLLECTION_PROPERTIES;
    expect(schemaProblems({ ...rest, Tags: { type: 'select' } })).toEqual([
      'property "Tags" is select, expected multi_select',
      'missing property "Metadata" (rich_text)',
    ]);
  });

  it('is case-sensitive about names', () => {
    const { Name: _name, ...rest } = COLLECTION_PROPERTIES;
    expect(schemaProblems({ ...rest, name: { type: 'title' } })).toEqual(['missing property "Name" (title)']);
  });

  it('explains a Status property of Notion\'s status type', () => {
    expect(schemaProblems({ ...COLLECTION_PROPERTIES, Status: { type: 'status' } })).toEqual([
      'property "Status" is status, expected select (Notion\'s Status type cannot hold free-form values; use a Select property)',
    ]);
  });
});
