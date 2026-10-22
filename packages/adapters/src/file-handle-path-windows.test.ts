import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { load, getHandle, getPath } = vi.hoisted(() => ({
  load: vi.fn(),
  getHandle: vi.fn(),
  getPath: vi.fn(),
}));
vi.mock("koffi", () => ({ default: { load } }));
const platform = process.platform;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32" });
  load.mockImplementation((library) => ({
    func: () => (library === null ? getHandle : getPath),
  }));
  getHandle.mockReturnValue(42n);
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
});

it.each([
  ["\\\\?\\C:\\homes\\file", "C:\\homes\\file"],
  ["\\\\?\\UNC\\server\\share\\file", "\\\\server\\share\\file"],
])("resolves Windows descriptors and normalizes %s", async (resolved, expected) => {
  getPath.mockImplementation((_handle, buffer) => {
    if (buffer === null) return resolved.length;
    buffer.write(resolved, "utf16le");
    return resolved.length;
  });
  const { fileHandlePath } = await import("./file-handle-path.js");
  expect(await fileHandlePath(7)).toBe(expected);
  expect(getHandle).toHaveBeenCalledWith(7);
  expect(getPath).toHaveBeenCalledWith(42n, null, 0, 0);
  expect(load.mock.calls.map(([library]) => library)).toEqual([null, "kernel32.dll"]);
});

it.each(["invalid handle", "size lookup", "path lookup"])("rejects failed %s", async (stage) => {
  getHandle.mockReturnValue(stage === "invalid handle" ? -1n : 42n);
  getPath.mockImplementation((_handle, buffer) =>
    stage === "size lookup" || buffer !== null ? 0 : 10,
  );
  const { fileHandlePath } = await import("./file-handle-path.js");
  await expect(fileHandlePath(7)).rejects.toThrow("Cannot resolve the opened home file");
});
