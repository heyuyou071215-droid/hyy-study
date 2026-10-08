(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const ENDPOINT = String(window.HYY_CLOUD_GATEWAY || "");
  const CODE_KEY = "hyy-study-gateway-code-v1";
  const MAX_RECONNECTS = 8;
  const segments = [];
  const byItem = new Map();
  let socket = null, stream = null, context = null, source = null, processor = null, sink = null;
  let wakeLock = null, timer = null, reconnectTimer = null, finishTimer = null, readyTimer = null;
  let phase = "idle", sessionId = "", startedAt = 0, connectionStartedAt = 0;
  let reconnects = 0, gapStartedAt = 0, sentSeconds = 0, billedAudioTokens = 0, billedTextTokens = 0;
  let missedSeconds = 0, errorText = "", renderScheduled = false, utteranceCount = 0;
  let accessCode = "";

  const isConfigured = /^wss:\/\/[a-z0-9.-]+(?:\:[0-9]+)?(?:\/[^\s]*)?$/i.test(ENDPOINT);
  const nowText = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const formatTime = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const setStatus = (label, detail = "") => { $("qwen-status").textContent = label; if (detail) errorText = detail; metrics(); };
  const dispatchSegment = item => {
    const record = { id: item.id, sessionId, date: item.date, time: item.time, course: item.course,
      en: item.en || "[英文未识别，请核对]", zh: item.zh || "[译文未返回，请核对]",
      origin: "千问实时同传 · 自动结果待核对", savedAt: item.savedAt };
    if (window.HYY_STUDY_SAVE_CLOUD) window.HYY_STUDY_SAVE_CLOUD(record);
  };

  function metrics() {
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const estAudio = Math.max(billedAudioTokens, Math.round(sentSeconds * 7));
    const estimate = (estAudio * 40 + billedTextTokens * 100) / 1_000_000;
    const state = phase === "active" ? "正在收音" : phase === "connecting" ? "连接中" : phase === "stopping" ? "正在结束" : "未收音";
    const parts = [`${state} ${formatTime(elapsed)}`, `${segments.filter(x => x.en || x.zh).length} 段`, `估算模型用量约 ¥${estimate.toFixed(2)}`];
    if (missedSeconds) parts.push(`断线缺口约 ${Math.round(missedSeconds)} 秒`);
    if (errorText) parts.push(errorText);
    $("qwen-metrics").textContent = parts.join(" · ") + "。实际账单与试用抵扣以百炼控制台为准。";
  }
  function render() {
    renderScheduled = false;
    for (const [id, key, empty] of [["qwen-en", "en", "英文原句将在这里显示。"], ["qwen-zh", "zh", "中文译文将在这里显示。"]]) {
      const box = $(id); box.replaceChildren();
      const recent = segments.filter(x => x.en || x.zh || x.gap).slice(-60);
      if (!recent.length) { box.append(Object.assign(document.createElement("p"), { textContent: empty })); continue; }
      for (const item of recent) {
        const p = document.createElement("p"); p.className = "live-line";
        p.textContent = `${item.time}  ${item.gap || item[key] || (key === "zh" ? "[翻译中]" : "[识别中]")}`;
        box.append(p);
      }
      box.scrollTop = box.scrollHeight;
    }
    $("qwen-export").disabled = !segments.some(x => x.en || x.zh || x.gap);
    metrics();
  }
  function scheduleRender() { if (renderScheduled) return; renderScheduled = true; requestAnimationFrame(render); }
  function createSegment(id) {
    if (byItem.has(id)) return byItem.get(id);
    const d = new Date();
    const item = { id: crypto.randomUUID(), time: nowText(), date: today(), course: $("transcript-course").value.trim(),
      savedAt: d.toISOString(), en: "", zh: "", enDone: false, zhDone: false };
    segments.push(item); byItem.set(id, item); scheduleRender(); return item;
  }
  function joinSegments(primary, secondary) {
    if (primary === secondary) return primary;
    if (!primary.en && secondary.en) primary.en = secondary.en;
    if (!primary.zh && secondary.zh) primary.zh = secondary.zh;
    primary.enDone ||= secondary.enDone;
    primary.zhDone ||= secondary.zhDone;
    for (const [key, value] of byItem) if (value === secondary) byItem.set(key, primary);
    const pos = segments.indexOf(secondary); if (pos >= 0) segments.splice(pos, 1);
    scheduleRender(); return primary;
  }
  function persist(item) {
    if (!item.en && !item.zh) return;
    dispatchSegment(item);
    scheduleRender();
  }
  function markGap(seconds, reason) {
    if (seconds < 1) return;
    missedSeconds += seconds;
    const gap = { id: crypto.randomUUID(), time: nowText(), date: today(), course: $("transcript-course").value.trim(),
      savedAt: new Date().toISOString(), en: "", zh: "", gap: `[约 ${Math.round(seconds)} 秒音频未送达：${reason}]` };
    segments.push(gap);
    dispatchSegment({ ...gap, en: gap.gap, zh: "[此处存在记录缺口]" });
    scheduleRender();
  }
  function speak(text) {
    if (!$("qwen-speak").checked || !text || !("speechSynthesis" in window)) return;
    if (++utteranceCount > 1000) utteranceCount = 1;
    speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance(text); voice.lang = "zh-CN"; voice.rate = 1;
    speechSynthesis.speak(voice);
  }
  function handleModelEvent(event) {
    switch (event.type) {
      case "conversation.item.created": {
        if (event.item?.role === "assistant" && event.item?.id && event.previous_item_id) {
          const sourceItem = createSegment(event.previous_item_id);
          const existing = byItem.get(event.item.id);
          byItem.set(event.item.id, existing ? joinSegments(sourceItem, existing) : sourceItem);
        }
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        if (event.item_id && event.delta) { createSegment(event.item_id).en += event.delta; scheduleRender(); }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const item = createSegment(event.item_id || crypto.randomUUID());
        item.en = String(event.transcript || item.en).trim(); item.enDone = true; persist(item); break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const item = createSegment(event.item_id || crypto.randomUUID());
        item.en = "[英文识别失败，请核对音频]"; item.enDone = true; persist(item); break;
      }
      case "response.text.delta": {
        if (event.item_id && event.delta) { createSegment(event.item_id).zh += event.delta; scheduleRender(); }
        break;
      }
      case "response.text.done": {
        const item = createSegment(event.item_id || crypto.randomUUID());
        item.zh = String(event.text || item.zh).trim(); item.zhDone = true; persist(item); speak(item.zh); break;
      }
      case "response.done": {
        const usage = event.response?.usage;
        if (usage) {
          billedAudioTokens += Number(usage.input_tokens_details?.audio_tokens || 0);
          billedTextTokens += Number(usage.output_tokens_details?.text_tokens || 0);
          metrics();
        }
        break;
      }
      case "error": setStatus("千问返回错误", String(event.error?.message || "请停止后重试").slice(0, 150)); break;
      case "session.finished": finalizeStop(); break;
    }
  }
  function socketMessage(event) {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "gateway.auth_failed") {
      localStorage.removeItem(CODE_KEY); accessCode = "";
      setStatus("网站访问码有误", "请重新输入访问码");
      finalizeStop(); $("qwen-code-dialog").showModal(); return;
    }
    if (data.type === "gateway.error") { setStatus("网关连接失败", String(data.message || "请稍后重试")); finalizeStop(); return; }
    if (data.type === "gateway.ready") {
      if (phase !== "connecting") return;
      clearTimeout(readyTimer); readyTimer = null;
      if (gapStartedAt) { markGap((Date.now() - gapStartedAt) / 1000, "连接中断"); gapStartedAt = 0; }
      reconnects = 0; connectionStartedAt = Date.now();
      setStatus("千问已连接 · 启动收音", "正在准备音频处理器");
      startMicrophone().catch(error => { setStatus("麦克风启动失败", error?.message || "请检查权限"); finalizeStop(); });
      return;
    }
    if (data.type === "gateway.limit") { setStatus("已达到单次用量限制", "请导出记录后再决定是否继续"); stop(); return; }
    handleModelEvent(data);
  }
  function connect() {
    if (phase === "idle" || phase === "stopping") return;
    phase = "connecting"; setStatus("连接千问中", "请等待连接就绪后再开始讲话");
    const ws = new WebSocket(ENDPOINT); socket = ws;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { if (socket === ws && phase === "connecting") { setStatus("千问响应超时", "正在重连，尚未开始收音"); ws.close(); } }, 30000);
    ws.onopen = () => { if (socket === ws) ws.send(JSON.stringify({ type: "gateway.auth", code: accessCode })); };
    ws.onmessage = socketMessage;
    ws.onerror = () => { if (socket === ws) setStatus("连接出现问题", "正在检查网络"); };
    ws.onclose = () => {
      if (socket !== ws) return;
      clearTimeout(readyTimer); readyTimer = null;
      socket = null;
      if (phase === "idle" || phase === "stopping") { finalizeStop(); return; }
      if (!gapStartedAt) gapStartedAt = Date.now();
      if (++reconnects > MAX_RECONNECTS) { setStatus("多次重连失败", "麦克风已停止；请检查网络后重新开始"); finalizeStop(); return; }
      const delay = Math.min(2000 * reconnects, 10000);
      setStatus("连接中断 · 正在重连", `${Math.round(delay / 1000)} 秒后尝试第 ${reconnects} 次重连`);
      reconnectTimer = setTimeout(connect, delay);
    };
  }
  function base64(buffer) {
    const bytes = new Uint8Array(buffer); let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function sendPcm(buffer) {
    if (phase !== "active" || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { if (!gapStartedAt) gapStartedAt = Date.now(); return; }
    if (gapStartedAt) { markGap((Date.now() - gapStartedAt) / 1000, "网络发送缓慢"); gapStartedAt = 0; }
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64(buffer) }));
    sentSeconds += buffer.byteLength / 32000;
    if (Math.floor(sentSeconds) % 5 === 0) metrics();
  }
  async function ensureStream() {
    if (stream) return;
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    if (phase === "idle" || phase === "stopping") { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (phase === "active") { setStatus("麦克风已断开"); stop(); } });
  }
  async function startMicrophone() {
    if (phase !== "connecting") return;
    await ensureStream();
    if (phase !== "connecting" || !stream) return;
    if (!context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      context = new AudioContext();
      await context.audioWorklet.addModule(new URL("pcm-worklet.js", location.href));
      if (phase !== "connecting") { releaseMic(); return; }
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, "hyy-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      sink = context.createGain(); sink.gain.value = 0;
      processor.port.onmessage = ({ data }) => { if (data instanceof ArrayBuffer) sendPcm(data); };
      source.connect(processor); processor.connect(sink); sink.connect(context.destination);
      await context.resume();
      if (phase !== "connecting") { releaseMic(); return; }
    }
    phase = "active"; $("qwen-stop").disabled = false; $("qwen-start").disabled = true;
    if (navigator.wakeLock?.request) navigator.wakeLock.request("screen").then(lock => { if (phase === "active") wakeLock = lock; else lock.release(); }).catch(() => {});
    setStatus("千问收音中", "请先说一句英文检查原文和译文是否出现");
  }
  function releaseMic() {
    try { processor?.disconnect(); source?.disconnect(); sink?.disconnect(); } catch {}
    processor = null; source = null; sink = null;
    try { context?.close(); } catch {} context = null;
    try { stream?.getTracks().forEach(track => track.stop()); } catch {} stream = null;
    try { wakeLock?.release(); } catch {} wakeLock = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
  function finalizeStop() {
    clearTimeout(reconnectTimer); clearTimeout(finishTimer); clearTimeout(readyTimer); clearInterval(timer);
    reconnectTimer = null; finishTimer = null; readyTimer = null; timer = null;
    if (gapStartedAt) { markGap((Date.now() - gapStartedAt) / 1000, "连接中断"); gapStartedAt = 0; }
    releaseMic();
    try { socket?.close(); } catch {} socket = null;
    phase = "idle"; $("qwen-start").disabled = !isConfigured; $("qwen-stop").disabled = true;
    window.dispatchEvent(new CustomEvent("hyy-cloud-state", { detail: { active: false } }));
    if (segments.length) for (const item of segments) if ((item.en || item.zh) && !item.gap) persist(item);
    if (!$("qwen-status").textContent.includes("失败") && !$("qwen-status").textContent.includes("有误")) setStatus("已停止并保存", "麦克风和连接已释放");
    scheduleRender();
  }
  function stop() {
    if (phase === "idle" || phase === "stopping") return;
    const wasReady = phase === "active";
    phase = "stopping"; releaseMic(); $("qwen-stop").disabled = true; setStatus("正在补完最后译文");
    if (wasReady && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.finish" }));
      finishTimer = setTimeout(finalizeStop, 12000);
    } else finalizeStop();
  }
  function start(code) {
    if (phase !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { setStatus("浏览器不支持云端收音", "请使用较新的 Chrome 或 Edge"); return; }
    if (!$("stop-listening").disabled) { setStatus("请先停止本机收音", "同一时间只能使用一种收音模式"); return; }
    if (/军事理论|中国近现代史纲要/.test($("transcript-course").value)) { setStatus("该课程不纳入个人记录"); return; }
    accessCode = code; sessionId = crypto.randomUUID(); startedAt = Date.now(); phase = "connecting";
    segments.length = 0; byItem.clear(); reconnects = 0; gapStartedAt = 0; sentSeconds = 0;
    billedAudioTokens = 0; billedTextTokens = 0; missedSeconds = 0; errorText = "";
    $("qwen-start").disabled = true; $("qwen-stop").disabled = false;
    window.dispatchEvent(new CustomEvent("hyy-cloud-state", { detail: { active: true } }));
    timer = setInterval(metrics, 1000); scheduleRender();
    setStatus("等待麦克风授权", "允许麦克风后才连接千问；浏览器通常会记住这项许可");
    void ensureStream().then(() => { if (phase === "connecting" && stream) connect(); })
      .catch(error => { setStatus("麦克风启动失败", error?.message || "请检查权限"); finalizeStop(); });
  }
  function exportSession() {
    const lines = segments.map(x => `### ${x.time}\n\n英文原句：${x.gap || x.en || "[未识别]"}\n\n中文译文：${x.gap ? "[此处存在记录缺口]" : x.zh || "[未翻译]"}`).join("\n\n");
    const blob = new Blob([`# HYY study · 千问课堂记录\n\n模型自动识别与翻译，需核对。估算费用并非账单。\n\n${lines}\n`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `HYY-study-千问记录-${today()}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function boot() {
    if (!isConfigured) { setStatus("千问服务待配置", "安全网关和模型密钥尚未接入，现有本机模式可用"); return; }
    $("qwen-start").disabled = false; setStatus("千问听译可启动", "点击开始后才会收音并产生模型用量");
    $("qwen-start").addEventListener("click", () => {
      const code = localStorage.getItem(CODE_KEY);
      if (code) start(code); else $("qwen-code-dialog").showModal();
    });
    $("qwen-code-form").addEventListener("submit", event => {
      event.preventDefault(); const code = $("qwen-code-input").value.trim();
      if (!code) return;
      $("qwen-code-dialog").close(); $("qwen-code-input").value = "";
      localStorage.setItem(CODE_KEY, code); start(code);
    });
    for (const id of ["qwen-code-close", "qwen-code-cancel"]) $(id).addEventListener("click", () => $("qwen-code-dialog").close());
    $("qwen-stop").addEventListener("click", stop);
    $("qwen-export").addEventListener("click", exportSession);
    window.addEventListener("pagehide", finalizeStop);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && phase !== "idle") stop(); });
  }
  boot();
})();
