'use client';

import { Button, MagneticHover, type ButtonProps } from '@atlas/ui';
import * as React from 'react';
import { useTransitionNavigate } from './TransitionProvider';

export interface TransitionLinkProps extends Omit<ButtonProps, 'asChild' | 'onClick'> {
  href: string;
  children: React.ReactNode;
}

/** A primary CTA that triggers the expand-and-reveal transition instead of a plain navigation. */
export function TransitionLink({ href, children, ...buttonProps }: TransitionLinkProps) {
  const navigate = useTransitionNavigate();

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    // Modified clicks (new tab, new window, "save link as", middle-click) keep
    // native anchor behavior instead of being hijacked into the transition.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(href, event);
  }

  return (
    <MagneticHover>
      <Button asChild {...buttonProps}>
        <a href={href} onClick={handleClick}>
          {children}
        </a>
      </Button>
    </MagneticHover>
  );
}
