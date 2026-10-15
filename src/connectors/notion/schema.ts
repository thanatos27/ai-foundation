import { CollectionTypeSchema } from '../../domain/index.js';

/** Names of the collection data source properties (spec Phase 3 §Properties). Case-sensitive. */
export const PROPERTY = {
  title: 'Name',
  collectionType: 'Type',
  status: 'Status',
  tags: 'Tags',
  metadata: 'Metadata',
} as const;

const EXPECTED_TYPES: readonly (readonly [name: string, type: string])[] = [
  [PROPERTY.title, 'title'],
  [PROPERTY.collectionType, 'select'],
  [PROPERTY.status, 'select'],
  [PROPERTY.tags, 'multi_select'],
  [PROPERTY.metadata, 'rich_text'],
];

/** A data source property as `dataSources.retrieve` returns it (only the parts checked here). */
export interface DataSourceProperty {
  type: string;
  select?: { options?: readonly { name: string }[] };
}

/**
 * Every way the data source's properties differ from the collection schema; empty when they match.
 * Extra properties are allowed.
 */
export function schemaProblems(properties: Readonly<Record<string, DataSourceProperty>>): string[] {
  const problems: string[] = [];
  for (const [name, type] of EXPECTED_TYPES) {
    const actual = properties[name]?.type;
    if (actual === undefined) {
      problems.push(`missing property "${name}" (${type})`);
    } else if (actual !== type) {
      const hint =
        name === PROPERTY.status && actual === 'status'
          ? ' (Notion\'s Status type cannot hold free-form values; use a Select property)'
          : '';
      problems.push(`property "${name}" is ${actual}, expected ${type}${hint}`);
    }
  }
  problems.push(...typeOptionProblems(properties[PROPERTY.collectionType]));
  return problems;
}

/**
 * Type options that differ from a collection type only in case (e.g. `Book`). Notion option names
 * are unique regardless of case and writing `book` reuses `Book`, so the item would be saved under a
 * Type that reads back as invalid: the write would fail after the fact and a retry would duplicate it.
 */
function typeOptionProblems(property: DataSourceProperty | undefined): string[] {
  if (property?.type !== 'select') return [];
  return (property.select?.options ?? []).flatMap(({ name }) => {
    const expected = CollectionTypeSchema.options.find((type) => type === name.toLowerCase());
    return expected && expected !== name
      ? [`option "${name}" of property "${PROPERTY.collectionType}" must be spelled "${expected}" (rename it in Notion)`]
      : [];
  });
}
