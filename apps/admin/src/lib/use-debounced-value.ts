'use client';

import * as React from 'react';

/** `value`, but only after it has stopped changing for `delayMs` (keeps a search box from firing a request per keystroke). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
