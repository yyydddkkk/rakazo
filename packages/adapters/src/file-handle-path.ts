import { readlink } from "node:fs/promises";
import type { LibraryHandle } from "koffi";
import koffi from "koffi";

type KoffiFunction = ReturnType<LibraryHandle["func"]>;

let getPath: KoffiFunction | undefined;
let getNodeHandle: KoffiFunction | undefined;
let getFinalPath: KoffiFunction | undefined;

/** Resolve the opened object, never the pathname that was used to open it. */
export async function fileHandlePath(fd: number): Promise<string> {
  if (process.platform === "linux") {
    // readlink preserves the kernel's path even if an ancestor has since been
    // replaced. realpath would follow the replacement and lose that guarantee.
    return readlink(`/proc/self/fd/${fd}`);
  }
  if (process.platform === "win32") {
    // Node descriptors belong to its own CRT. Looking them up in msvcrt.dll
    // can return an invalid or unrelated handle from a different descriptor table.
    getNodeHandle ??= koffi.load(null).func("intptr_t __cdecl uv_get_osfhandle(int fd)");
    return pathFromWindowsHandle(getNodeHandle(fd) as number | bigint);
  }
  if (process.platform === "darwin") {
    getPath ??= koffi.load("/usr/lib/libSystem.B.dylib").func("int fcntl(int fd, int cmd, ...)");
    const buffer = Buffer.alloc(1024); // Darwin MAXPATHLEN
    const result = getPath(fd, 50 /* F_GETPATH */, "void *", buffer) as number;
    const end = buffer.indexOf(0);
    if (result !== 0 || end <= 0) throw new Error("Cannot resolve the opened home file");
    return buffer.toString("utf8", 0, end);
  }
  throw new Error("Cannot securely read home files on this platform");
}

function pathFromWindowsHandle(handle: number | bigint): string {
  getFinalPath ??= koffi
    .load("kernel32.dll")
    .func(
      "uint32_t __stdcall GetFinalPathNameByHandleW(void *hFile, void *lpszFilePath, uint32_t cchFilePath, uint32_t dwFlags)",
    );
  if (handle === -1n || handle === -1) invalidHandlePath();

  const flags = 0; // VOLUME_NAME_DOS
  const size = getFinalPath(handle, null, 0, flags) as number;
  if (size === 0) invalidHandlePath();

  const buf = Buffer.alloc((size + 1) * 2);
  const written = getFinalPath(handle, buf, size + 1, flags) as number;
  if (written === 0) invalidHandlePath();

  let resolved = buf.toString("utf16le", 0, written * 2);
  if (resolved.startsWith("\\\\?\\UNC\\"))
    resolved = `\\\\${resolved.slice("\\\\?\\UNC\\".length)}`;
  else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice("\\\\?\\".length);
  return resolved;
}

function invalidHandlePath(): never {
  throw new Error("Cannot resolve the opened home file");
}
