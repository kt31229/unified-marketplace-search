import { useEffect, useRef, useState } from 'react';

export interface SaveSearchDialogProps {
  open: boolean;
  defaultName: string;
  isSaving?: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}

export function SaveSearchDialog({
  open,
  defaultName,
  isSaving = false,
  onSave,
  onCancel,
}: SaveSearchDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
    }
  }, [open, defaultName]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute('open', '');
      }
    } else if (dialog.open || dialog.hasAttribute('open')) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="ums-dialog"
      aria-labelledby="save-search-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) {
            setError('Saved Search name is required.');
            return;
          }
          onSave(trimmed);
        }}
      >
        <h3 id="save-search-dialog-title" className="m-0 text-base font-semibold text-slate-900">
          Save Search
        </h3>
        <label className="mt-3 mb-3 flex flex-col gap-1 text-xs font-medium text-slate-700">
          <span>Saved Search name</span>
          <input
            type="text"
            aria-label="Saved Search name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            autoFocus
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          />
        </label>
        {error && (
          <div role="alert" className="validation-msg mb-3">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
