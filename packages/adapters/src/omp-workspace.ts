import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { listCurrentTurnFiles } from "./thread-artifacts.js";

/** Copy only authorized current-turn artifacts into the bot's local omp workspace. */
export async function materializeOmpAttachments(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore; maxUploadSizeBytes?: number },
  blocks: MessageBlock[] | undefined,
  context: AdapterContext,
  directory: string,
) {
  const files = await listCurrentTurnFiles(deps, blocks, context);
  if (!files.length) return files;
  const ids = (blocks ?? []).flatMap((block) =>
    block.kind === "file" || block.kind === "image" ? [block.artifactId] : [],
  );
  const rows = await deps.prisma.artifact.findMany({
    where: { id: { in: ids }, spaceId: context.spaceId, userId: context.userId },
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "attachments"), { recursive: true, mode: 0o700 });
  for (const file of files) {
    const row = rows.find((artifact) => file.path.startsWith(`attachments/${artifact.id}.`));
    if (!row) throw new Error("Attached file is unavailable");
    const bytes = await deps.artifacts.get(row.storageKey, context);
    if (bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
      throw new Error("Attached file exceeds the attachment limit");
    }
    await writeFile(path.join(directory, file.path), bytes, { mode: 0o600 });
  }
  return files;
}

/** attach_file is workspace scoped even while omp's native bash can access the host. */
export async function readOmpAttachment(
  directory: string,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const root = await realpath(directory);
  const target = await realpath(path.resolve(root, filePath));
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Attachment must be inside the bot working directory");
  }
  const info = await stat(target);
  if (!info.isFile() || info.size > maxBytes) throw new Error("Attachment exceeds the size limit");
  const bytes = await readFile(target);
  if (bytes.byteLength > maxBytes) throw new Error("Attachment exceeds the size limit");
  return bytes;
}
