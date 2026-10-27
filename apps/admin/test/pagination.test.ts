import { describe, expect, it } from 'vitest';
import {
  advance,
  canGoBack,
  currentCursor,
  goBack,
  initialPageState,
  pageNumber,
} from '../src/lib/pagination';

describe('cursor pagination state', () => {
  it('starts on page 1 with no cursor and cannot go back', () => {
    const state = initialPageState();
    expect(pageNumber(state)).toBe(1);
    expect(currentCursor(state)).toBeNull();
    expect(canGoBack(state)).toBe(false);
  });

  it('advances using the next_cursor of the page on screen', () => {
    const second = advance(initialPageState(), 'cursor-2');
    expect(pageNumber(second)).toBe(2);
    expect(currentCursor(second)).toBe('cursor-2');
    expect(canGoBack(second)).toBe(true);
  });

  it('does not move when there is no next cursor', () => {
    const state = initialPageState();
    expect(advance(state, null)).toBe(state);
    expect(advance(state, '')).toBe(state);
  });

  it('goes back to the cursor that opened the previous page', () => {
    let state = initialPageState();
    state = advance(state, 'c2');
    state = advance(state, 'c3');
    expect(currentCursor(state)).toBe('c3');

    state = goBack(state);
    expect(pageNumber(state)).toBe(2);
    expect(currentCursor(state)).toBe('c2');

    state = goBack(state);
    expect(pageNumber(state)).toBe(1);
    expect(currentCursor(state)).toBeNull();
  });

  it('stays on page 1 when asked to go back from it', () => {
    const state = initialPageState();
    expect(goBack(state)).toBe(state);
  });

  it('drops the stale forward history when going forward after going back', () => {
    let state = initialPageState();
    state = advance(state, 'c2');
    state = advance(state, 'c3');
    state = goBack(state);
    state = advance(state, 'c3-fresh');

    expect(pageNumber(state)).toBe(3);
    expect(currentCursor(state)).toBe('c3-fresh');
    expect(state.cursors).toEqual([null, 'c2', 'c3-fresh']);
  });

  it('never mutates the state it was given', () => {
    const before = initialPageState();
    const snapshot = JSON.stringify(before);
    advance(before, 'c2');
    goBack(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
