const MODEL = "qwen3.8-livetranslate-flash-realtime";
const SITE_ORIGIN = "https://heyuyou071215-droid.github.io";
const WORKSPACE_ID = "ws-exkha2l7m44kgpke";
const MAX_CHUNK_BASE64 = 32_000; // Less than one second of 16-kHz PCM16.
const BYTES_PER_SECOND = 32_000;

function send(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function safeClose(ws, code = 1000, reason = "") {
  try { if (ws && ws.readyState < WebSocket.CLOSING) ws.close(code, reason.slice(0, 100)); } catch {}
}

function sameCode(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" || !expected) return false;
  let difference = candidate.length ^ expected.length;
  for (let i = 0; i < Math.max(candidate.length, expected.length); i++) {
    difference |= (candidate.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: "hyy-qwen-gateway", configured: Boolean(env.DASHSCOPE_API_KEY && env.SITE_ACCESS_CODE) });
    if (url.pathname === "/diag") {
      const started = Date.now();
      try {
        const response = await fetch(`https://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`, { signal: AbortSignal.timeout(10000) });
        return Response.json({ reachable: true, status: response.status, milliseconds: Date.now() - started });
      } catch (error) {
        return Response.json({ reachable: false, error: String(error?.message || error).slice(0, 160), milliseconds: Date.now() - started }, { status: 502 });
      }
    }
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    if (request.headers.get("Origin") !== SITE_ORIGIN) return new Response("Origin denied", { status: 403 });
    if (!env.DASHSCOPE_API_KEY || !env.SITE_ACCESS_CODE) return new Response("Gateway not configured", { status: 503 });

    const pair = new WebSocketPair();
    const [client, browser] = Object.values(pair);
    browser.accept();
    let upstream = null;
    let authenticated = false;
    let connecting = false;
    let finished = false;
    let receivedBytes = 0;
    const maxSeconds = 21600;
    const authTimer = setTimeout(() => { if (!authenticated) safeClose(browser, 1008, "Authentication timeout"); }, 15000);

    async function connectToModel() {
      connecting = true;
      const endpoint = `https://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;
      let response;
      const controller = new AbortController();
      const handshakeTimer = setTimeout(() => controller.abort(), 15000);
      try {
        console.log("Connecting to Bailian realtime WebSocket");
        response = await fetch(endpoint, {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` },
          signal: controller.signal
        });
        clearTimeout(handshakeTimer);
        console.log(`Bailian handshake HTTP ${response.status}`);
        if (!response.webSocket) throw new Error(`百炼连接失败（HTTP ${response.status}）`);
        upstream = response.webSocket;
        upstream.accept();
        upstream.addEventListener("message", event => {
          if (typeof event.data !== "string") return;
          let payload;
          try { payload = JSON.parse(event.data); } catch { return; }
          if (payload.type === "session.created") {
            console.log("Bailian session.created; sending session.update");
            upstream.send(JSON.stringify({
              type: "session.update",
              session: { output_modalities: ["text"], translation: { language: "zh" } }
            }));
          }
          if (payload.type === "session.updated") send(browser, { type: "gateway.ready" });
          if (payload.type === "session.updated" || payload.type === "error") console.log(`Bailian event: ${payload.type}`);
          if (payload.type === "session.finished") {
            send(browser, payload);
            safeClose(upstream); safeClose(browser);
            return;
          }
          if (typeof payload.type === "string" && (
            payload.type.startsWith("conversation.item.") ||
            payload.type.startsWith("response.") ||
            payload.type === "error" ||
            payload.type === "session.created"
          )) send(browser, payload);
        });
        upstream.addEventListener("close", () => {
          if (!finished) send(browser, { type: "gateway.error", message: "千问连接已断开；请检查网络与额度" });
          safeClose(browser);
        });
        upstream.addEventListener("error", () => {
          send(browser, { type: "gateway.error", message: "千问连接发生错误" });
          safeClose(browser, 1011, "Upstream error");
        });
      } catch (error) {
        clearTimeout(handshakeTimer);
        console.error("Bailian connection error", String(error?.message || error).slice(0, 160));
        send(browser, { type: "gateway.error", message: String(error?.message || "连接千问失败").slice(0, 120) });
        safeClose(browser, 1011, "Model connection failed");
      } finally { connecting = false; }
    }

    browser.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > MAX_CHUNK_BASE64 + 500) return safeClose(browser, 1009, "Message too large");
      let message;
      try { message = JSON.parse(event.data); } catch { return safeClose(browser, 1007, "Invalid JSON"); }
      if (!authenticated) {
        if (message.type !== "gateway.auth" || !sameCode(message.code, env.SITE_ACCESS_CODE)) {
          send(browser, { type: "gateway.auth_failed" });
          return safeClose(browser, 1008, "Access denied");
        }
        authenticated = true; clearTimeout(authTimer);
        if (!connecting) ctx.waitUntil(connectToModel());
        return;
      }
      if (!upstream || upstream.readyState !== WebSocket.OPEN || finished) return;
      if (message.type === "session.finish") {
        finished = true;
        upstream.send(JSON.stringify({ type: "session.finish" }));
        return;
      }
      if (message.type !== "input_audio_buffer.append") return;
      if (typeof message.audio !== "string" || message.audio.length < 4 ||
          message.audio.length > MAX_CHUNK_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audio)) {
        return safeClose(browser, 1007, "Invalid audio");
      }
      const bytes = Math.floor(message.audio.length * 3 / 4) - (message.audio.endsWith("==") ? 2 : message.audio.endsWith("=") ? 1 : 0);
      if (bytes <= 0 || bytes > BYTES_PER_SECOND) return safeClose(browser, 1007, "Invalid audio size");
      if (receivedBytes + bytes > maxSeconds * BYTES_PER_SECOND) {
        send(browser, { type: "gateway.limit", seconds: maxSeconds });
        safeClose(upstream); safeClose(browser);
        return;
      }
      receivedBytes += bytes;
      upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: message.audio }));
    });
    browser.addEventListener("close", () => { clearTimeout(authTimer); safeClose(upstream); });
    browser.addEventListener("error", () => { clearTimeout(authTimer); safeClose(upstream); });
    return new Response(null, { status: 101, webSocket: client });
  }
};
