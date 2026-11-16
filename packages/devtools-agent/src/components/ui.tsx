// Composition follows shadcn/ui's Radix patterns. See THIRD_PARTY.md for sources and licenses.
import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react';
import { Dialog, Tooltip, Tabs, ScrollArea, Collapsible } from 'radix-ui';
import { X } from 'lucide-react';
import clsx from 'clsx';

export function Button({
  className,
  variant = 'default',
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}) {
  return (
    <button type="button" {...props} className={clsx('button', `button-${variant}`, className)} />
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button {...props} variant="ghost" className="icon-button" aria-label={label}>
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  sheet = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  sheet?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={clsx('dialog-content', sheet && 'sheet')}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="dialog-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="Close">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className={description ? 'muted' : 'sr-only'}>
            {description ?? title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Scroller({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollArea.Root className={clsx('scroll-area', className)}>
      <ScrollArea.Viewport className="scroll-viewport">{children}</ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
        <ScrollArea.Thumb className="scroll-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
export { Tooltip, Tabs, Collapsible };
