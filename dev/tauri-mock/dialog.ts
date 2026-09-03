let picks = 0;

/** Alternates a screenshot and a source file so both chip kinds show up. */
export const open = async () =>
  picks++ % 2 === 0 ? `/Users/me/Desktop/screenshot-${Date.now()}.png` : `/Users/me/Developer/picked-${Date.now()}.ts`;
