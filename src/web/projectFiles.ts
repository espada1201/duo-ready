// Reading a project the person hands the lab: a dropped or chosen folder, loose files, or a zip.

import { strFromU8, unzip, type Unzipped } from 'fflate';
import { isRelevant, isRelevantDir, MAX_BYTES } from '../core/audit';
import type { SourceFile } from '../core/types';

const MAC_JUNK = /(^|\/)(__MACOSX\/|\._)/;

/** A zipped project. Finder and GitHub put everything in one top folder, so paths start inside it. */
export async function filesFromZip(zip: File, prefix = ''): Promise<SourceFile[]> {
  const data = new Uint8Array(await zip.arrayBuffer());
  const entries = await new Promise<Unzipped>((res, rej) =>
    unzip(data, { filter: (f) => (isRelevant(f.name) || isRelevant(f.name.slice(f.name.indexOf('/') + 1))) && !MAC_JUNK.test(f.name) && f.originalSize <= MAX_BYTES }, (err, out) => (err ? rej(err) : res(out))),
  );
  const names = Object.keys(entries).sort();
  const top = names[0]?.split('/')[0];
  const cut = names.length && names.every((n) => n.startsWith(`${top}/`)) ? top.length + 1 : 0;
  return names
    .map((n) => ({ path: (prefix ? `${prefix}/` : '') + n.slice(cut), content: strFromU8(entries[n]) }))
    .filter((f) => isRelevant(f.path));
}

const isZip = (name: string) => name.toLowerCase().endsWith('.zip');

// Paths start inside the folder the person picked, as the CLI's do, so a project kept in a
// folder named `build` or `.archive` isn't mistaken for build output.
async function readEntries(entry: FileSystemEntry, prefix: string, out: SourceFile[], picked = false): Promise<void> {
  const path = picked ? '' : prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && isZip(path)) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push(...(await filesFromZip(file, path.slice(0, -4))));
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
  await Promise.all(entries.map((e) => readEntries(e, '', out, e.isDirectory && entries.length === 1)));
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
