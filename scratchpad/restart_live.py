import importlib
from LiveStoryLib import serialize_mrson, segedit_capture, mrson_live
importlib.reload(serialize_mrson)
importlib.reload(segedit_capture)
importlib.reload(mrson_live)
try:
    slicer.mrsonLive.stop()
except Exception as e:
    print("stop old:", e)
slicer.mrsonLive = mrson_live.startMrsonLive(2142)
__execResult = "restarted mrson live :2142 (serialize_mrson + SegEditCapture reloaded)"
