import { Button, Sidebar, useSidebar } from "@cloudflare/kumo";
import { CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

type Props = {
  label: string;
  onAdd?: (() => void) | undefined;
  addHint?: string | undefined;
  collapsible?: boolean;
  children: ReactNode;
};

const HEADER = "flex min-w-0 flex-1 items-center gap-1 rounded-md pl-2 text-left text-kumo-subtle";

/** Sidebar group; the title is the trigger, the plus is a sibling so it never toggles. */
export function Section({ label, onAdd, addHint, collapsible = true, children }: Props) {
  const [open, setOpen] = useState(true);
  const { state } = useSidebar();

  // kumo folds Collapsible content away in icon mode (it targets submenus); top-level rows must stay.
  if (state === "collapsed") {
    return (
      <Sidebar.Group className="p-0 pt-1">
        <Sidebar.Menu className="gap-0.5">{children}</Sidebar.Menu>
      </Sidebar.Group>
    );
  }

  // Cursor keeps group actions out of the way until the pointer is over the group.
  const add = onAdd && (
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={PlusIcon}
      aria-label={`Add ${label}`}
      title={addHint}
      onClick={onAdd}
      className="size-6 opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 [&_svg]:size-4"
    />
  );

  if (!collapsible) {
    return (
      <Sidebar.Group className="group/section p-0 pt-3 first:pt-0">
        <div className="flex h-8 items-center gap-1">
          <span className={`${HEADER} truncate`}>{label}</span>
          {add}
        </div>
        <Sidebar.Menu className="gap-0.5">{children}</Sidebar.Menu>
      </Sidebar.Group>
    );
  }

  return (
    <Sidebar.Group className="group/section p-0 pt-3 first:pt-0">
      <Sidebar.Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex h-8 items-center gap-1">
          <Sidebar.CollapsibleTrigger
            render={
              <button className={`${HEADER} transition-colors hover:text-kumo-default`}>
                <span className="truncate">{label}</span>
                <CaretRightIcon
                  className={`size-3 shrink-0 transition-[transform,opacity] ${
                    open ? "rotate-90 opacity-0 group-hover/section:opacity-100" : ""
                  }`}
                />
              </button>
            }
          />
          {add}
        </div>
        <Sidebar.CollapsibleContent>
          <Sidebar.Menu className="gap-0.5">{children}</Sidebar.Menu>
        </Sidebar.CollapsibleContent>
      </Sidebar.Collapsible>
    </Sidebar.Group>
  );
}
