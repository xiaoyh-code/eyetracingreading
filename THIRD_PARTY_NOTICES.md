# Third-party software and model notices

Gaze Reader is licensed under GPL-3.0-or-later. This license does not replace the separate licenses of dependencies or models. Build output includes full installed package notices in `static/bundled/DEPENDENCY-LICENSES.txt` and retained license comments.

## Webcam tracking

WebGazer 3.5.3, Copyright Brown WebGazer Team, GPL-3.0-or-later. The integrity-verified package is installed by `scripts/prepare_webgazer.py`; its license is distributed alongside the runtime as `static/vendor/WEBGAZER-LICENSE.md`.

- Exact corresponding source and build instructions: https://github.com/brownhci/WebGazer/tree/b12701dd7b6d7b00d4b8dbebf87fdec840c24999
- Download the complete source: [source archive](source/webgazer-3.5.3-source.tar.gz), [exact npm archive with runtime source maps](source/webgazer-3.5.3-npm.tgz), [verification record](source/WEBGAZER-SOURCE.json). These links resolve on the published Pages site; the archives are generated during build and are not committed to Git.
- Both upstream archives are distributed unchanged. The build verifies the source revision, archive hashes, webpack configuration, lockfile, and source/runtime-map correspondence.
- Exact distributed package: https://registry.npmjs.org/webgazer/-/webgazer-3.5.3.tgz
- Bundled MediaPipe face mesh runtime/models: https://github.com/google-ai-edge/mediapipe (Apache-2.0). Preserve its upstream copyright and license notices.

Runtime compatibility: this pinned MediaPipe/Emscripten build constructs JavaScript functions dynamically, including Embind invokers. The page CSP therefore permits `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`. External script sources and inline scripts remain disallowed, but the dynamic-evaluation allowance applies to the whole page and weakens its protection against script injection. The vendored upstream runtime is integrity checked and is not patched to bypass these requirements.

## Browser translation

Transformers.js: https://github.com/huggingface/transformers.js (Apache-2.0).
ONNX Runtime: https://github.com/microsoft/onnxruntime (MIT).
OpenCC-JS: https://github.com/nk2028/opencc-js (MIT).

The optional English-to-Chinese model downloads directly from Hugging Face only after the user selects preparation. It is not part of the GitHub repository or Pages artifact:

- Converted model: https://huggingface.co/Xenova/opus-mt-en-zh
- Pinned revision: `046f55aec303cdee3e0318604406d4df20f1e8ea`
- Original model: https://huggingface.co/Helsinki-NLP/opus-mt-en-zh
- Authors: Helsinki-NLP / OPUS-MT, converted for Transformers.js by Xenova.
- The original Helsinki-NLP model card declares Apache-2.0; see the model card and accompanying license for its terms. Gaze Reader uses a converted, quantized ONNX version, and converts Simplified Chinese output to Traditional Chinese.

The separate optional Python Argos English-to-Chinese package used locally retains its own included license and model attribution under `.models/en-zh`; consult that package before redistributing it. It is excluded from builds.

## Document parsing

PDF.js (Apache-2.0): https://github.com/mozilla/pdf.js
Mammoth.js (BSD-2-Clause): https://github.com/mwilliamson/mammoth.js
markdown-it (MIT): https://github.com/markdown-it/markdown-it

Exact dependency versions and integrity hashes are in `package-lock.json`. All browser runtime code is bundled locally; model weights are fetched separately. Original demo prose and explanations are part of Gaze Reader.
