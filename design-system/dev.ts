// pi styles bold and italic through chalk; the gallery renders headless.
process.env.FORCE_COLOR ||= "3";

/** `bun run dev`: serve the gallery and rebuild it whenever a source file changes. */

const root = `${import.meta.dir}/..`;

const build = Bun.spawn(["bun", "--watch", "design-system/build.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

const server = Bun.spawn(["bun", "design-system/serve.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

const stop = () => {
  build.kill();
  server.kill();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race([build.exited, server.exited]);
