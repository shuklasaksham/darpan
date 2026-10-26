// Darpan's icons: a 24 px grid, 2 px round strokes, and a marigold accent
// (the `.accent` parts) taken from the light in the logo's ring.

const A = 'accent';

const GLYPHS = {
  home: (
    <>
      <circle cx="10.5" cy="15" r="5.5" />
      <path d="M16 3.5V20.5" />
      <path className={`${A} fill`} d="M8.7 16.8A2.6 2.6 0 0 1 12.3 13.2Z" />
    </>
  ),
  recent: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12" />
      <path className={A} d="M12 12l3 2" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
    </>
  ),
  voice: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path className={A} d="M12 17.5V21" />
    </>
  ),
  idea: (
    <>
      <path d="M9 17.5h6M9.5 21h5" />
      <path d="M8.5 14.5a6 6 0 1 1 7 0c-.6.5-.5 1.3-.5 2.1V17.5H9v-.9c0-.8.1-1.6-.5-2.1Z" />
      <path className={A} d="M12 6.5a3 3 0 0 1 3 3" />
    </>
  ),
  script: (
    <>
      <path d="M6 3.5h8.5L18 7v13.5H6Z" />
      <path d="M9 11h6M9 14.5h6" />
      <path className={A} d="M9 18h3.5" />
    </>
  ),
  shoot: (
    <>
      <rect x="3" y="6.5" width="13" height="11" rx="3" />
      <path d="m16 10.5 5-3v9l-5-3" />
      <circle className={`${A} fill`} cx="7.5" cy="10.5" r="1.3" />
    </>
  ),
  frame: (
    <>
      <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />
      <circle className={A} cx="12" cy="12" r="2.5" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
      <path className={`${A} fill`} d="M8.8 15.2a4.5 4.5 0 0 1 6.4-6.4Z" />
    </>
  ),
  take: (
    <>
      <rect x="3.5" y="8" width="17" height="12" rx="2.5" />
      <path d="m3.5 8 2-4.5h13l2 4.5" />
      <path className={A} d="m9 3.5 2 4.5M14 3.5l2 4.5" />
    </>
  ),
  reel: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M3.5 8.5h17M3.5 15.5h17M8 3.5v5M16 3.5v5M8 15.5v5M16 15.5v5" />
      <path className={`${A} fill`} d="m10.5 10.3 3.5 1.7-3.5 1.7Z" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" />
      <path className={A} d="m13.5 6.5 4 4" />
    </>
  ),
  trim: (
    <>
      <path d="M8 4H5v16h3M16 4h3v16h-3" />
      <path className={A} d="M12 7v10" />
    </>
  ),
  share: (
    <>
      <path d="M12 14V3" />
      <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
      <path d="M5 12.5v5A3.5 3.5 0 0 0 8.5 21h7a3.5 3.5 0 0 0 3.5-3.5v-5" />
      <path className={A} d="M9 17h6" />
    </>
  ),
  save: (
    <>
      <path d="M12 3v11" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M5 14.5v3A3.5 3.5 0 0 0 8.5 21h7a3.5 3.5 0 0 0 3.5-3.5v-3" />
      <path className={A} d="M9 18h6" />
    </>
  ),
  pro: (
    <>
      <path d="M3.5 17.5h17" />
      <path className={`${A} fill`} d="M7 17.5a5 5 0 0 1 10 0Z" />
      <path d="M12 5.5v2M6 8l1.2 1.2M18 8l-1.2 1.2" />
    </>
  ),
  captions: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 11.5h5M14.5 11.5h2.5" />
      <path className={A} d="M7 15h10" />
    </>
  ),
  flip: (
    <>
      <path d="M19.5 9A8 8 0 0 0 5 7.5M4.5 15A8 8 0 0 0 19 16.5" />
      <path d="M19.5 4.5V9H15M4.5 19.5V15H9" />
    </>
  ),
  drag: <path d="M5 8h14M5 12h14M5 16h14" />,
  reshoot: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9" />
    </>
  ),
  play: <path className="fill" d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5Z" />,
  pause: <path d="M8.5 5v14M15.5 5v14" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M19 12H5M11 5l-7 7 7 7" />,
  next: <path d="M5 12h14M13 5l7 7-7 7" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m6 15 6-6 6 6" />,
  speaker: (
    <>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z" />
      <path className={A} d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  muted: (
    <>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5" />
      <circle className="fill" cx="12" cy="16.3" r="1" />
    </>
  ),
};

export default function Glyph({ name, size = 24, className = '', label }) {
  return (
    <svg
      className={`glyph ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {GLYPHS[name]}
    </svg>
  );
}
