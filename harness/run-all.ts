// Forwarder — the parity runner moved into the single test entry point (docs/HARNESS.md):
//   deno run -A test/run.ts [--browser]      (pure checks are part of the unit tier; --browser adds T3)
// Kept for one release so old muscle memory still works.
const args = Deno.args.includes("--browser") ? ["--browser"] : [];
const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "test/run.ts", ...args, ...Deno.args.filter((a) => a === "-v")], stdout: "inherit", stderr: "inherit" }).output();
Deno.exit(r.code);
