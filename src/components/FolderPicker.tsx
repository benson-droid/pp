import { isFileSystemAccessSupported } from '../lib/fileAccess';

interface FolderPickerProps {
  onPick: () => void;
  error: string | null;
}

export default function FolderPicker({ onPick, error }: FolderPickerProps) {
  const supported = isFileSystemAccessSupported();

  return (
    <div className="folder-picker">
      <h1>Photo Editor</h1>
      <p>
        Open a folder of NEF and JPEG files from your computer. Nothing is uploaded — the app
        reads and writes files directly on your disk through the browser.
      </p>
      {!supported && (
        <p className="warning">
          Your browser doesn't support the File System Access API needed to read local folders.
          Please use a Chromium-based browser (Chrome, Edge, Brave, Arc).
        </p>
      )}
      {error && <p className="warning">{error}</p>}
      <button disabled={!supported} onClick={onPick}>
        Open Folder…
      </button>
    </div>
  );
}
