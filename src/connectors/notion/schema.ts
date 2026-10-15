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

/**
 * Every way the data source's properties differ from the collection schema; empty when they match.
 * Extra properties are allowed.
 */
export function schemaProblems(properties: Readonly<Record<string, { type: string }>>): string[] {
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
  return problems;
}
