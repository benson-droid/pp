/**
 * Remembering what was open, so a refresh doesn't throw the work away.
 *
 * Nothing here copies your photos or footage anywhere. What's stored is a
 * *reference* — the `FileSystemHandle` the browser already gave us —
 * plus the small amount of structure that isn't in the files themselves
 * (which clips, what trims, which grade). The one exception is a dropped
 * file the browser gave us no handle for: there's nothing to reference, so
 * a small one is kept as a blob and a large one is left to be re-added.
 *
 * The permission grant does not survive a refresh, so restoring is a
 * two-step affair: on load we can only *query* whether a handle is still
 * usable, and re-granting needs a click. That's why callers get a
 * `needsPermission` flag rather than a simple yes/no.
 */
import type { PhotoEntry } from '../types';
import type { VideoProject, VideoSource } from '../video/types';
import { SESSION_STORE, handleUsable, idbDelete, idbGet, idbPut } from './idb';
import { listPhotos, photosFromHandles } from './fileAccess';

const PHOTO_KEY = 'photo-session';
const VIDEO_KEY = 'video-project';

/** Above this, a handle-less file is dropped rather than copied into the
 * browser's storage. Small enough not to bloat the profile, large enough
 * to cover music beds and phone clips. */
const MAX_INLINE_BYTES = 48 * 1024 * 1024;

// --- Photos ---------------------------------------------------------------

interface StoredPhotoSession {
  dirHandle: FileSystemDirectoryHandle | null;
  /** Single-file mode: the individual photos that were opened. */
  fileHandles: FileSystemFileHandle[];
  /** Which photo the editor had open, by name. */
  openPhoto: string | null;
}

export interface RestoredPhotoSession {
  dirHandle: FileSystemDirectoryHandle | null;
  photos: PhotoEntry[];
  openPhoto: string | null;
  /** A label for the "reopen" button when the grant has lapsed. */
  label: string;
  /** True when the handles are still there but need a click to re-grant. */
  needsPermission: boolean;
}

export async function savePhotoSession(
  dirHandle: FileSystemDirectoryHandle | null,
  photos: PhotoEntry[],
  openPhoto: string | null,
): Promise<void> {
  // Saving nothing must never *delete* what's stored. When a refresh finds
  // a folder whose permission has lapsed, the app sits at the start screen
  // with no photos open while it offers to reopen it — and this function
  // runs in that state. Clearing here would wipe the very session the
  // reopen button is about to restore. Forgetting is only ever explicit:
  // "Open something else" or "Forget it".
  if (!dirHandle && photos.length === 0) return;
  // Only real handles are worth storing; the handle-alikes wrapped around
  // plain dropped Files can't be reopened later.
  const fileHandles = dirHandle
    ? []
    : photos
        .map((p) => p.fileHandle)
        .filter((h): h is FileSystemFileHandle => typeof h?.queryPermission === 'function');
  if (!dirHandle && fileHandles.length === 0) return;
  try {
    const payload: StoredPhotoSession = { dirHandle, fileHandles, openPhoto };
    await idbPut(SESSION_STORE, PHOTO_KEY, payload);
  } catch {
    // Not being able to remember the session is never worth an error in
    // the user's face — the app still works, it just forgets.
  }
}

export async function clearPhotoSession(): Promise<void> {
  try {
    await idbDelete(SESSION_STORE, PHOTO_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Reads back the last session. `prompt` must only be true when called from
 * a click — that's the one case where the browser will re-grant access.
 */
export async function loadPhotoSession(prompt = false): Promise<RestoredPhotoSession | null> {
  let stored: StoredPhotoSession | null = null;
  try {
    stored = await idbGet<StoredPhotoSession>(SESSION_STORE, PHOTO_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;

  if (stored.dirHandle) {
    const label = stored.dirHandle.name;
    if (!(await handleUsable(stored.dirHandle, 'readwrite', prompt))) {
      return { dirHandle: null, photos: [], openPhoto: stored.openPhoto, label, needsPermission: true };
    }
    try {
      const photos = await listPhotos(stored.dirHandle);
      return { dirHandle: stored.dirHandle, photos, openPhoto: stored.openPhoto, label, needsPermission: false };
    } catch {
      // The folder was moved, renamed or deleted since last time.
      await clearPhotoSession();
      return null;
    }
  }

  const handles = stored.fileHandles ?? [];
  if (handles.length === 0) return null;
  const label = `${handles.length} file${handles.length === 1 ? '' : 's'}`;
  const usable: FileSystemFileHandle[] = [];
  for (const h of handles) {
    if (await handleUsable(h, 'read', prompt)) usable.push(h);
  }
  if (usable.length === 0) {
    return { dirHandle: null, photos: [], openPhoto: stored.openPhoto, label, needsPermission: true };
  }
  return {
    dirHandle: null,
    photos: photosFromHandles(usable),
    openPhoto: stored.openPhoto,
    label,
    needsPermission: false,
  };
}

// --- Video ----------------------------------------------------------------

interface StoredSource {
  id: string;
  name: string;
  kind: 'video' | 'image';
  /** Preferred: a reference to the file where it lives. */
  handle: FileSystemFileHandle | null;
  /** Fallback for handle-less drops, only when small enough. */
  file: File | null;
}

interface StoredVideoProject {
  project: VideoProject;
  sources: StoredSource[];
  /** Stored separately because MusicTrack carries a File. */
  music: { name: string; file: File | null } | null;
}

export interface RestoredVideoProject {
  project: VideoProject;
  files: Map<string, { file: File; kind: 'video' | 'image'; handle: FileSystemFileHandle | null }>;
  /** Sources that couldn't be reopened — their clips need relinking. */
  missing: string[];
  needsPermission: boolean;
}

function isRealHandle(h: unknown): h is FileSystemFileHandle {
  return typeof (h as FileSystemFileHandle | undefined)?.queryPermission === 'function';
}

export async function saveVideoProject(
  project: VideoProject,
  sources: Map<string, VideoSource>,
): Promise<void> {
  // As with photos: an empty timeline means "nothing to save", never
  // "throw away what's saved". A project awaiting a permission re-grant
  // looks exactly like an empty one from here.
  if (project.clips.length === 0) return;
  try {
    const stored: StoredSource[] = [];
    for (const [id, s] of sources) {
      const handle = isRealHandle(s.handle) ? s.handle : null;
      stored.push({
        id,
        name: s.name,
        kind: s.kind,
        handle,
        file: !handle && s.file.size <= MAX_INLINE_BYTES ? s.file : null,
      });
    }
    // The project itself must be plain data — strip the music File out and
    // store it alongside, so the rest stays trivially cloneable.
    const { music, ...rest } = project;
    const payload: StoredVideoProject = {
      project: { ...rest, music: music ? { ...music, file: undefined as unknown as File } : null },
      sources: stored,
      music: music ? { name: music.name, file: music.file.size <= MAX_INLINE_BYTES ? music.file : null } : null,
    };
    await idbPut(SESSION_STORE, VIDEO_KEY, payload);
  } catch {
    /* forgetting is acceptable; failing loudly is not */
  }
}

export async function clearVideoProject(): Promise<void> {
  try {
    await idbDelete(SESSION_STORE, VIDEO_KEY);
  } catch {
    /* ignore */
  }
}

export async function loadVideoProject(prompt = false): Promise<RestoredVideoProject | null> {
  let stored: StoredVideoProject | null = null;
  try {
    stored = await idbGet<StoredVideoProject>(SESSION_STORE, VIDEO_KEY);
  } catch {
    return null;
  }
  if (!stored || !stored.project || stored.project.clips.length === 0) return null;

  const files = new Map<string, { file: File; kind: 'video' | 'image'; handle: FileSystemFileHandle | null }>();
  const missing: string[] = [];
  let needsPermission = false;

  for (const s of stored.sources ?? []) {
    if (s.handle) {
      if (await handleUsable(s.handle, 'read', prompt)) {
        try {
          files.set(s.id, { file: await s.handle.getFile(), kind: s.kind, handle: s.handle });
          continue;
        } catch {
          // Moved or deleted since last time.
        }
      } else {
        needsPermission = true;
      }
    } else if (s.file) {
      files.set(s.id, { file: s.file, kind: s.kind, handle: null });
      continue;
    }
    missing.push(s.name);
  }

  const project = { ...stored.project };
  if (project.music && stored.music?.file) {
    project.music = { ...project.music, name: stored.music.name, file: stored.music.file };
  } else if (project.music) {
    project.music = null;
  }

  return { project, files, missing, needsPermission };
}
