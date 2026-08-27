// Client-side handlers for the view-interaction cmds SlicerLive writes to LiveScene. A cmd is only
// replicated when the local applier reports a change, so each handler mirrors the app-side effect on
// the local node (the app's echo then confirms it). Registered once on import.
import { registerCmd } from "../liveops.ts";

registerCmd("setCursor", (node, args) => {
  // crosshair cursor (DataProbe follows on the app side); ras=null = cursor left the views
  (node as Record<string, unknown>).cursorRAS = Array.isArray(args.ras) ? [...(args.ras as number[])] : null;
  (node as Record<string, unknown>).cursorView = args.view ?? null;
  return true;
});

registerCmd("setSliceFrame", (node, args) => {
  const m = node.sliceToRAS as number[] | undefined;
  let did = false;
  if (m && Array.isArray(args.center)) { const c = args.center as number[]; m[3] = c[0]; m[7] = c[1]; m[11] = c[2]; did = true; }
  if (Array.isArray(args.fov)) { (node as Record<string, unknown>).fieldOfView = [...(args.fov as number[])]; did = true; }
  return did;
});

registerCmd("viewContextMenu", (node, args) => {
  // no local state; the app builds the menu (it arrives as a popup region). Record the request so the
  // op counts as a change and replicates.
  (node as Record<string, unknown>).contextMenuRequest = { ras: args.ras, x: args.x, y: args.y, at: Date.now() };
  return true;
});

registerCmd("placeAt", (node, args) => {
  // place mode: the app owns the outcome (which node, persistence); record the request so it replicates
  (node as Record<string, unknown>).placeRequest = { ras: args.ras, at: Date.now() };
  return true;
});
