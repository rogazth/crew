import { providerMark } from "./providerMarks";

export function ProviderIcon({
  provider,
  className = "size-4",
}: {
  provider: string;
  className?: string;
}) {
  const mark = providerMark(provider);
  if (!mark) return <span className={`${className} shrink-0`} />;
  if (mark.mask) {
    return (
      <span
        aria-hidden
        className={`${className} shrink-0 bg-icon`}
        style={{
          WebkitMask: `url("${mark.src}") center / contain no-repeat`,
          mask: `url("${mark.src}") center / contain no-repeat`,
        }}
      />
    );
  }
  return (
    <img src={mark.src} alt="" aria-hidden className={`${className} shrink-0`} />
  );
}
