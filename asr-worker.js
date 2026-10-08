// English speech recognition runs in this worker so inference does not block the page.
let transcriber = null;
let loading = null;
let processing = false;
const queue = [];

async function loadModel() {
  if (loading) return loading;
  loading = (async () => {
    const base = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
    const { pipeline, env } = await import(`${base}transformers.min.js`);
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = base;
    transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
      dtype: "q8",
      progress_callback: (event) => {
        if (event.status === "progress" && Number.isFinite(event.progress)) {
          self.postMessage({ type: "progress", percent: Math.floor(event.progress) });
        }
      }
    });
    self.postMessage({ type: "ready" });
    void processQueue();
  })().catch(error => {
    loading = null;
    self.postMessage({ type: "error", message: error?.message || String(error) });
  });
  return loading;
}

async function processQueue() {
  if (processing || !transcriber) return;
  processing = true;
  try {
    while (queue.length) {
      const { id, audio } = queue.shift();
      try {
        const result = await transcriber(audio);
        self.postMessage({ type: "transcript", id, text: String(result?.text || "").trim() });
      } catch (error) {
        self.postMessage({ type: "chunk-error", id, message: error?.message || String(error) });
      }
    }
  } finally {
    processing = false;
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === "load") void loadModel();
  if (data?.type === "audio" && data.audio instanceof Float32Array) {
    queue.push({ id: data.id, audio: data.audio });
    void processQueue();
  }
};
