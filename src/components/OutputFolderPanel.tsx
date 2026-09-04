import type { OutputFolderState } from '../lib/useOutputFolder';

/**
 * The "where do saves go?" control. Deliberately the same in the photo
 * editor and the video editor so there's one place to set it and one
 * answer everywhere.
 */
export default function OutputFolderPanel({
  workspace,
  fallbackLabel,
}: {
  workspace: OutputFolderState;
  /** Where exports go when no folder is remembered — e.g. "edited/ next to
   * the originals". */
  fallbackLabel: string;
}) {
  if (!workspace.folder) {
    return (
      <>
        <p className="panel-hint muted">Saving to {fallbackLabel}.</p>
        <button className="reset-all" onClick={() => void workspace.choose()}>
          Choose a save folder…
        </button>
        <p className="panel-hint muted">
          Pick a folder once and it's remembered between sessions — exports go straight there with
          no dialog. A Google Drive or Dropbox sync folder works well: whatever lands there gets
          uploaded by the app already running on your computer.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="inspector-source muted">{workspace.folder.name}</div>
      {!workspace.ready && (
        <p className="panel-hint warning">
          Needs permission again — browsers ask once per session. Exporting will prompt for it.
        </p>
      )}
      <div className="button-row">
        <button onClick={() => void workspace.choose()}>Change</button>
        <button onClick={workspace.forget}>Forget</button>
      </div>
      <p className="panel-hint muted">Exports save here automatically.</p>
    </>
  );
}
