export type CardBits = number;
export type QueryOperator = '==' | '!=' | '>' | '<' | '>=';

export const SHAPE_MASK = 0b000000000111;
export const SHAPE_CIRCLE = 1 << 0;
export const SHAPE_TRIANGLE = 1 << 1;
export const SHAPE_SQUARE = 1 << 2;

export const COLOR_MASK = 0b000000111000;
export const COLOR_RED = 1 << 3;
export const COLOR_BLUE = 1 << 4;
export const COLOR_YELLOW = 1 << 5;

export const FILL_MASK = 0b000111000000;
export const FILL_SOLID = 1 << 6;
export const FILL_STRIPED = 1 << 7;
export const FILL_OUTLINE = 1 << 8;

export const SHAPES = [
  { label: '원', value: SHAPE_CIRCLE, symbol: '●' },
  { label: '세모', value: SHAPE_TRIANGLE, symbol: '▲' },
  { label: '네모', value: SHAPE_SQUARE, symbol: '■' },
];

export const COLORS = [
  { label: '빨강', value: COLOR_RED, className: 'red' },
  { label: '파랑', value: COLOR_BLUE, className: 'blue' },
  { label: '노랑', value: COLOR_YELLOW, className: 'yellow' },
];

export const FILLS = [
  { label: '채움', value: FILL_SOLID },
  { label: '줄무늬', value: FILL_STRIPED },
  { label: '윤곽', value: FILL_OUTLINE },
];

export interface GameConfig {
  slots: number;
  attributes: number;
}

export type Query =
  | { type: 'POSITION_CHECK'; slotIndex: number; mask: number }
  | {
      type: 'COUNT_COMPARE';
      mask: number;
      operator: QueryOperator;
      compareValue: number;
    }
  | {
      type: 'RELATION_EQ';
      compareIndices: [number, number];
      attributeGroupMask: number;
    };

export function makeRandom(seed: string): () => number {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }

  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSecret(seed: string, config: GameConfig): CardBits[] {
  const random = makeRandom(`${seed}:${config.slots}:${config.attributes}`);
  const attributes: Array<Array<{ value: number }>> = [COLORS];
  if (config.attributes >= 2) attributes.push(SHAPES);
  if (config.attributes >= 3) attributes.push(FILLS);

  return Array.from({ length: config.slots }, () =>
    attributes.reduce((card, choices) => {
      const choice = choices[Math.floor(random() * choices.length)];
      return card | choice.value;
    }, 0),
  );
}

export function evaluateQuery(secret: CardBits[], query: Query): boolean {
  switch (query.type) {
    case 'POSITION_CHECK':
      return (
        Number.isInteger(query.slotIndex) &&
        query.slotIndex >= 0 &&
        query.slotIndex < secret.length &&
        query.mask > 0 &&
        (secret[query.slotIndex] & query.mask) !== 0
      );
    case 'COUNT_COMPARE': {
      if (query.mask <= 0 || !Number.isInteger(query.compareValue)) return false;
      const count = secret.filter((card) => (card & query.mask) !== 0).length;
      switch (query.operator) {
        case '==':
          return count === query.compareValue;
        case '!=':
          return count !== query.compareValue;
        case '>':
          return count > query.compareValue;
        case '<':
          return count < query.compareValue;
        case '>=':
          return count >= query.compareValue;
      }
    }
    case 'RELATION_EQ': {
      const [first, second] = query.compareIndices;
      if (
        first < 0 ||
        second < 0 ||
        first >= secret.length ||
        second >= secret.length ||
        query.attributeGroupMask <= 0
      ) {
        return false;
      }
      return (
        (secret[first] & query.attributeGroupMask) ===
        (secret[second] & query.attributeGroupMask)
      );
    }
  }
}
