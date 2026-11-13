# VoluLab COLMAP bridge

Pose estimation without leaving the app. VoluLab runs in the browser and
cannot execute COLMAP; this small helper can. Start it, leave the window
open, and importing photos or a video in VoluLab estimates camera poses
automatically — the import node shows each stage, and the posed dataset
lands on it ready to wire into a train node.

```
npm run bridge
```

No dependencies beyond Node. On first run without COLMAP on the PATH
(Windows), the bridge offers to download the official portable build and
unpacks it under `bridge/.colmap` — no admin rights. On Mac/Linux install
COLMAP yourself (`brew install colmap` / `sudo apt install colmap`).

The bridge listens on `127.0.0.1:39733` only — nothing is reachable from
outside the machine. Without the bridge running, VoluLab falls back to
writing a `run-colmap` script kit next to your images for a manual run.

Only VoluLab itself may use it: requests from `localhost`/`127.0.0.1`
pages and from the deployed app are accepted, every other website is
refused. Add origins with `VOLULAB_ORIGINS=https://a.example,https://b.example`.
