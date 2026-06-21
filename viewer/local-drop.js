// Document-wide drag-and-drop for SlicerLive.
//
// v0 scope: **MRB only**. Drop an .mrb file anywhere on the viewport and
// the host's loadMrb hook is called. If a scene is already loaded, the user
// gets a glass prompt (Replace / Add / Cancel) per the project design.
// Other formats (NRRD, .seg.nrrd, DICOM directories, VTP, MRML+siblings,
// markups JSON) land in follow-up passes.

let _ldHooks = null;
let _ldOverlay = null;
let _ldDragDepth = 0;

/** Install document-level drag/drop. Idempotent.
 *  hooks:
 *   - getHasScene(): boolean - is there a scene loaded?
 *   - loadMrb(bytes: Uint8Array, opts: { mode: 'replace' | 'add', name: string }) - async
 */
export function installLocalDrop(hooks) {
  _ldHooks = hooks || {};
  if (window.__lmDropBound) return;
  window.__lmDropBound = true;
  document.addEventListener('dragenter', onDragEnter, true);
  document.addEventListener('dragover',  onDragOver,  true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('drop',      onDrop,      true);
}

function hasFiles(e) {
  if (!e.dataTransfer) return false;
  // Modern browsers expose `types`; "Files" appears when any file is being dragged
  const t = e.dataTransfer.types;
  if (t && (t.includes ? t.includes('Files') : Array.from(t).indexOf('Files') >= 0)) return true;
  // Older path
  return Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file');
}

function onDragEnter(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _ldDragDepth++;
  showDragOver();
}
function onDragOver(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}
function onDragLeave(e) {
  if (!hasFiles(e)) return;
  _ldDragDepth = Math.max(0, _ldDragDepth - 1);
  if (_ldDragDepth === 0) hideDragOver();
}
async function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _ldDragDepth = 0;
  hideDragOver();
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  await handleDrop(files);
}

async function handleDrop(files) {
  const mrbs   = files.filter((f) => /\.mrb$/i.test(f.name));
  const others = files.filter((f) => !/\.mrb$/i.test(f.name));

  if (!mrbs.length) {
    if (others.length) {
      const names = others.map((f) => f.name).join(', ');
      ldToast('Drag-drop v0 supports .mrb only — got ' + names + '. (NRRD, DICOM, etc. land next.)');
    }
    return;
  }
  if (mrbs.length > 1) {
    ldToast('Drop one .mrb at a time (got ' + mrbs.length + ').');
    return;
  }
  const mrb = mrbs[0];

  let mode = 'replace';
  const hasScene = _ldHooks.getHasScene ? _ldHooks.getHasScene() : false;
  if (hasScene) {
    const choice = await promptReplaceAddCancel(mrb.name);
    if (choice === 'cancel') return;
    mode = choice;   // 'replace' | 'add'
  }

  let bytes;
  try {
    bytes = new Uint8Array(await mrb.arrayBuffer());
  } catch (e) {
    ldToast('Failed to read ' + mrb.name + ': ' + (e && e.message || e));
    return;
  }
  if (!_ldHooks.loadMrb) return;
  try {
    await _ldHooks.loadMrb(bytes, { mode, name: mrb.name });
  } catch (e) {
    console.error('[local-drop] loadMrb threw', e);
    ldToast('Load failed: ' + (e && e.message || e));
  }
}

// ----- Glass UI: drag-over highlight + Replace/Add/Cancel prompt + toast ---

function showDragOver() {
  if (_ldOverlay) return;
  _ldOverlay = document.createElement('div');
  _ldOverlay.style.cssText =
    'position:fixed; inset:8px; z-index:90; pointer-events:none; border-radius:18px;' +
    ' border:3px dashed rgba(255,210,90,0.75);' +
    ' background:radial-gradient(ellipse at center, rgba(255,180,60,0.10), rgba(255,210,90,0.04) 60%, transparent);' +
    ' box-shadow:inset 0 0 80px rgba(255,180,60,0.25), 0 0 60px rgba(255,180,60,0.25);' +
    ' display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 100ms ease-out;';
  const hint = document.createElement('div');
  hint.style.cssText =
    'padding:18px 30px; border-radius:16px; color:#fff5d6;' +
    ' font:700 18px -apple-system,system-ui,sans-serif; letter-spacing:0.3px;' +
    ' background:rgba(20,24,38,0.78);' +
    ' backdrop-filter:blur(22px) saturate(1.6); -webkit-backdrop-filter:blur(22px) saturate(1.6);' +
    ' border:1px solid rgba(255,206,90,0.55);' +
    ' box-shadow:0 24px 60px rgba(0,0,0,0.6), 0 0 50px rgba(255,180,60,0.35);' +
    ' text-shadow:0 0 20px rgba(255,200,80,0.5);';
  hint.textContent = 'Drop to load — .mrb';
  _ldOverlay.appendChild(hint);
  document.body.appendChild(_ldOverlay);
  requestAnimationFrame(() => { if (_ldOverlay) _ldOverlay.style.opacity = '1'; });
}
function hideDragOver() {
  if (_ldOverlay) { _ldOverlay.remove(); _ldOverlay = null; }
}

function promptReplaceAddCancel(filename) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText =
      'position:fixed; inset:0; z-index:92; display:flex; align-items:center; justify-content:center;' +
      ' background:rgba(8,10,18,0.55); opacity:0; transition:opacity 120ms ease-out;' +
      ' font:13px -apple-system,system-ui,sans-serif;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'max-width:min(480px,92vw); padding:22px 26px; border-radius:18px; color:#eef7ff;' +
      ' background:linear-gradient(135deg, rgba(58,64,88,0.68), rgba(20,24,38,0.82));' +
      ' backdrop-filter:blur(24px) saturate(1.6); -webkit-backdrop-filter:blur(24px) saturate(1.6);' +
      ' border:1px solid rgba(255,206,90,0.45);' +
      ' box-shadow:0 24px 64px rgba(0,0,0,0.7), 0 0 50px rgba(255,180,60,0.22), inset 0 1px 0 rgba(255,255,255,0.15);';
    const title = document.createElement('div');
    title.textContent = 'Load ' + filename + '?';
    title.style.cssText = 'font:800 17px -apple-system,system-ui,sans-serif; margin-bottom:6px; letter-spacing:0.2px;';
    const body = document.createElement('div');
    body.textContent = 'A scene is already loaded. What would you like to do?';
    body.style.cssText = 'color:rgba(238,247,255,0.7); margin-bottom:20px; font-size:13px;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;';

    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = primary
        ? 'padding:9px 18px; border-radius:10px; border:0; cursor:pointer;' +
          ' background:linear-gradient(180deg,#ffd34d,#ff8a1c); color:#1a0f00;' +
          ' font:700 13px -apple-system,system-ui,sans-serif;' +
          ' box-shadow:0 6px 20px rgba(255,140,40,0.35);'
        : 'padding:9px 16px; border-radius:10px; cursor:pointer;' +
          ' border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.05); color:#eef7ff;' +
          ' font:600 13px -apple-system,system-ui,sans-serif;';
      return b;
    };
    const bCancel  = mkBtn('Cancel', false);
    const bAdd     = mkBtn('Add to scene', false);
    const bReplace = mkBtn('Replace', true);
    row.appendChild(bCancel); row.appendChild(bAdd); row.appendChild(bReplace);

    panel.appendChild(title); panel.appendChild(body); panel.appendChild(row);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    requestAnimationFrame(() => { ov.style.opacity = '1'; });

    const cleanup = (ans) => {
      ov.style.opacity = '0';
      setTimeout(() => ov.remove(), 130);
      resolve(ans);
    };
    bCancel.onclick  = () => cleanup('cancel');
    bAdd.onclick     = () => cleanup('add');
    bReplace.onclick = () => cleanup('replace');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) cleanup('cancel'); });
    document.addEventListener('keydown', function onKey(e) {
      if (!ov.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape') { e.preventDefault(); document.removeEventListener('keydown', onKey); cleanup('cancel'); }
      if (e.key === 'Enter')  { e.preventDefault(); document.removeEventListener('keydown', onKey); cleanup('replace'); }
    });
    bReplace.focus();
  });
}

let _ldToastEl = null, _ldToastTimer = null;
function ldToast(msg) {
  if (_ldToastEl) { _ldToastEl.remove(); _ldToastEl = null; }
  if (_ldToastTimer) { clearTimeout(_ldToastTimer); _ldToastTimer = null; }
  _ldToastEl = document.createElement('div');
  _ldToastEl.textContent = msg;
  _ldToastEl.style.cssText =
    'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:93;' +
    'max-width:80vw; padding:10px 18px; border-radius:11px; color:#fff5d6;' +
    'font:600 12.5px -apple-system,system-ui,sans-serif;' +
    'background:linear-gradient(135deg, rgba(58,64,88,0.7), rgba(20,24,38,0.78));' +
    'backdrop-filter:blur(18px) saturate(1.6); -webkit-backdrop-filter:blur(18px) saturate(1.6);' +
    'border:1px solid rgba(255,206,90,0.42); box-shadow:0 12px 32px rgba(0,0,0,0.5), 0 0 22px rgba(255,180,60,0.22);' +
    'opacity:0; transition:opacity 130ms ease-out;';
  document.body.appendChild(_ldToastEl);
  requestAnimationFrame(() => { if (_ldToastEl) _ldToastEl.style.opacity = '1'; });
  _ldToastTimer = setTimeout(() => {
    if (!_ldToastEl) return;
    _ldToastEl.style.opacity = '0';
    setTimeout(() => { if (_ldToastEl) { _ldToastEl.remove(); _ldToastEl = null; } }, 200);
  }, 2400);
}
