import sys
sys.path.insert(0, "/Users/pieper/slicer/SlicerLive/LiveStory")
from LiveStoryLib import mrson_server, mrson_live
slicer.mrsonServer = mrson_server.startMrsonServer(2141)   # mrson scene ops (HTTP)
slicer.mrsonLive   = mrson_live.startMrsonLive(2142)       # mrson live channel (WS)
# a full WebServer with the Python-exec endpoint, so the growcut/scissors comparison can be driven
# in THIS running instance (the mrson server itself has exec disabled).
import WebServer
slicer.execServer = WebServer.WebServerLogic(port=2143, enableSlicer=True, enableExec=True,
                                             enableStaticPages=False, enableDICOM=False, enableCORS=True)
slicer.execServer.start()
print("\n=== SlicerLive MCP up: mrson http :2141, ws :2142, exec :2143 ===\n")
