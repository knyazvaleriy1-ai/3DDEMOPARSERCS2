# Сторонние материалы / Third-party material

## В репозитории / Included

| Что | Где | Лицензия |
| --- | --- | --- |
| [three.js](https://threejs.org) r170 (core, OrbitControls, GLTFLoader, SkeletonUtils, BufferGeometryUtils) | `cs2demo/web/vendor/` | MIT, `three.LICENSE` |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.1 | `cs2demo/web/vendor/mp4-muxer.mjs` | MIT, `mp4-muxer.LICENSE` |
| [demoparser2](https://github.com/LaihoE/demoparser) v0.42.1 parser compiled to WebAssembly by `wasm/build.sh` (with its Rust dependencies — prost, bitter, ahash, snap and others, MIT/Apache-2.0) and the [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) 0.2.100 JS glue | `cs2demo/web/vendor/demoparser/` | MIT, `demoparser.LICENSE`; wasm-bindgen MIT/Apache-2.0 |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) 2.0.2: the UnRAR library compiled to WebAssembly and its `Extractor` class (used by `cs2demo/web/js/parse/rar.js` and `cs2demo/unrar_cli.mjs` to open `.rar` archives) | `cs2demo/web/vendor/unrar/` | MIT, `node-unrar-js.LICENSE`; UnRAR by Alexander Roshal — freeware, may be used to handle RAR archives, `unrar.LICENSE` |
| Killfeed icons from [game-icons.net](https://game-icons.net), rotated and cropped by `scripts/build_icons.py` | `cs2demo/web/js/icons.js` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

Icon authors (game-icons.net): **Skoll** — ak47, ak47u, fn-fal, famas, steyr-aug,
lee-enfield, glock, walther-ppk, colt-m1911, desert-eagle, revolver, tec-9, c96,
mac-10, mp5k, mp5, thompson-m1, p90, mp-40, winchester-rifle, thompson-m1928,
bowie-knife, headshot, sight-disabled; **Lorc** — grenade, flash-grenade, molotov,
time-bomb, skull-crossed-bones, dust-cloud; **Delapouite** — uzi,
sawed-off-shotgun, broken-wall, crosshair, jump-across; **Sbed** — electric,
grenade; **DarkZaitzev** — smoke-bomb. Modified (rotated, cropped, scopes added
to the rifle icons).

## Скачивается при запуске / Downloaded at runtime (not in the repository)

The web version (GitHub Pages) downloads these at build time and serves them
next to the page.

| Что | Откуда | Чьё |
| --- | --- | --- |
| Map collision meshes, radar images, `map_data.json` | [awpy-data](https://github.com/pnxenopoulos/awpy-data) releases | Valve Corporation game assets |
| Default player model `Soldier.glb` (idle / walk / run) | [three.js examples](https://github.com/mrdoob/three.js/tree/r170/examples/models/gltf) | as distributed with the three.js examples (originally from Mixamo) |
