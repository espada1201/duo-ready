// Reading a project the person hands the lab: a dropped or chosen folder, loose files, or a zip.

import { strFromU8, unzip, type Unzipped } from 'fflate';
import { isRelevant, isRelevantDir, MAX_BYTES } from '../core/audit';
import type { SourceFile } from '../core/types';

const MAC_JUNK = /(^|\/)(__MACOSX\/|\._)/;

/** A zipped project. Finder and GitHub put everything in one top folder, so paths start inside it. */
export async function filesFromZip(zip: File, prefix = ''): Promise<SourceFile[]> {
  const data = new Uint8Array(await zip.arrayBuffer());
  // Some Windows zippers write backslashes.
  const slashed = (name: string) => name.replace(/\\/g, '/');
  const tops = new Set<string>();
  const entries = await new Promise<Unzipped>((res, rej) =>
    unzip(
      data,
      {
        filter: (f) => {
          const name = slashed(f.name);
          if (MAC_JUNK.test(name)) return false;
          // Every entry counts toward the top folder, not just the ones read.
          tops.add(name.includes('/') ? name.slice(0, name.indexOf('/')) : '');
          return (isRelevant(name) || isRelevant(name.slice(name.indexOf('/') + 1))) && f.originalSize <= MAX_BYTES;
        },
      },
      (err, out) => (err ? rej(err) : res(out)),
    ),
  );
  const [top] = tops;
  const cut = tops.size === 1 && top ? top.length + 1 : 0;
  return Object.keys(entries)
    .sort()
    .map((n) => ({ path: (prefix ? `${prefix}/` : '') + slashed(n).slice(cut), content: strFromU8(entries[n]) }))
    .filter((f) => isRelevant(f.path));
}

const isZip = (name: string) => name.toLowerCase().endsWith('.zip');

// Paths start inside the folder the person picked, as the CLI's do, so a project kept in a
// folder named `build` or `.archive` isn't mistaken for build output.
// Only a zip dropped itself is read: one inside a project is an old archive, not the project.
async function readEntries(entry: FileSystemEntry, prefix: string, out: SourceFile[], picked = false, dropped = false): Promise<void> {
  const path = picked ? '' : prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && isZip(path)) {
    if (!dropped) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    // Named for the whole zip, so `build.zip` isn't read as a build folder.
    out.push(...(await filesFromZip(file, path)));
  } else if (entry.isFile) {
    if (!isRelevant(path)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (file.size <= MAX_BYTES) out.push({ path, content: await file.text() });
  } else if (entry.isDirectory) {
    if (!picked && !isRelevantDir(path)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      await Promise.all(batch.map((child) => readEntries(child, path, out)));
    }
  }
}

export async function filesFromDrop(data: DataTransfer): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  // Without the entries API (or for files a page hands over itself) only loose files can be read.
  if (!entries.length) return filesFromInput(data.files);
  // One dropped folder is the project root; several keep their names so their paths can't collide.
  if (entries.length === 1 && entries[0].isFile && isZip(entries[0].name)) return filesFromInput(data.files);
  await Promise.all(entries.map((e) => readEntries(e, '', out, e.isDirectory && entries.length === 1, true)));
  // Reads finish in any order; sort so findings come out the same on every run.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function filesFromInput(list: FileList): Promise<SourceFile[]> {
  if (list.length === 1 && isZip(list[0].name)) return filesFromZip(list[0]);
  const picked = [...list]
    .map((f) => ({ f, path: f.webkitRelativePath ? f.webkitRelativePath.slice(f.webkitRelativePath.indexOf('/') + 1) : f.name }))
    .filter(({ f, path }) => isRelevant(path) && f.size <= MAX_BYTES);
  return Promise.all(picked.map(async ({ f, path }) => ({ path, content: await f.text() })));
}
