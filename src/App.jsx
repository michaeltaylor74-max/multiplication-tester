

import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Utility helpers ---
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(n, b));

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleWithoutImmediateRepeat(prev, pool) {
  if (!pool.length) return null;
  const filtered = pool.filter((x) => JSON.stringify(x) !== JSON.stringify(prev));
  const pickFrom = filtered.length ? filtered : pool; // fallback if unique not possible
  return pickFrom[Math.floor(Math.random() * pickFrom.length)];
}

function formatMs(ms) {
  if (ms == null) return "—"; // em dash OK in modern bundlers
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function toCSV(rows) {
  // RFC-4180 style: quote any field containing comma, quote, or newline; double internal quotes
  if (!rows?.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
    return s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))];
  return lines.join("\n");
}

// --- Local persistence ---
const STORAGE_KEY = "multitest_results_v1";
function saveResult(result) {
  const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  existing.push(result);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}
function listResults() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}
function clearResults() {
  localStorage.removeItem(STORAGE_KEY);
}

// --- Core question generator ---
function makeQuestionPool(tables, min = 1, max = 12) {
  const pool = [];
  for (const a of tables) {
    for (let b = min; b <= max; b++) {
      pool.push({ a, b, ans: a * b });
    }
  }
  return shuffle(pool);
}

function nextQuestion(prevQ, pool) {
  return sampleWithoutImmediateRepeat(prevQ, pool);
}

const keyFor = (q) => `${q.a}x${q.b}`;

// --- Components ---
function Stat({ label, value, sub }) {
  return (
    <div className="flex-1 rounded-2xl border p-4 shadow-sm">
      <div className="text-sm opacity-70">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs opacity-60 mt-1">{sub}</div>}
    </div>
  );
}

function TogglePill({ selected, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full border transition shadow-sm text-sm ${
        selected ? "bg-black text-white border-black" : "bg-white hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}

const MODES = {
  PRACTICE: "Practice (fixed questions)",
  TIMED60: "Timed (60s)",
  TIMED120: "Timed (120s)",
};

export default function App() {
  // UI copy helpers (positive tone)
  const POSITIVE_PREFIX = [
    "Nice try!",
    "Great thinking!",
    "You're close!",
    "Good effort!",
    "Keep going!",
  ];
  const pickPositive = () => POSITIVE_PREFIX[Math.floor(Math.random() * POSITIVE_PREFIX.length)];

  // Auth-lite (for MVP only – not secure)
  const [name, setName] = useState("");
  const [classCode, setClassCode] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  // Settings
  const [selectedTables, setSelectedTables] = useState([2, 3, 4, 5]);
  const [questionsTarget, setQuestionsTarget] = useState(20);
  const [mode, setMode] = useState(MODES.PRACTICE);

  // Quiz state
  const [pool, setPool] = useState([]);
  const [current, setCurrent] = useState(null);
  const [prev, setPrev] = useState(null);
  const [answer, setAnswer] = useState("");
  const [startedAt, setStartedAt] = useState(null);
  const [finishedAt, setFinishedAt] = useState(null);
  const [attempts, setAttempts] = useState(0); // total submissions
  const [completed, setCompleted] = useState(0); // questions completed (advance to next)
  const [correct, setCorrect] = useState(0);
  const [streak, setStreak] = useState(0);
  const [fastest, setFastest] = useState(null);
  const [slowest, setSlowest] = useState(null);
  const [attemptsOnCurrent, setAttemptsOnCurrent] = useState(0);
  const [feedback, setFeedback] = useState(null); // {type:'correct'|'incorrect'|'reveal', text:string}
  // track unique facts the student has missed at least once this session
  const [missedMap, setMissedMap] = useState({}); // key -> { a,b,ans,count,last }

  // revisit logic
  const [revisitQueue, setRevisitQueue] = useState([]); // [{a,b,ans, scheduledAt:number}]
  const scheduledRef = useRef(new Set()); // track which keys are already scheduled once
  const [stepCount, setStepCount] = useState(0); // increments when a question is completed

  const lastSubmitTime = useRef(null);
  const inputRef = useRef(null);
  const timerId = useRef(null);
  const [timeRemaining, setTimeRemaining] = useState(0);

  const isTimed = mode === MODES.TIMED60 || mode === MODES.TIMED120;
  const totalTimeMs = mode === MODES.TIMED60 ? 60000 : mode === MODES.TIMED120 ? 120000 : 0;

  const readyToStart = signedIn && selectedTables.length > 0;

  function signIn() {
    if (!name.trim()) return alert("Please enter a name");
    if (!classCode.trim()) return alert("Please enter a class code");
    setSignedIn(true);
  }

  function toggleTable(t) {
    setSelectedTables((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t].sort((a, b) => a - b)));
  }

  function start() {
    const p = makeQuestionPool(selectedTables);
    setPool(p);
    const q = nextQuestion(null, p);
    setCurrent(q);
    setPrev(null);
    setAnswer("");
    setStartedAt(Date.now());
    setFinishedAt(null);
    setAttempts(0);
    setCompleted(0);
    setCorrect(0);
    setStreak(0);
    setFastest(null);
    setSlowest(null);
    setAttemptsOnCurrent(0);
    setFeedback(null);
    setRevisitQueue([]);
    scheduledRef.current = new Set();
    setStepCount(0);
    lastSubmitTime.current = Date.now();
    if (isTimed) {
      setTimeRemaining(totalTimeMs);
      if (timerId.current) clearInterval(timerId.current);
      timerId.current = setInterval(() => {
        setTimeRemaining((t) => {
          const nt = t - 100;
          if (nt <= 0) {
            clearInterval(timerId.current);
            finish();
            return 0;
          }
          return nt;
        });
      }, 100);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function finish() {
    if (finishedAt) return; // avoid double finish
    setFinishedAt(Date.now());
    if (timerId.current) clearInterval(timerId.current);
  }

  function pickNext(prevQ) {
    // Allow a short cool-down before serving a revisit: at least 2 other questions
    const eligible = revisitQueue.filter((it) => stepCount - it.scheduledAt >= 2);
    let next = null;
    if (eligible.length > 0 && (Math.random() < 0.6 || pool.length === 0)) {
      const idx = Math.floor(Math.random() * eligible.length);
      const item = eligible[idx];
      next = { ...item, fromRevisit: true };
      // remove this specific scheduled item using functional state & key match
      setRevisitQueue((q) => q.filter((x) => !(keyFor(x) === keyFor(item) && x.scheduledAt === item.scheduledAt)));
      // we only ask later once
      scheduledRef.current.delete(keyFor(item));
    } else {
      next = nextQuestion(prevQ, pool);
    }
    return next;
  }

  function scheduleRevisitIfNeeded(q) {
    const k = keyFor(q);
    if (!q.fromRevisit && !scheduledRef.current.has(k)) {
      scheduledRef.current.add(k);
      setRevisitQueue((lst) => [...lst, { ...q, scheduledAt: stepCount }]);
    }
  }

  function advance(afterQuestion) {
    // Called when a question is completed (correct OR reveal after 3 tries)
    setStepCount((s) => s + 1);
    setCompleted((c) => c + 1);

    const nextCompleted = completed + 1;
    if (!isTimed && nextCompleted >= questionsTarget) {
      finish();
      return;
    }

    const next = pickNext(afterQuestion);
    setPrev(afterQuestion);
    setCurrent(next);
    setAnswer("");
    setAttemptsOnCurrent(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function submit() {
    if (!current) return;
    if (!startedAt) return;
    const ansNum = Number(answer);
    const thisSubmit = Date.now();
    const delta = thisSubmit - (lastSubmitTime.current ?? thisSubmit);
    lastSubmitTime.current = thisSubmit;

    const isCorrect = ansNum === current.ans;

    // global stats
    setAttempts((a) => a + 1);
    setCorrect((c) => c + (isCorrect ? 1 : 0));
    setStreak((s) => (isCorrect ? s + 1 : 0));
    setFastest((f) => (f == null ? delta : Math.min(f, delta)));
    setSlowest((s) => (s == null ? delta : Math.max(s, delta)));

    if (isCorrect) {
      setFeedback({ type: "correct", text: "✅ Correct! Great work." });
      advance(current);
      return;
    }

    // incorrect path
    const newCount = attemptsOnCurrent + 1;
    setAttemptsOnCurrent(newCount);

    // record the miss (unique fact list w/ counts)
    setMissedMap((m) => {
      const k = keyFor(current);
      const entry = m[k] || { a: current.a, b: current.b, ans: current.ans, count: 0, last: null };
      return { ...m, [k]: { ...entry, count: entry.count + 1, last: ansNum } };
    });

    // schedule a later revisit once, as soon as the first mistake happens
    if (newCount === 1) scheduleRevisitIfNeeded(current);

    if (newCount < 3) {
      setFeedback({ type: "incorrect", text: `${pickPositive()} ${current.a} × ${current.b} isn’t ${isNaN(ansNum) ? 'that' : ansNum}. Have another go!` });
      setAnswer("");
      inputRef.current?.focus();
      return; // keep same question
    }

    // Reached 3 tries → reveal and move on
    setFeedback({ type: "reveal", text: `👍 Thanks for sticking with it! The answer is ${current.a} × ${current.b} = ${current.ans}. You’ll see it again later.` });
    advance(current);
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Enter") submit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Derived stats
  const durationMs = finishedAt && startedAt ? finishedAt - startedAt : startedAt ? Date.now() - startedAt : 0;
  const accuracy = attempts ? Math.round((100 * correct) / attempts) : 0;
  const qPerMin = durationMs ? ((attempts / durationMs) * 60000).toFixed(1) : "0.0";

  // Save result when finishedAt is set
  useEffect(() => {
    if (finishedAt && startedAt) {
      const result = {
        timestamp: nowISO(),
        name,
        classCode,
        mode,
        selectedTables: selectedTables.join(" "),
        questionsTarget,
        attempts,
        completed,
        correct,
        accuracy,
        durationMs,
        qPerMin,
        fastestMs: fastest ?? "",
        slowestMs: slowest ?? "",
      };
      saveResult(result);
    }
  }, [finishedAt]);

  const results = listResults();

  const [showTeacher, setShowTeacher] = useState(false);
  function tryOpenTeacher() {
    if (classCode.trim().toUpperCase() === "TEACHER123") setShowTeacher(true);
    else alert("Teacher panel locked. Use demo code TEACHER123.");
  }

  const teacherCSV = useMemo(() => toCSV(results), [results]);

  // --- Dev Tests (lightweight) ---
  function runToCSVTests() {
    const cases = [
      { name: "Empty rows", rows: [], expect: "" },
      { name: "Simple no quotes", rows: [{ a: 1, b: 2 }], expect: "a,b\n1,2" },
      { name: "Comma in field", rows: [{ a: "1,2", b: "x" }], expect: 'a,b\n"1,2",x' },
      { name: "Quote in field", rows: [{ a: 'He said "hi"', b: 3 }], expect: 'a,b\n"He said ""hi""",3' },
      { name: "Newline in field", rows: [{ a: "line1\nline2", b: "z" }], expect: 'a,b\n"line1\nline2",z' },
      { name: "Nulls/undefined", rows: [{ a: null, b: undefined }], expect: "a,b\n," },
      { name: "Comma+quote+newline", rows: [{ a: 'x,"y"\nZ', b: 'w' }], expect: 'a,b\n"x,""y""\nZ",w' },
      { name: "Unicode emoji & math", rows: [{ a: "👍", b: "7 × 8" }], expect: 'a,b\n👍,"7 × 8"' },
    ];
    return cases.map((c) => ({ name: c.name, pass: toCSV(c.rows) === c.expect, got: toCSV(c.rows), expect: c.expect }));
  }

  const csvTestResults = runToCSVTests();

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-black">Multiplication Tester · MVP</h1>
          <div className="flex items-center gap-2">
            {!signedIn ? (
              <></>
            ) : (
              <span className="text-sm opacity-70">Signed in as <b>{name}</b> · Class <b>{classCode}</b></span>
            )}
          </div>
        </header>

        {/* Sign in card */}
        {!signedIn && (
          <div className="mt-6 grid md:grid-cols-3 gap-3 rounded-2xl border bg-white p-4 shadow-sm">
            <div className="md:col-span-3 text-lg font-semibold">Quick sign-in</div>
            <input
              className="rounded-xl border p-3"
              placeholder="Student name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="rounded-xl border p-3"
              placeholder="Class code (e.g. 4A or TEACHER123)"
              value={classCode}
              onChange={(e) => setClassCode(e.target.value)}
            />
            <button onClick={signIn} className="rounded-xl border p-3 font-semibold hover:bg-gray-50">
              Enter
            </button>
            <div className="md:col-span-3 text-sm opacity-70">
              This MVP uses local save only. No passwords, no server yet.
            </div>
          </div>
        )}

        {/* Settings */}
        {signedIn && !startedAt && (
          <div className="mt-6 grid gap-4">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="text-lg font-semibold">Choose tables</div>
                <div className="flex gap-2">
                  <button
                    className="text-sm underline"
                    onClick={() => setSelectedTables([1,2,3,4,5,6,7,8,9,10,11,12])}
                  >
                    Select all
                  </button>
                  <button className="text-sm underline" onClick={() => setSelectedTables([])}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((t) => (
                  <TogglePill key={t} selected={selectedTables.includes(t)} onClick={() => toggleTable(t)}>
                    ×{t}
                  </TogglePill>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border bg-white p-4 shadow-sm grid md:grid-cols-3 gap-3 items-center">
              <div className="md:col-span-2">
                <div className="text-lg font-semibold mb-2">Mode</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(MODES).map(([key, label]) => (
                    <TogglePill key={key} selected={mode === label} onClick={() => setMode(label)}>
                      {label}
                    </TogglePill>
                  ))}
                  <TogglePill selected={!isTimed && mode === MODES.PRACTICE} onClick={() => setMode(MODES.PRACTICE)}>
                    {MODES.PRACTICE}
                  </TogglePill>
                </div>
              </div>
              {!isTimed && (
                <div className="md:justify-self-end">
                  <label className="text-sm opacity-70">Questions</label>
                  <input
                    type="number"
                    className="block w-28 rounded-xl border p-2"
                    min={5}
                    max={200}
                    value={questionsTarget}
                    onChange={(e) => setQuestionsTarget(clamp(parseInt(e.target.value || "0", 10), 5, 200))}
                  />
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                disabled={!readyToStart}
                onClick={start}
                className={`rounded-2xl px-5 py-3 font-semibold border shadow-sm ${
                  readyToStart ? "bg-black text-white border-black" : "opacity-50 cursor-not-allowed"
                }`}
              >
                Start
              </button>

              <button
                onClick={tryOpenTeacher}
                className="rounded-2xl px-5 py-3 font-semibold border shadow-sm bg-white hover:bg-gray-50"
              >
                Teacher panel
              </button>
            </div>
          </div>
        )}

        {/* Quiz UI */}
        {startedAt && !finishedAt && current && (
          <div className="mt-6 grid gap-4">
            <div className="grid md:grid-cols-4 gap-3">
              <Stat label="Attempts" value={attempts} />
              <Stat label="Correct" value={correct} sub={`${accuracy}%`} />
              <Stat label="Rate" value={`${qPerMin}/min`} sub={`Fast ${formatMs(fastest)} · Slow ${formatMs(slowest)}`} />
              {isTimed ? (
                <Stat label="Time left" value={formatMs(timeRemaining)} />
              ) : (
                <Stat label="Remaining" value={Math.max(questionsTarget - completed, 0)} />
              )}
            </div>

            <div className="rounded-3xl border bg-white p-6 shadow-sm text-center">
              <div className="text-sm opacity-60 mb-2">Type your answer and press Enter</div>
              <div className="text-6xl md:text-7xl font-black tracking-tight select-none">
                {current.a} × {current.b} = ?
              </div>
              <div className="mt-6 flex items-center justify-center gap-3">
                <input
                  ref={inputRef}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="w-44 text-center text-3xl rounded-2xl border p-3"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value.replace(/[^0-9]/g, ""))}
                />
                <button onClick={submit} className="rounded-2xl px-5 py-3 font-semibold border shadow-sm bg-black text-white">
                  Submit
                </button>
                <button onClick={finish} className="rounded-2xl px-5 py-3 font-semibold border shadow-sm bg-white hover:bg-gray-50">
                  Finish
                </button>
              </div>

              {feedback && (
                <div
                  className={`mt-4 inline-block rounded-xl px-4 py-2 text-sm font-semibold ${
                    feedback.type === "correct"
                      ? "bg-green-50 text-green-700 border border-green-200"
                      : feedback.type === "reveal"
                      ? "bg-amber-50 text-amber-700 border border-amber-200"
                      : "bg-rose-50 text-rose-700 border border-rose-200"
                  }`}
                >
                  {feedback.text}
                </div>
              )}

              <div className="mt-2 text-xs opacity-60">Tries on this question: {attemptsOnCurrent}/3</div>

              {prev && (
                <div className="mt-4 text-sm opacity-70">
                  Previous: {prev.a} × {prev.b} = {prev.ans}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Results */}
        {finishedAt && (
          <div className="mt-6 grid gap-4">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="text-lg font-semibold mb-2">Session summary</div>
              <div className="grid md:grid-cols-4 gap-3">
                <Stat label="Name" value={name} sub={`Class ${classCode}`} />
                <Stat label="Accuracy" value={`${accuracy}%`} sub={`${correct}/${attempts}`} />
                <Stat label="Duration" value={formatMs(durationMs)} sub={`${qPerMin}/min`} />
                <Stat label="Completed" value={completed} />
              </div>

              {Object.keys(missedMap).length > 0 ? (
                <div className="mt-4 rounded-xl border bg-amber-50 p-3 text-amber-900">
                  <div className="font-semibold mb-2">Great effort! Focus next on:</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.values(missedMap).map((m) => (
                      <span key={keyFor(m)} className="px-3 py-1 rounded-full bg-white/70 border text-sm">
                        {m.a} × {m.b} <span className="opacity-60">(missed {m.count}×)</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border bg-green-50 p-3 text-green-800">
                  <div className="font-semibold">Awesome — no tricky facts today! 🎉</div>
                </div>
              )}

              <div className="mt-4 flex gap-3">
                <button onClick={() => { setStartedAt(null); setFinishedAt(null); }} className="rounded-2xl px-5 py-3 font-semibold border shadow-sm bg-white hover:bg-gray-50">Back to settings</button>
                <button onClick={start} className="rounded-2xl px-5 py-3 font-semibold border shadow-sm bg-black text-white">Try again</button>
              </div>
            </div>
          </div>
        )}

        {/* Teacher panel (local only) */}
        {showTeacher && (
          <div className="mt-8 rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Teacher panel (local demo)</div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const blob = new Blob([teacherCSV], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `multiplication_results_${Date.now()}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="rounded-xl border px-4 py-2 text-sm font-semibold bg-black text-white"
                >
                  Export CSV
                </button>
                <button onClick={() => { if (confirm('Clear all local results?')) { clearResults(); location.reload(); } }} className="rounded-xl border px-4 py-2 text-sm font-semibold bg-white hover:bg-gray-50">Clear</button>
              </div>
            </div>

            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm border">
                <thead>
                  <tr className="bg-gray-100 text-left">
                    {[
                      "timestamp","name","classCode","mode","selectedTables","questionsTarget","attempts","completed","correct","accuracy","durationMs","qPerMin","fastestMs","slowestMs"
                    ].map((h) => (
                      <th key={h} className="p-2 border-b">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="odd:bg-white even:bg-gray-50">
                      {Object.values(r).map((v, j) => (
                        <td key={j} className="p-2 border-b">{String(v)}</td>
                      ))}
                    </tr>
                  ))}
                  {!results.length && (
                    <tr>
                      <td className="p-3" colSpan={13}>No results yet. Run a session to see data here.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Dev tests output */}
            <div className="mt-6 rounded-xl border bg-gray-50 p-3">
              <div className="font-semibold mb-2">Developer tests (toCSV)</div>
              <ul className="text-sm list-disc pl-5">
                {csvTestResults.map((t, idx) => (
                  <li key={idx} className={t.pass ? "text-green-700" : "text-rose-700"}>
                    {t.pass ? "PASS" : "FAIL"} – {t.name}
                    {!t.pass && (
                      <div className="mt-1 text-xs opacity-80">
                        got: <code className="bg-white px-1">{JSON.stringify(t.got)}</code>
                        <br />
                        expected: <code className="bg-white px-1">{JSON.stringify(t.expect)}</code>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="text-xs opacity-60 mt-2">Data is stored only in this browser (localStorage) in this MVP.</div>
          </div>
        )}

        <footer className="mt-10 text-center text-xs opacity-60">
          Randomized questions · Keyboard-first · 1×1 to 12×12 · MVP for Year 4 fluency checks
        </footer>
      </div>
    </div>
  );
}
