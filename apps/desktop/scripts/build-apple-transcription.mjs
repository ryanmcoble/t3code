import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation targets the actual build host.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The default architecture follows the actual build host.
const hostArch = process.arch;
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

if (hostPlatform === "darwin") {
  if (values.arch !== "arm64" && values.arch !== "x64" && values.arch !== "universal")
    throw new Error("Unsupported Mac architecture.");
  const root = NodeURL.fileURLToPath(
    new URL("../../../native/apple-transcription/", import.meta.url),
  );
  const source = NodePath.join(root, "main.swift");
  const output = values.output ?? NodePath.join(root, "build", values.arch, "t3-transcription");
  const architectures =
    values.arch === "universal"
      ? ["arm64", "x86_64"]
      : [values.arch === "x64" ? "x86_64" : "arm64"];
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
        Math.max(
          NodeFS.statSync(source).mtimeMs,
          NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
        ) &&
      architectures.every((arch) =>
        NodeChildProcess.execFileSync("xcrun", ["lipo", "-archs", output], { encoding: "utf8" })
          .split(/\s+/)
          .includes(arch),
      );
  } catch {}
  if (!current) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      for (const arch of architectures)
        NodeChildProcess.execFileSync(
          "xcrun",
          [
            "swiftc",
            "-O",
            "-parse-as-library",
            "-target",
            `${arch}-apple-macos13.0`,
            source,
            "-o",
            `${temporary}.${arch}`,
          ],
          { stdio: "inherit" },
        );
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "lipo",
          "-create",
          ...architectures.map((arch) => `${temporary}.${arch}`),
          "-output",
          temporary,
        ],
        { stdio: "inherit" },
      );
      NodeFS.renameSync(temporary, output);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
      for (const arch of architectures) NodeFS.rmSync(`${temporary}.${arch}`, { force: true });
    }
  }
} else if (values.output) {
  throw new Error("Build the Apple transcription helper on macOS.");
}
