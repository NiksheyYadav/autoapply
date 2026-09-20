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
  return (
    <MagneticHover>
      <Button {...buttonProps} onClick={(event) => navigate(href, event)}>
        {children}
      </Button>
    </MagneticHover>
  );
}
