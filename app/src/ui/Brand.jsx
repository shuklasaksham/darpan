// The Darpan mark (a ring and a stem, the "d") and the wordmark built from it:
// the mark is the d of "darpan", its ring the height of the lowercase letters.

export function Mark({ className = '', title }) {
  return (
    <svg className={`mark ${className}`} viewBox="0 0 60 90" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <g transform="translate(0 -10)">
        <g fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round">
          <circle cx="30" cy="70" r="24" />
          <path d="M54 16V94" />
        </g>
        <path className="mark-light" d="M22.22 77.78A11 11 0 0 1 37.78 62.22Z" />
      </g>
    </svg>
  );
}

export function Wordmark({ className = '' }) {
  return (
    <span className={`wordmark ${className}`} aria-label="darpan" role="img">
      <Mark />
      <span aria-hidden="true">arpan</span>
    </span>
  );
}
