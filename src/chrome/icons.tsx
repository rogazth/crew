/** Inline 16px stroke icons. Local SVG keeps the icon catalog out of the bundle. */
type Props = { className?: string };

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Search = ({ className }: Props) => (
  <svg {...base} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const Plus = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const X = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const Bot = ({ className }: Props) => (
  <svg {...base} className={className}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4M9 14h.01M15 14h.01" />
  </svg>
);

export const Terminal = ({ className }: Props) => (
  <svg {...base} className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </svg>
);

export const FileIcon = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M14 3v5h5" />
    <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" />
  </svg>
);

export const Folder = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const Chevron = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const Settings = ({ className }: Props) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V8a1.7 1.7 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export const Send = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const Square = ({ className }: Props) => (
  <svg {...base} className={className}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const Pencil = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

export const Trash = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
);

export const ChevronDown = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const Check = ({ className }: Props) => (
  <svg {...base} className={className}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const Spinner = ({ className }: Props) => (
  <svg viewBox="0 0 24 24" className={`${className} animate-spin`} fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);

export const Ellipsis = ({ className }: Props) => (
  <svg {...base} className={className}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </svg>
);
