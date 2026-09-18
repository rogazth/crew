import { useStore } from "@/lib/store";

export function Toaster() {
  const { toasts } = useStore();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="enter-pop rounded-control bg-overlay px-3.5 py-2 text-base text-ink el-3">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
