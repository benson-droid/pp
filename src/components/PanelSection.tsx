import { useState } from 'react';

interface PanelSectionProps {
  title: string;
  /** Collapsed by default — used for the sections most edits never touch,
   * so the panel opens at a manageable length. */
  defaultOpen?: boolean;
  /** Shows a dot next to the title when this section holds non-default
   * settings, so collapsed sections still advertise that something's on. */
  modified?: boolean;
  /** Optional control rendered on the right of the header (e.g. a reset). */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/** A collapsible group in the adjustment panel. */
export default function PanelSection({
  title,
  defaultOpen = true,
  modified = false,
  action,
  children,
}: PanelSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`panel-section${open ? ' open' : ''}`}>
      <div className="panel-section-header">
        <button type="button" className="panel-section-toggle" onClick={() => setOpen((v) => !v)}>
          <span className={`panel-caret${open ? ' open' : ''}`} aria-hidden>
            ▸
          </span>
          <span className="panel-section-title">{title}</span>
          {modified && <span className="panel-modified-dot" title="Modified" />}
        </button>
        {action && <div className="panel-section-action">{action}</div>}
      </div>
      {open && <div className="panel-section-body">{children}</div>}
    </div>
  );
}
