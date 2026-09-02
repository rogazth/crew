import { Button } from "@cloudflare/kumo";

type Props = {
  title: string;
  action?: { label: string; onClick: () => void };
};

export function EmptyState({ title, action }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-placeholder">{title}</p>
      {action && (
        <Button variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
