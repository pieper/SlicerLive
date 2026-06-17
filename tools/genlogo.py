import json
p={}
for ln in open('/tmp/boltpaths.txt'):
    if '::' in ln: k,v=ln.rstrip().split('::',1); p[k]=v
M,B,T=p['MAIN'],p['BRANCH'],p['TENDRIL']
tpl = '''// AUTO-GENERATED (do not hand-edit; see tools/genlogo.py): SlicerLive brand mark =
// the 3D Slicer logo with gold fractal lightning forking through it (x-ray shine-through).
const SLL = { m: __M__, b: __B__, t: __T__ };
function _strokes(color, wm, wb, wt) {
  return '<use href="#sllm" stroke="' + color + '" stroke-width="' + wm + '"/>' +
         '<use href="#sllb" stroke="' + color + '" stroke-width="' + wb + '"/>' +
         '<use href="#sllt" stroke="' + color + '" stroke-width="' + wt + '"/>';
}
// Returns an HTML string: the static brand mark (px square) + the SlicerLive wordmark.
export function slicerLiveLogo(px, markURL) {
  px = px || 190; markURL = markURL || '3D-Slicer-Mark.svg';
  const ds1 = (px * 0.085).toFixed(0), ds2 = (px * 0.17).toFixed(0), wf = (px * 0.185).toFixed(0);
  return (
    '<style>' +
    '.sll-stage{position:relative;width:' + px + 'px;height:' + px + 'px;margin:0 auto}' +
    '.sll-layer{position:absolute;inset:0;overflow:visible}' +
    '.sll-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
    '.sll-layer use{fill:none;stroke-linejoin:round;stroke-linecap:round}' +
    '.sll-logo{background:url(' + markURL + ') center/contain no-repeat;filter:brightness(1.1) saturate(1.1) drop-shadow(0 0 ' + ds1 + 'px rgba(255,200,80,.6)) drop-shadow(0 0 ' + ds2 + 'px rgba(255,175,55,.35))}' +
    '.sll-clip{-webkit-mask:url(' + markURL + ') center/contain no-repeat;mask:url(' + markURL + ') center/contain no-repeat}' +
    '.sll-wash{background:radial-gradient(60% 60% at 48% 52%, rgba(255,205,95,.5), rgba(255,165,45,.2) 70%, rgba(255,150,35,.04));mix-blend-mode:screen;opacity:.85}' +
    '.sll-xray{mix-blend-mode:screen}' +
    '.sll-word{font:800 ' + wf + 'px/1 -apple-system,system-ui,sans-serif;letter-spacing:1px;color:#eef7ff;text-align:center;margin-top:6px;text-shadow:0 0 20px rgba(255,210,90,.45)}' +
    '.sll-word b{color:#ffd34d}' +
    '</style>' +
    '<div class="sll-stage">' +
      '<svg width="0" height="0"><defs>' +
        '<path id="sllm" d="' + SLL.m + '"/><path id="sllb" d="' + SLL.b + '"/><path id="sllt" d="' + SLL.t + '"/>' +
        '<filter id="sllaura" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>' +
        '<filter id="sllxr" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>' +
        '<filter id="sllxg" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5"/></filter>' +
        '<filter id="sllxc" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.4"/></filter>' +
      '</defs></svg>' +
      '<div class="sll-layer"><svg viewBox="0 0 230 230">' +
        '<g filter="url(#sllaura)" opacity="0.95">' + _strokes('#ffc63a',6.5,4,2.4) + '</g>' +
        _strokes('#ffd84e',4,2.4,1.4) + _strokes('#fff7d6',2,1.2,0.7) +
      '</svg></div>' +
      '<div class="sll-layer sll-logo"></div>' +
      '<div class="sll-layer sll-clip sll-wash"></div>' +
      '<div class="sll-layer sll-clip sll-xray"><svg viewBox="0 0 230 230">' +
        '<g filter="url(#sllxr)" opacity="0.85">' + _strokes('#ff9e1e',7,4.4,2.4) + '</g>' +
        '<g filter="url(#sllxg)" opacity="1">' + _strokes('#ffd44d',4.2,2.6,1.4) + '</g>' +
        '<g filter="url(#sllxc)" opacity="0.95">' + _strokes('#fffae6',2.2,1.4,0.8) + '</g>' +
      '</svg></div>' +
    '</div>' +
    '<div class="sll-word">Slicer<b>Live</b></div>'
  );
}
'''
js = tpl.replace('__M__', json.dumps(M)).replace('__B__', json.dumps(B)).replace('__T__', json.dumps(T))
open('/Users/pieper/slicer/SlicerLive/viewer/sllogo.js','w').write(js)
print("wrote sllogo.js", len(js), "bytes")
