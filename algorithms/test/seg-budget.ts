// Verify the capability probe: measures the device and returns a coherent tier + tuned knobs.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/seg-budget.ts
import { initDevice } from "../../render/device.ts";
import { SegBudget } from "../../logic/seg-budget.ts";

const gpu = await initDevice();
const budget = await SegBudget.probe(gpu.device);
console.log("probe:", budget.summary());

const okTier = ["low", "mid", "high"].includes(budget.tier);
const okMax = budget.sdfMaxDim() >= 128 && budget.sdfMaxDim() <= 512;
const okDelay = budget.refineDelayMs() >= 30 && budget.refineDelayMs() <= 400;
// higher tiers must never be more conservative than lower ones
const hi = SegBudget.fixed("high"), lo = SegBudget.fixed("low");
const monotonic = hi.sdfMaxDim() > lo.sdfMaxDim() && hi.refineDelayMs() < lo.refineDelayMs();

const ok = okTier && okMax && okDelay && monotonic && budget.refineMsAt64 > 0;
console.log(`tier=${budget.tier} sdfMaxDim=${budget.sdfMaxDim()} refineDelay=${budget.refineDelayMs()}ms duringStroke=${budget.refineDuringStroke()} edt=${budget.useEdt()}`);
console.log(ok ? "PASS — probe classified the device + tuned knobs coherently (high>low res, faster refine)" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
