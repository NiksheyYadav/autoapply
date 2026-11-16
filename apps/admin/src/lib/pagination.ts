/**
 * The roster API pages forward only: each response carries an opaque
 * `next_cursor` and nothing else (no total, no "previous" cursor). To offer
 * "Previous" the client remembers the cursor that opened every page it has
 * visited. The cursors live in memory only.
 */
export interface PageState {
  /** `cursors[i]` opens page `i + 1`; the first page has no cursor. */
  cursors: readonly (string | null)[];
  index: number;
}

export function initialPageState(): PageState {
  return { cursors: [null], index: 0 };
}

export function currentCursor(state: PageState): string | null {
  return state.cursors[state.index] ?? null;
}

/** 1-based page number for display. */
export function pageNumber(state: PageState): number {
  return state.index + 1;
}

export function canGoBack(state: PageState): boolean {
  return state.index > 0;
}

/**
 * Moves to the next page given the `next_cursor` of the page on screen.
 * Without a cursor there is no next page and the state is returned unchanged.
 * Going forward after going back replaces the stale forward history.
 */
export function advance(state: PageState, nextCursor: string | null): PageState {
  if (nextCursor === null || nextCursor === '') return state;
  const cursors = [...state.cursors.slice(0, state.index + 1), nextCursor];
  return { cursors, index: state.index + 1 };
}

export function goBack(state: PageState): PageState {
  return canGoBack(state) ? { cursors: state.cursors, index: state.index - 1 } : state;
}
