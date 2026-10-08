(() => {
  "use strict";
  const source = window.COURSE_DATA || { courses: [], periodTimes: [] };
  const KEY = "course-study-2601-v1";
  const blank = () => ({ courses: [], transcripts: [], summaries: [], notes: [], terms: [], tasks: [] });
  let state = blank();
  let week = startOfWeek(new Date());
  let selectedDay = (new Date().getDay() + 6) % 7;
  let activeMic = null;
  let activeConnection = null;
  let liveRecognition = null;
  let liveTranslator = null;
  let liveRunning = false;
  let liveSegments = [];
  let liveSessionId = null;
  let liveStartedAt = 0;
  let liveRestartTimer = null;
  let liveRestartAttempts = 0;
  let liveMetricsTimer = null;
  let liveWakeLock = null;
  let liveSaveFailed = false;
  let translationQueue = [];
  let translationBusy = false;
  let liveRenderPending = false;
  let transcriptVisible = 100;
  let modelPromise = null;
  let zipPromise = null;
  const seenEnglishTerms = new Set();
  let toastTimer;

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const parseDate = (value) => { const [y, m, d] = value.split("-").map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
  function startOfWeek(date) { const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
  const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const forbidden = (text) => /军事理论|中国近现代史纲要/.test(text || "");
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "null");
      if (parsed && typeof parsed === "object") for (const k of Object.keys(state)) state[k] = Array.isArray(parsed[k]) ? parsed[k] : [];
    } catch { state = blank(); toast("本机数据读取失败；请检查浏览器存储设置"); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch { toast("浏览器未能保存；请导出备份以免丢失"); return false; }
  }
  function toast(message) {
    const node = $("toast"); node.textContent = message; node.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), 3000);
  }
  function download(name, text, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const htmlDate = (date) => `${date.getMonth() + 1}月${date.getDate()}日`;
  const courseList = () => [...source.courses, ...state.courses].filter(x => !forbidden(x.title));
  function selectedCourses(date) {
    return courseList().filter(x => x.date === date && (!$("major-only").checked || x.category === "major"))
      .sort((a, b) => a.startPeriod - b.startPeriod || a.title.localeCompare(b.title, "zh-CN"));
  }
  function weekText() {
    const end = addDays(week, 6);
    return week.getMonth() === end.getMonth()
      ? `${week.getMonth() + 1}月${week.getDate()}日—${end.getDate()}日`
      : `${week.getMonth() + 1}月${week.getDate()}日—${end.getMonth() + 1}月${end.getDate()}日`;
  }
  function renderWeek() {
    $("week-range").textContent = weekText();
    const grid = $("week-grid"); grid.replaceChildren();
    const corner = el("div", "grid-head", "节次"); corner.style.gridArea = "1 / 1"; grid.append(corner);
    const now = iso(new Date());
    for (let d = 0; d < 7; d++) {
      const date = addDays(week, d), key = iso(date);
      const head = el("div", `grid-head${key === now ? " today" : ""}`);
      head.style.gridArea = `1 / ${d + 2}`;
      head.append(el("span", "day-name", days[d]), el("span", "day-date", `${date.getMonth() + 1}.${date.getDate()}`));
      grid.append(head);
    }
    for (let p = 1; p <= 12; p++) {
      const time = source.periodTimes[p - 1] || { start: "", end: "" };
      const label = el("div", "grid-time"); label.style.gridArea = `${p + 1} / 1`;
      label.append(el("strong", "", `${p}`), el("span", "", time.start)); grid.append(label);
      for (let d = 0; d < 7; d++) {
        const cell = el("div", "grid-cell"); cell.style.gridArea = `${p + 1} / ${d + 2}`; grid.append(cell);
      }
    }
    for (let d = 0; d < 7; d++) {
      const date = iso(addDays(week, d));
      for (const course of selectedCourses(date)) {
        const card = el("button", `course-card ${course.category === "general" ? "general" : ""} ${course.manual ? "manual" : ""}`);
        card.type = "button"; card.style.gridColumn = `${d + 2}`;
        card.style.gridRow = `${course.startPeriod + 1} / ${course.endPeriod + 2}`;
        card.setAttribute("aria-label", `${course.title}，${course.start} 至 ${course.end}，查看详情`);
        card.append(el("span", "card-time", `${course.start}–${course.end}`), el("span", "card-title", course.title));
        if (course.teacher) card.append(el("span", "card-meta", course.teacher));
        if (course.room) card.append(el("span", "card-meta", course.room));
        if (course.doubtful || course.manual) card.append(el("span", "card-tag", course.manual ? "待核对" : "原表有疑点"));
        card.addEventListener("click", () => showCourse(course)); grid.append(card);
      }
    }
    renderMobileWeek();
  }
  function renderMobileWeek() {
    const summary = $("mobile-week"), detail = $("mobile-day"); summary.replaceChildren(); detail.replaceChildren();
    for (let d = 0; d < 7; d++) {
      const date = addDays(week, d), events = selectedCourses(iso(date));
      const button = el("button", `mobile-day-button${d === selectedDay ? " selected" : ""}`);
      button.type = "button"; button.setAttribute("aria-label", `${days[d]} ${htmlDate(date)}，${events.length}节安排`);
      button.append(el("span", "", days[d].slice(1)), el("strong", "", `${date.getDate()}`), el("span", "", `${events.length}课`));
      button.addEventListener("click", () => { selectedDay = d; renderMobileWeek(); }); summary.append(button);
    }
    const date = addDays(week, selectedDay), events = selectedCourses(iso(date));
    detail.append(el("h2", "", `${days[selectedDay]} · ${htmlDate(date)}`));
    if (!events.length) detail.append(el("p", "empty-copy", "这一天没有已记录课程。"));
    for (const course of events) {
      const button = el("button", `mobile-course ${course.category === "general" ? "general" : ""}`);
      button.type = "button";
      button.append(el("span", "", `${course.start}–${course.end} · 第 ${course.startPeriod}–${course.endPeriod} 节`), el("strong", "", course.title), el("span", "", `${course.teacher || "老师未注明"} · ${course.room || "地点未注明"}${course.doubtful || course.manual ? " · 待核对" : ""}`));
      button.addEventListener("click", () => showCourse(course)); detail.append(button);
    }
  }
  function showCourse(course) {
    $("course-dialog-title").textContent = course.title;
    const body = $("course-dialog-body"); body.replaceChildren();
    const dl = el("dl");
    const pairs = [
      ["日期", `${course.date} · ${days[course.day ?? ((parseDate(course.date).getDay() + 6) % 7)]}`],
      ["时间", `${course.start}–${course.end} · 第 ${course.startPeriod}–${course.endPeriod} 节`],
      ["老师", course.teacher || "原表未提供"], ["地点", course.room || "原表未提供"],
      ["类别", course.category === "major" ? "专业课" : "其他课程"],
      ["来源", course.manual ? "手动录入 · 待核对" : `${source.source} · ${course.sourceWeek} · ${course.sourceCell}`],
    ];
    if (course.doubtful) pairs.push(["疑点", "原表此处教师姓名被截断，请以任课通知核对。"]);
    if (course.sourceText) pairs.push(["原文", course.sourceText]);
    for (const [key, value] of pairs) { const row = el("div", "detail-grid"); row.append(el("dt", "", key), el("dd", "", value)); dl.append(row); }
    body.append(dl);
    if (course.manual) {
      const remove = el("button", "ghost-button", "删除这条手动记录"); remove.type = "button";
      remove.addEventListener("click", () => { state.courses = state.courses.filter(x => x.id !== course.id); save(); $("course-dialog").close(); renderWeek(); toast("已删除手动记录"); }); body.append(remove);
    }
    $("course-dialog").showModal();
  }
  function setupCourseForm() {
    for (const name of ["startPeriod", "endPeriod"]) {
      const select = $("course-form").elements.namedItem(name);
      for (let n = 1; n <= 12; n++) { const opt = el("option", "", `第 ${n} 节`); opt.value = `${n}`; select.append(opt); }
    }
    $("course-form").elements.namedItem("endPeriod").value = "2";
    $("add-course").addEventListener("click", () => { $("course-form").elements.namedItem("date").value = iso(addDays(week, selectedDay)); $("add-dialog").showModal(); });
    document.querySelectorAll(".close-dialog").forEach(x => x.addEventListener("click", () => $("add-dialog").close()));
    $("course-form").addEventListener("submit", (event) => {
      event.preventDefault(); const f = new FormData(event.currentTarget);
      const title = String(f.get("title") || "").trim(), startPeriod = Number(f.get("startPeriod")), endPeriod = Number(f.get("endPeriod"));
      if (!title || forbidden(title)) return toast("这门课程不纳入个人课表");
      if (endPeriod < startPeriod) return toast("结束节次不能早于开始节次");
      const date = String(f.get("date")), time = source.periodTimes;
      state.courses.push({ id: uid(), date, day: (parseDate(date).getDay() + 6) % 7, startPeriod, endPeriod,
        start: time[startPeriod - 1].start, end: time[endPeriod - 1].end, title,
        teacher: String(f.get("teacher") || "").trim(), room: String(f.get("room") || "").trim(), category: String(f.get("category")), manual: true, doubtful: true });
      save(); $("add-dialog").close(); event.currentTarget.reset(); week = startOfWeek(parseDate(date)); selectedDay = (parseDate(date).getDay() + 6) % 7; renderWeek(); toast("课程已保存，标记为待核对");
    });
  }
  function switchView(name) {
    for (const view of document.querySelectorAll(".view")) { const on = view.id === `view-${name}`; view.hidden = !on; view.classList.toggle("active", on); }
    document.querySelectorAll(".nav-item").forEach(x => x.classList.toggle("active", x.dataset.view === name));
    if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  function setupNavigation() {
    document.querySelectorAll(".nav-item").forEach(x => x.addEventListener("click", () => switchView(x.dataset.view)));
    const names = ["schedule", "classroom", "summary", "notes", "glossary", "plan"];
    const initial = location.hash.slice(1); switchView(names.includes(initial) ? initial : "schedule");
    window.addEventListener("hashchange", () => { const name = location.hash.slice(1); if (names.includes(name)) switchView(name); });
  }
  function setupSchedule() {
    $("prev-week").addEventListener("click", () => { week = addDays(week, -7); renderWeek(); });
    $("next-week").addEventListener("click", () => { week = addDays(week, 7); renderWeek(); });
    $("this-week").addEventListener("click", () => { week = startOfWeek(new Date()); selectedDay = (new Date().getDay() + 6) % 7; renderWeek(); });
    $("jump-date").addEventListener("change", (e) => { if (!e.target.value) return; const date = parseDate(e.target.value); week = startOfWeek(date); selectedDay = (date.getDay() + 6) % 7; renderWeek(); });
    $("major-only").addEventListener("change", renderWeek);
    $("jump-date").value = iso(new Date()); setupCourseForm(); renderWeek();
  }
  function addEmpty(container, message) { container.replaceChildren(el("p", "empty-copy", message)); }
  function removeItem(key, id, render) { state[key] = state[key].filter(x => x.id !== id); save(); render(); toast("已删除"); }
  function setupClassroom() {
    $("transcript-date").value = iso(new Date());
    setupLiveTranslation();
    $("translate-manual").addEventListener("click", async () => {
      const en = $("transcript-en").value.trim();
      if (!en) return toast("请先填写英文原句");
      const button = $("translate-manual"); button.disabled = true; button.textContent = "正在加载翻译模型…";
      try {
        const translator = await makeTranslator();
        $("transcript-zh").value = polishTranslation(en, await translator.translate(en));
        toast("已生成译文，请核对专业术语、数字和否定");
      } catch (error) { toast(`翻译未完成：${error?.message || "模型加载失败"}`); }
      finally { button.disabled = false; button.textContent = "翻译英文原句"; }
    });
    $("save-transcript").addEventListener("click", () => {
      const en = $("transcript-en").value.trim(), zh = $("transcript-zh").value.trim();
      if (!en && !zh) return toast("请先填写原句或译文");
      const course = $("transcript-course").value.trim(); if (forbidden(course)) return toast("这门课程不纳入个人记录");
      state.transcripts.unshift({ id: uid(), course, date: $("transcript-date").value || iso(new Date()), en, zh, savedAt: new Date().toISOString(), origin: "手动录入" });
      save(); $("transcript-en").value = ""; $("transcript-zh").value = ""; renderTranscripts(); toast("片段已保存在当前浏览器");
    });
    $("export-transcript").addEventListener("click", () => {
      const md = state.transcripts.map(x => `## ${x.date} · ${x.course || "未填写课程"}\n\n英文原句：${x.en || "未填写"}\n\n中文译文：${x.zh || "未填写"}\n\n来源：${x.origin}\n`).join("\n---\n\n");
      download("HYY-study-课堂记录.md", `# 课堂记录\n\n${md || "暂无记录。"}\n`, "text/markdown;charset=utf-8");
    });
    renderTranscripts();
  }
  function setLiveStatus(label, help) {
    $("translation-status").textContent = label;
    $("translation-badge").textContent = label;
    if (help) $("translation-help").textContent = help;
  }
  function polishTranslation(en, raw) {
    let zh = String(raw || "").replaceAll("趋同", /\bconverg(?:e|es|ed|ence|ent)\b/i.test(en) ? "收敛" : "趋同");
    const terms = [
      { en: "gradient descent", zh: "梯度下降" }, { en: "learning rate", zh: "学习率" },
      { en: "neural network", zh: "神经网络" }, { en: "loss function", zh: "损失函数" },
      { en: "overfitting", zh: "过拟合" }, { en: "converge", zh: "收敛" },
      ...state.terms.filter(x => x.en && x.zh),
    ];
    for (const term of terms) {
      const key = term.en.toLocaleLowerCase();
      if (!en.toLocaleLowerCase().includes(key) || seenEnglishTerms.has(key) || !zh.includes(term.zh)) continue;
      zh = zh.replace(term.zh, `${term.zh}（${term.en}）`);
      seenEnglishTerms.add(key);
    }
    return zh;
  }
  function renderLive() {
    liveRenderPending = false;
    for (const [id, field, empty] of [["live-en", "en", "英文转录将在这里显示。"], ["live-zh", "zh", "中文翻译将在这里显示。"]]) {
      const box = $(id); box.replaceChildren();
      if (!liveSegments.length) { box.append(el("p", "", empty)); continue; }
      for (const segment of liveSegments.slice(-60)) {
        const line = el("p", "live-line", `${segment.time}  ${segment[field] || (field === "zh" ? "[翻译中]" : "[听不清]")}`);
          box.append(line);
      }
      box.scrollTop = box.scrollHeight;
    }
    $("save-live").disabled = !liveSegments.length;
    $("export-live").disabled = !liveSegments.length;
    renderLiveMetrics();
  }
  function queueLiveRender() {
    if (liveRenderPending) return;
    liveRenderPending = true;
    requestAnimationFrame(renderLive);
  }
  function renderLiveMetrics() {
    const elapsed = liveStartedAt ? Math.floor((Date.now() - liveStartedAt) / 1000) : 0;
    const duration = `${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:${String(Math.floor(elapsed / 60) % 60).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    $("session-metrics").textContent = liveStartedAt
      ? `${liveRunning ? "收音中" : "本次已停止"} ${duration} · ${liveSegments.length} 段 · 待翻译 ${translationQueue.length + Number(translationBusy)} 段 · ${liveSaveFailed ? "自动保存失败，请立即导出" : "已自动保存在当前浏览器"}`
      : "本次尚未开始 · 记录会自动保存在当前浏览器";
  }
  function saveLiveProgress() {
    liveSaveFailed = !save();
    renderLiveMetrics();
  }
  async function pumpTranslation() {
    if (translationBusy || !liveTranslator) return;
    translationBusy = true;
    try {
      while (translationQueue.length && liveTranslator) {
        const segment = translationQueue.shift();
        try {
          segment.zh = polishTranslation(segment.en, await liveTranslator.translate(segment.en)) || "[译文为空，请核对英文原句]";
          if ($("play-translation").checked && liveRunning && "speechSynthesis" in window) {
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(segment.zh); utterance.lang = "zh-CN"; speechSynthesis.speak(utterance);
          }
        } catch { segment.zh = "[翻译失败，请核对英文原句]"; }
        saveLiveProgress();
        queueLiveRender();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { translationBusy = false; renderLiveMetrics(); }
  }
  function enqueueTranslation(segment) {
    if (translationQueue.length >= 300) {
      segment.zh = "[翻译排队过长，仅保存英文原句；可课后手动补译]";
      setLiveStatus("收音中 · 译文延迟", "英文原句仍会自动保存；翻译队列已满，请课后核对并补译。建议关闭中文朗读。 ");
      return;
    }
    translationQueue.push(segment);
    void pumpTranslation();
  }
  function makeTranslator() {
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      const vendorBase = location.hostname.endsWith("github.io")
        ? "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/"
        : new URL("./vendor/", location.href).href;
      const { pipeline, env } = await import(`${vendorBase}transformers.min.js`);
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = vendorBase;
      const model = await pipeline("translation", "Xenova/opus-mt-en-zh", { dtype: "q8" });
      return { translate: async (text) => (await model(text, { max_new_tokens: 256 }))?.[0]?.translation_text || "" };
    })().catch((error) => { modelPromise = null; throw error; });
    return modelPromise;
  }
  function setupLiveTranslation() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setLiveStatus("此浏览器不支持收音", "当前浏览器没有提供语音识别接口。请使用支持 Web Speech API 的浏览器；云端课堂服务仍需配置安全密钥。");
      return;
    }
    $("start-listening").disabled = false;
    setLiveStatus("可尝试收音", "点击开始后，浏览器会请求麦克风权限。语音识别可能由浏览器服务商处理音频；英中翻译由页面内的 OPUS-MT 模型完成，首次使用需下载并缓存在此浏览器。");
    $("start-listening").addEventListener("click", () => {
      if (liveRunning) return;
      const course = $("transcript-course").value.trim();
      if (forbidden(course)) return toast("这门课程不纳入个人记录");
      liveSegments = [];
      translationQueue = [];
      liveSessionId = uid();
      const sessionId = liveSessionId;
      liveStartedAt = Date.now();
      liveSaveFailed = false;
      liveRestartAttempts = 0;
      renderLive();
      liveRunning = true;
      $("start-listening").disabled = true;
      $("stop-listening").disabled = false;
      liveMetricsTimer = setInterval(renderLiveMetrics, 10000);
      setLiveStatus("准备中", "正在连接浏览器语音识别；翻译模型会在后台准备。首次使用可能需要下载模型。");
      try {
        const recognition = new Recognition();
        recognition.lang = "en-US";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (!result.isFinal) continue;
            const en = String(result[0]?.transcript || "").trim();
            if (!en) continue;
            liveRestartAttempts = 0;
            const now = new Date();
            const segment = { id: uid(), sessionId: liveSessionId, time: now.toLocaleTimeString("zh-CN", { hour12: false }), course, date: $("transcript-date").value || iso(now), en, zh: "", savedAt: now.toISOString(), origin: "浏览器语音识别 · 自动翻译待核对" };
            liveSegments.push(segment);
            state.transcripts.unshift(segment);
            saveLiveProgress();
            enqueueTranslation(segment);
            queueLiveRender();
          }
        };
        recognition.onerror = (event) => {
          const reason = event.error === "not-allowed" ? "麦克风权限被拒绝" : event.error === "no-speech" ? "暂未识别到讲话" : `语音识别中断：${event.error}`;
          if (event.error === "no-speech") liveRestartAttempts = 0;
          const help = event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "请在手机 Chrome 或 Edge 中直接打开网址，在系统权限和浏览器的网站设置中允许麦克风，然后刷新页面重试。部分应用内置浏览器不会授予网页麦克风权限。已识别的片段仍可导出。"
            : "检查网络和麦克风后可重新开始。已识别的英文会保存在当前浏览器，也可导出。";
          setLiveStatus(reason, help);
          if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") stopLive();
        };
        recognition.onend = () => {
          if (!liveRunning || liveRecognition !== recognition) return;
          clearTimeout(liveRestartTimer);
          liveRestartAttempts++;
          if (liveRestartAttempts > 12) {
            stopLive();
            setLiveStatus("语音识别反复中断", "已停止自动重试；请检查网络、麦克风和浏览器权限后重新开始。已识别的英文已保存。");
            return;
          }
          const delay = Math.min(1000 * 2 ** Math.min(liveRestartAttempts - 1, 4), 15000);
          setLiveStatus("识别中断 · 正在重连", `${Math.ceil(delay / 1000)} 秒后自动重试；已识别的英文已保存在当前浏览器。`);
          liveRestartTimer = setTimeout(() => {
            if (!liveRunning || liveRecognition !== recognition) return;
            try { recognition.start(); } catch { recognition.onend(); }
          }, delay);
        };
        liveRecognition = recognition;
        recognition.start();
        setLiveStatus("正在收音 · 模型加载中", "英文识别已启动；模型准备期间英文原句会先保存，之后自动补译。");
        if (navigator.wakeLock?.request) navigator.wakeLock.request("screen").then(lock => { if (liveRunning) liveWakeLock = lock; else lock.release(); }).catch(() => {});
        makeTranslator().then(translator => {
          if (!liveRunning || liveSessionId !== sessionId) return;
          liveTranslator = translator;
          setLiveStatus("正在收音翻译", "英文原句实时保存；中文译文逐段补上。请核对关键术语、否定、数字和公式。");
          void pumpTranslation();
        }).catch((error) => {
          if (liveRunning && liveSessionId === sessionId) setLiveStatus("收音中 · 翻译模型失败", `英文仍自动保存；翻译模型未能加载：${error?.message || "未知错误"}。请检查网络后重新开始。`);
        });
      } catch (error) {
        stopLive();
        setLiveStatus("启动失败", `浏览器未能启动课堂收音：${error?.message || "未知错误"}。请检查权限、网络与浏览器支持情况。`);
      }
    });
    $("stop-listening").addEventListener("click", stopLive);
    $("save-live").addEventListener("click", () => {
      if (!liveSegments.length) return;
      saveLiveProgress(); renderTranscripts(); toast(liveSaveFailed ? "保存失败，请立即导出本次记录" : "本次片段已保存在当前浏览器");
    });
    $("export-live").addEventListener("click", () => {
      if (!liveSegments.length) return;
      const lines = liveSegments.map(x => `### ${x.time}\n\n英文原句：${x.en}\n\n中文译文：${x.zh || "[翻译未完成]"}`).join("\n\n");
      download(`HYY-study-实时记录-${iso(new Date())}.md`, `# 课堂实时记录\n\n自动识别与翻译结果，均需核对。\n\n${lines}\n`, "text/markdown;charset=utf-8");
    });
  }
  function stopLive() {
    liveRunning = false;
    clearTimeout(liveRestartTimer);
    clearInterval(liveMetricsTimer);
    liveRestartTimer = null;
    liveMetricsTimer = null;
    try { liveRecognition?.abort(); } catch {}
    liveRecognition = null;
    liveTranslator = null;
    for (const segment of translationQueue) if (!segment.zh) segment.zh = "[翻译未完成，请核对英文原句]";
    translationQueue = [];
    queueLiveRender();
    try { liveWakeLock?.release(); } catch {}
    liveWakeLock = null;
    if (liveSegments.length) saveLiveProgress();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    $("start-listening").disabled = !(window.SpeechRecognition || window.webkitSpeechRecognition);
    $("stop-listening").disabled = true;
    if (["准备中", "正在收音翻译", "正在收音 · 模型加载中", "正在下载翻译模型", "收音中 · 翻译模型失败", "收音中 · 译文延迟", "识别中断 · 正在重连"].includes($("translation-status").textContent)) setLiveStatus("已停止收音", "麦克风已停止。已识别的英文保存在当前浏览器；可导出本次记录。");
    renderLiveMetrics();
  }
  function renderTranscripts() {
    const list = $("transcript-list"); list.replaceChildren(); $("transcript-count").textContent = `${state.transcripts.length} 段`;
    if (!state.transcripts.length) return addEmpty(list, "还没有保存课堂片段。");
    for (const item of state.transcripts.slice(0, transcriptVisible)) {
      const row = el("article", "list-item"), main = el("div"), actions = el("div", "item-actions");
      main.append(el("div", "list-meta", `${item.date} · ${item.course || "未填写课程"} · ${item.origin}`), el("h3", "", item.zh || "未填写中文译文"), el("p", "", item.en || "未填写英文原句"));
      if (item.zh && "speechSynthesis" in window) { const play = el("button", "small-button", "播放中文"); play.addEventListener("click", () => { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(item.zh); u.lang = "zh-CN"; speechSynthesis.speak(u); }); actions.append(play); }
      const del = el("button", "small-button", "删除"); del.addEventListener("click", () => removeItem("transcripts", item.id, renderTranscripts)); actions.append(del); row.append(main, actions); list.append(row);
    }
    if (state.transcripts.length > transcriptVisible) {
      const more = el("button", "secondary-button", `再显示 100 段 · 还有 ${state.transcripts.length - transcriptVisible} 段`);
      more.type = "button"; more.addEventListener("click", () => { transcriptVisible += 100; renderTranscripts(); }); list.append(more);
    }
  }
  function extractOutline(text) {
    const names = ["知识框架", "重点", "术语", "公式", "例子", "疑问", "复习题"];
    const groups = Object.fromEntries(names.map(x => [x, []]));
    const lines = text.split(/\r?\n/);
    let currentPage = "";
    lines.forEach((raw, index) => {
      const line = raw.trim(); if (!line) return;
      const page = (line.match(/^第\s*\d+\s*页$/) || [])[0];
      if (page) { currentPage = page; return; }
      const position = (line.match(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|第\s*\d+\s*页)/) || [])[0] || (currentPage ? `${currentPage} · 第 ${index + 1} 行` : `第 ${index + 1} 行`);
      const item = { text: line, line: index, position };
      if (/^(?:#+\s*|[一二三四五六七八九十]+[、.]|\d+[.)、])/.test(line)) groups["知识框架"].push(item);
      if (/重点|关键|important|note that/i.test(line)) groups["重点"].push(item);
      if (/术语|定义|means|defined as/i.test(line)) groups["术语"].push(item);
      if (/公式|\b[A-Za-z][A-Za-z0-9_]*\s*=|∑|∫|\btheorem\b/i.test(line)) groups["公式"].push(item);
      if (/例如|例子|example|for instance/i.test(line)) groups["例子"].push(item);
      if (/[?？]|疑问|不确定|听不清|推测/.test(line)) groups["疑问"].push(item);
      if (/复习题|练习题|思考题/.test(line)) groups["复习题"].push(item);
    });
    return groups;
  }
  function renderOutline(text, outline) {
    const box = $("outline-preview"); box.replaceChildren();
    const count = Object.values(outline).reduce((n, x) => n + x.length, 0);
    if (!count) return addEmpty(box, "原文中没有可按关键词直接提取的结构。你可以照原文自行整理，不会自动补造内容。");
    for (const [name, items] of Object.entries(outline)) {
      if (!items.length) continue;
      const group = el("section", "outline-group"); group.append(el("h3", "", name));
      for (const item of items) {
        const row = el("div", "outline-item"); row.append(el("span", "", item.text));
        const button = el("button", "", item.position); button.type = "button";
        button.addEventListener("click", () => {
          const area = $("note-source"), lines = area.value.split(/\r?\n/);
          const start = lines.slice(0, item.line).join("\n").length + (item.line ? 1 : 0);
          area.focus(); area.setSelectionRange(start, start + lines[item.line].length);
          area.classList.remove("source-focus"); void area.offsetWidth; area.classList.add("source-focus");
        }); row.append(button); group.append(row);
      } box.append(group);
    }
  }
  function loadZipLibrary() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!zipPromise) zipPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./vendor/jszip.min.js", location.href).href;
      script.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("PPTX 解包工具未加载"));
      script.onerror = () => reject(new Error("PPTX 解包工具下载失败"));
      document.head.append(script);
    }).catch(error => { zipPromise = null; throw error; });
    return zipPromise;
  }
  async function extractPptxText(file) {
    if (!/\.pptx$/i.test(file.name)) throw new Error("请使用 .pptx 文件；旧版 .ppt 请先另存为 .pptx");
    if (file.size > 50 * 1024 * 1024) throw new Error("文件超过 50 MB；请先压缩图片或拆分课件");
    const JSZip = await loadZipLibrary();
    const archive = await JSZip.loadAsync(file);
    const slidePaths = Object.keys(archive.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)[1]) - Number(b.match(/slide(\d+)\.xml/i)[1]));
    if (!slidePaths.length) throw new Error("文件中没有可读取的幻灯片");
    const pages = [];
    const ns = "http://schemas.openxmlformats.org/drawingml/2006/main";
    for (const path of slidePaths) {
      const xml = new DOMParser().parseFromString(await archive.file(path).async("string"), "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("课件中的幻灯片 XML 无法解析");
      const paragraphs = Array.from(xml.getElementsByTagNameNS(ns, "p"));
      const lines = paragraphs.map(p => Array.from(p.getElementsByTagNameNS(ns, "t")).map(t => t.textContent || "").join("").trim()).filter(Boolean);
      if (lines.length) pages.push(`第 ${path.match(/slide(\d+)\.xml/i)[1]} 页\n${lines.join("\n")}`);
    }
    if (!pages.length) throw new Error("课件没有可提取的文字；图片里的文字暂时无法识别");
    return { text: `课件：${file.name}\n\n${pages.join("\n\n")}`, pages: pages.length, slides: slidePaths.length };
  }
  function setupSummaries() {
    $("note-date").value = iso(new Date());
    $("import-pptx").addEventListener("change", async event => {
      const input = event.currentTarget, file = input.files?.[0];
      if (!file) return;
      input.disabled = true;
      toast("正在从 PPTX 提取文字与页码…");
      try {
        const extracted = await extractPptxText(file);
        const source = $("note-source");
        source.value = source.value.trim() ? `${source.value.trim()}\n\n${extracted.text}` : extracted.text;
        $("note-kind").value = "讲义文字";
        renderOutline(source.value, extractOutline(source.value));
        toast(`已提取 ${extracted.pages}/${extracted.slides} 页的文字；请核对后点击“保存笔记”`);
      } catch (error) { toast(`导入失败：${error?.message || "无法读取此课件"}`); }
      finally { input.value = ""; input.disabled = false; }
    });
    $("outline-note").addEventListener("click", () => { const text = $("note-source").value.trim(); if (!text) return toast("请先粘贴原文"); renderOutline(text, extractOutline(text)); });
    $("save-note").addEventListener("click", () => {
      const course = $("note-course").value.trim(), text = $("note-source").value.trim();
      if (!course || !text) return toast("请填写课程和原始内容");
      if (forbidden(course)) return toast("这门课程不纳入个人笔记");
      state.summaries.unshift({ id: uid(), course, date: $("note-date").value || iso(new Date()), kind: $("note-kind").value, text, outline: extractOutline(text) });
      save(); $("note-source").value = ""; addEmpty($("outline-preview"), "已保存。继续粘贴下一份原文即可。"); renderSummaries(); toast("总结已保存在当前浏览器");
    });
    $("export-summaries").addEventListener("click", () => {
      const md = state.summaries.map(x => `## ${x.date} · ${x.course}\n\n资料类型：${x.kind}\n\n### 原文\n\n${x.text}\n\n### 原文提取\n\n${Object.entries(x.outline || {}).map(([k, v]) => v.length ? `**${k}**\n${v.map(y => `- ${y.text}（${y.position}）`).join("\n")}` : "").filter(Boolean).join("\n\n")}\n`).join("\n---\n\n");
      download("HYY-study-课堂总结.md", `# 课堂总结\n\n${md || "暂无总结。"}\n`, "text/markdown;charset=utf-8");
    }); renderSummaries();
  }
  function renderSummaries() {
    const list = $("note-list"); list.replaceChildren(); $("note-count").textContent = `${state.summaries.length} 条`;
    if (!state.summaries.length) return addEmpty(list, "还没有保存总结。收到讲义或课堂转录后，可在上方整理。");
    for (const item of state.summaries) {
      const row = el("article", "list-item"), main = el("div"), actions = el("div", "item-actions");
      main.append(el("div", "list-meta", `${item.date} · ${item.kind}`), el("h3", "", item.course), el("p", "", item.text.length > 280 ? item.text.slice(0, 280) + "…" : item.text));
      const view = el("button", "small-button", "查看原文"); view.addEventListener("click", () => { switchView("summary"); $("note-course").value = item.course; $("note-date").value = item.date; $("note-kind").value = item.kind; $("note-source").value = item.text; renderOutline(item.text, item.outline || extractOutline(item.text)); $("note-source").scrollIntoView({ block: "center", behavior: "smooth" }); });
      const del = el("button", "small-button", "删除"); del.addEventListener("click", () => removeItem("summaries", item.id, renderSummaries)); actions.append(view, del); row.append(main, actions); list.append(row);
    }
  }
  function setupManualNotes() {
    $("manual-note-date").value = iso(new Date());
    $("save-manual-note").addEventListener("click", () => {
      const course = $("manual-note-course").value.trim(), text = $("manual-note-text").value.trim();
      if (!course || !text) return toast("请填写课程和笔记内容");
      if (forbidden(course)) return toast("这门课程不纳入个人笔记");
      state.notes.unshift({ id: uid(), course, date: $("manual-note-date").value || iso(new Date()), kind: $("manual-note-kind").value, text });
      save(); $("manual-note-text").value = ""; renderManualNotes(); toast("笔记已保存在当前浏览器");
    });
    $("export-manual-notes").addEventListener("click", () => {
      const md = state.notes.map(x => `## ${x.date} · ${x.course}\n\n类型：${x.kind}\n\n${x.text}\n`).join("\n---\n\n");
      download("HYY-study-课堂笔记.md", `# 课堂笔记\n\n${md || "暂无笔记。"}\n`, "text/markdown;charset=utf-8");
    }); renderManualNotes();
  }
  function renderManualNotes() {
    const list = $("manual-note-list"); list.replaceChildren(); $("manual-note-count").textContent = `${state.notes.length} 条`;
    if (!state.notes.length) return addEmpty(list, "还没有保存笔记。");
    for (const item of state.notes) {
      const row = el("article", "list-item"), main = el("div");
      main.append(el("div", "list-meta", `${item.date} · ${item.kind}`), el("h3", "", item.course), el("p", "", item.text));
      const del = el("button", "small-button", "删除"); del.addEventListener("click", () => removeItem("notes", item.id, renderManualNotes)); row.append(main, del); list.append(row);
    }
  }
  function setupGlossary() {
    $("add-term").addEventListener("click", () => {
      const en = $("term-en").value.trim(), zh = $("term-zh").value.trim(), course = $("term-course").value.trim();
      if (!en || !zh) return toast("请填写英文术语和中文解释"); if (forbidden(course)) return toast("这门课程不纳入术语库");
      state.terms.unshift({ id: uid(), en, zh, course }); save(); $("term-en").value = ""; $("term-zh").value = ""; $("term-course").value = ""; renderTerms(); toast("术语已保存");
    });
    $("term-search").addEventListener("input", renderTerms);
    $("export-glossary").addEventListener("click", () => download("HYY-study-术语.csv", "\ufeff英文术语,中文解释,课程或来源\r\n" + state.terms.map(x => [x.en, x.zh, x.course].map(csv).join(",")).join("\r\n"), "text/csv;charset=utf-8"));
    renderTerms();
  }
  const csv = (value) => `"${String(value || "").replaceAll('"', '""')}"`;
  function renderTerms() {
    const q = $("term-search").value.trim().toLocaleLowerCase(), list = $("term-list"); list.replaceChildren();
    const matches = state.terms.filter(x => `${x.en} ${x.zh} ${x.course}`.toLocaleLowerCase().includes(q));
    $("term-count").textContent = `${matches.length} / ${state.terms.length} 条`;
    if (!matches.length) return addEmpty(list, q ? "没有匹配的术语。" : "还没有保存术语。可从真实课堂或讲义中录入。");
    for (const item of matches) {
      const card = el("article", "term-card"); card.append(el("h3", "", item.en), el("p", "", item.zh), el("div", "list-meta", item.course || "来源未填写"));
      const del = el("button", "small-button", "删除"); del.addEventListener("click", () => removeItem("terms", item.id, renderTerms)); card.append(del); list.append(card);
    }
  }
  function setupPlan() {
    $("add-task").addEventListener("click", () => {
      const course = $("task-course").value.trim(), title = $("task-title").value.trim();
      if (!course || !title) return toast("请填写课程和事项"); if (forbidden(course)) return toast("这门课程不纳入学习清单");
      state.tasks.unshift({ id: uid(), course, title, date: $("task-date").value, source: $("task-source").value.trim(), done: false }); save();
      for (const id of ["task-course", "task-title", "task-date", "task-source"]) $(id).value = ""; renderTasks(); toast("事项已加入清单");
    });
    $("export-all").addEventListener("click", () => download(`HYY-study-备份-${iso(new Date())}.json`, JSON.stringify({ app: "课程study", version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2), "application/json;charset=utf-8"));
    $("import-all").addEventListener("change", async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()); const incoming = parsed.data;
        if (parsed.app !== "课程study" || !incoming || !Object.keys(blank()).every(k => Array.isArray(incoming[k]))) throw new Error("格式不匹配");
        if (!confirm("导入备份将替换当前浏览器中的笔记、术语、任务、转录和手动课程。继续吗？")) return;
        state = Object.fromEntries(Object.keys(blank()).map(k => [k, incoming[k].filter(x => x && typeof x === "object" && !forbidden(x.course || x.title))]));
        save(); renderWeek(); renderTranscripts(); renderSummaries(); renderManualNotes(); renderTerms(); renderTasks(); toast("备份已导入");
      } catch { toast("无法读取此备份，请选择 HYY study 或课程study导出的 JSON 文件"); }
      finally { e.target.value = ""; }
    });
    $("clear-data").addEventListener("click", () => { if (!confirm("清空当前浏览器里的所有 HYY study 个人记录？此操作无法在网页中撤销。")) return; state = blank(); save(); renderWeek(); renderTranscripts(); renderSummaries(); renderManualNotes(); renderTerms(); renderTasks(); toast("当前浏览器记录已清空"); });
    renderTasks();
  }
  function renderTasks() {
    const list = $("task-list"); list.replaceChildren(); $("task-count").textContent = `${state.tasks.filter(x => !x.done).length} 项待完成`;
    if (!state.tasks.length) return addEmpty(list, "还没有学习事项。收到真实课件或作业要求后，再加入清单。");
    const sorted = [...state.tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.date || "9999").localeCompare(b.date || "9999"));
    for (const item of sorted) {
      const row = el("article", `list-item${item.done ? " task-done" : ""}`), main = el("div", "task-main"), content = el("div");
      const check = el("input", "task-check"); check.type = "checkbox"; check.checked = Boolean(item.done); check.setAttribute("aria-label", `完成 ${item.title}`);
      check.addEventListener("change", () => { item.done = check.checked; save(); renderTasks(); });
      content.append(el("div", "list-meta", `${item.course}${item.date ? ` · ${item.date}` : " · 未设日期"}`), el("h3", "", item.title));
      if (item.source) content.append(el("p", "", `依据：${item.source}`)); main.append(check, content);
      const del = el("button", "small-button", "删除"); del.addEventListener("click", () => removeItem("tasks", item.id, renderTasks)); row.append(main, del); list.append(row);
    }
  }
  function releaseClassroom() {
    stopLive();
    modelPromise = null;
    try { activeMic?.getTracks().forEach(track => track.stop()); } catch {}
    try { activeConnection?.close?.(); } catch {}
    activeMic = null; activeConnection = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
  window.addEventListener("pagehide", releaseClassroom);
  window.addEventListener("beforeunload", releaseClassroom);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") releaseClassroom(); });

  load(); setupNavigation(); setupSchedule(); setupClassroom(); setupSummaries(); setupManualNotes(); setupGlossary(); setupPlan();
})();
