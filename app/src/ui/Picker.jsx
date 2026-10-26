import { useEffect, useRef, useState } from 'react';
import Glyph from './Glyph.jsx';

/**
 * A choice that opens Darpan's own bottom sheet instead of the browser's
 * dropdown. `options` are strings or { value, label, hint }.
 */
export default function Picker({ value, options, onChange, label, title = label, variant = 'field', className = '' }) {
  const [open, setOpen] = useState(false);
  const list = options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  const current = list.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        className={`picker ${variant} ${className}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${label}: ${current?.label ?? 'not set'}`}
      >
        <span>{current?.label ?? 'Choose'}</span>
        <Glyph name="down" size={16} />
      </button>
      {open && (
        <PickerSheet
          title={title}
          options={list}
          value={value}
          onPick={(v) => {
            setOpen(false);
            if (v !== value) onChange(v);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PickerSheet({ title, options, value, onPick, onClose }) {
  const selectedRef = useRef(null);

  useEffect(() => {
    selectedRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet picker-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <ul role="listbox" aria-label={title}>
          {options.map((o) => (
            <li key={String(o.value)}>
              <button
                ref={o.value === value ? selectedRef : null}
                role="option"
                aria-selected={o.value === value}
                onClick={() => onPick(o.value)}
              >
                <span className="grow">
                  {o.label}
                  {o.hint && <small>{o.hint}</small>}
                </span>
                {o.value === value && <Glyph name="check" size={20} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
