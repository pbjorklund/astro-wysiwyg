import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

interface TextFileMutation<T> {
  source: string;
  result: T;
}

export type BeforeTextFileWrite = (
  filePath: string,
  source: string,
) => void | Promise<void>;

const pendingWrites = new Map<string, Promise<void>>();

export async function mutateTextFile<T>(
  filePath: string,
  mutate: (source: string) => TextFileMutation<T> | Promise<TextFileMutation<T>>,
  onBeforeWrite?: BeforeTextFileWrite,
): Promise<T> {
  const previous = pendingWrites.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  pendingWrites.set(filePath, current);
  await previous;

  try {
    const mutation = await mutate(await readFile(filePath, 'utf8'));
    await onBeforeWrite?.(filePath, mutation.source);
    await replaceTextFile(filePath, mutation.source);
    return mutation.result;
  } finally {
    release();
    if (pendingWrites.get(filePath) === current) pendingWrites.delete(filePath);
  }
}

async function replaceTextFile(filePath: string, source: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = (await stat(filePath)).mode & 0o777;
  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(source, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
