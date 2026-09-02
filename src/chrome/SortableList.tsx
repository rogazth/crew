import { PointerActivationConstraints } from "@dnd-kit/dom";
import { move } from "@dnd-kit/helpers";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { memo, type ReactNode } from "react";

const SENSORS = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
];

type ListProps = {
  ids: string[];
  disabled?: boolean;
  onReorder: (ids: string[]) => void;
  children: ReactNode;
};

/** One sortable group. Visual reorder is optimistic; we persist the id list on drop. */
export function SortableList({ ids, disabled, onReorder, children }: ListProps) {
  return (
    <DragDropProvider
      sensors={SENSORS}
      onDragEnd={(event) => {
        if (event.canceled || disabled) return;
        const next = move(ids, event);
        if (next.length === ids.length && next.every((id, index) => id === ids[index])) return;
        onReorder(next);
      }}
    >
      {children}
    </DragDropProvider>
  );
}

type ItemProps = {
  id: string;
  index: number;
  group: string;
  disabled?: boolean;
  children: ReactNode;
};

export const SortableItem = memo(function SortableItem({
  id,
  index,
  group,
  disabled,
  children,
}: ItemProps) {
  const { ref, isDragging } = useSortable({
    id,
    index,
    group,
    type: group,
    accept: group,
    ...(disabled ? { disabled: true } : {}),
  });

  return (
    <div ref={ref} className={`touch-none ${isDragging ? "opacity-40" : ""}`}>
      {children}
    </div>
  );
});
