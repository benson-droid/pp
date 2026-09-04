import { isFileSystemAccessSupported, isOpenFilePickerSupported } from '../lib/fileAccess';

interface FolderPickerProps {
  onPickFolder: () => void;
  onPickFiles: () => void;
  error: string | null;
}

export default function FolderPicker({ onPickFolder, onPickFiles, error }: FolderPickerProps) {
  const supported = isFileSystemAccessSupported();
  const filesSupported = isOpenFilePickerSupported();

  return (
    <div className="folder-picker">
      <h1>Photo Editor</h1>
      <p>
        Open a folder — or just a few individual files — of NEF and JPEG files from your
        computer. Nothing is uploaded — the app reads and writes files directly on your disk
        through the browser.
      </p>
      {!supported && (
        <p className="warning">
          Your browser doesn't support the File System Access API needed to read local files.
          Please use a Chromium-based browser (Chrome, Edge, Brave, Arc).
        </p>
      )}
      {error && <p className="warning">{error}</p>}
      <div className="button-row" style={{ justifyContent: 'center' }}>
        <button disabled={!supported} onClick={onPickFolder}>
          Open Folder…
        </button>
        <button disabled={!filesSupported} onClick={onPickFiles}>
          Open Files…
        </button>
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        Or drag photos — or a whole folder — anywhere onto this page.
      </p>
      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        Edits are saved automatically in this browser either way. Opening a folder additionally
        gives exports a home ("edited/" next to your originals). You can also set one save folder
        that's remembered between sessions — point it at a Google Drive or Dropbox sync folder and
        everything you export gets backed up automatically.
      </p>
    </div>
  );
}
