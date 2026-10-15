import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL =   import.meta.env.VITE_SERVER_URL || "http://localhost:5000";
const buttonBase = "rounded-lg px-3 py-2 text-sm font-semibold transition";
const buttonOn = "bg-blue-600 text-white";
const buttonOff = "border border-slate-200 bg-white hover:bg-slate-50";

function drawItem(ctx, item, width, height, preview = false) {
  if (!item) return;
  const x0 = (item.x0 ?? 0) * width;
  const y0 = (item.y0 ?? 0) * height;
  const x1 = (item.x1 ?? item.x0 ?? 0) * width;
  const y1 = (item.y1 ?? item.y0 ?? 0) * height;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = item.tool === "eraser" ? "#ffffff" : (item.color || "#2563eb");
  ctx.fillStyle = item.color || "#2563eb";
  ctx.lineWidth = Math.max(1, Number(item.width) || 3);

  if (item.kind === "text") {
    ctx.fillStyle = item.color || "#2563eb";
    ctx.font = `${Math.max(12, Number(item.fontSize) || 22)}px Arial, sans-serif`;
    ctx.textBaseline = "top";
    const lines = String(item.text || "").split("\n").slice(0, 8);
    lines.forEach((line, index) => ctx.fillText(line.slice(0, 120), x0, y0 + index * ((Number(item.fontSize) || 22) * 1.25)));
  } else if (item.kind === "shape") {
    ctx.beginPath();
    if (item.shape === "rect") {
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.stroke();
    } else if (item.shape === "circle") {
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      ctx.ellipse(x0 + rx, y0 + ry, Math.max(0.5, Math.abs(rx)), Math.max(0.5, Math.abs(ry)), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (item.shape === "arrow") {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(10, (Number(item.width) || 3) * 4);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

export default function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const segmentsRef = useRef([]);
  const drawingRef = useRef(false);
  const startPointRef = useRef(null);
  const activeStrokeRef = useRef(null);
  const cursorThrottleRef = useRef(0);

  const [username, setUsername] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [role, setRole] = useState("student");
  const [isTeacher, setIsTeacher] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [color, setColor] = useState("#2563eb");
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState("pen");
  const [shape, setShape] = useState("rect");
  const [textInput, setTextInput] = useState("Hello class!");
  const [fontSize, setFontSize] = useState(22);
  const [revision, setRevision] = useState(0);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [cursors, setCursors] = useState({});
  const [boardLocked, setBoardLocked] = useState(false);

  const renderBoard = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round(rect.width * dpr);
    const targetHeight = Math.round(rect.height * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    segmentsRef.current.forEach((item) => drawItem(ctx, item, rect.width, rect.height));
  }, []);

  useEffect(() => {
    renderBoard();
  }, [renderBoard, revision]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;
    socket.on("connect", () => setStatus("Connected to server"));
    socket.on("connect_error", () => setStatus("Server connection failed"));
    socket.on("disconnect", () => setStatus("Disconnected"));

    socket.on("board-state", (items) => {
      segmentsRef.current = Array.isArray(items) ? items : [];
      setRevision((n) => n + 1);
    });
    socket.on("draw", (item) => {
      segmentsRef.current.push(item);
      setRevision((n) => n + 1);
    });
    socket.on("board-cleared", () => {
      segmentsRef.current = [];
      setRevision((n) => n + 1);
    });
    socket.on("participants-update", setParticipants);
    socket.on("chat-history", setMessages);
    socket.on("chat-message", (message) => setMessages((old) => [...old, message].slice(-100)));
    socket.on("cursor-update", (cursor) => {
      setCursors((old) => ({ ...old, [cursor.id]: cursor }));
    });
    socket.on("cursor-left", ({ id }) => {
      setCursors((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
    });
    socket.on("room-role", ({ role: roomRole, boardLocked: locked }) => {
      setRole(roomRole);
      setIsTeacher(roomRole === "teacher");
      setBoardLocked(Boolean(locked));
    });
    socket.on("board-lock-state", ({ locked }) => setBoardLocked(Boolean(locked)));
    socket.on("board-error", ({ message }) => {
      if (message) setStatus(message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => renderBoard());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [renderBoard, joined]);

  const getPoint = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  function joinRoom(code = roomInput, requestedRole = "student") {
    const normalized = code.trim().toUpperCase();
    if (!username.trim()) return setStatus("Please enter your name first");
    if (!normalized) return setStatus("Please enter a room code");
    if (!socketRef.current?.connected) return setStatus("Wait for server connection");
    socketRef.current.emit("join-room", {
      roomId: normalized,
      username: username.trim(),
      requestedRole,
    }, (response) => {
      if (!response?.success) return setStatus(response?.error || "Could not join room");
      setRoomId(response.roomId);
      setRoomInput(response.roomId);
      setJoined(true);
      setRole(response.role);
      setIsTeacher(response.role === "teacher");
      setBoardLocked(Boolean(response.boardLocked));
      setMessages([]);
      setCursors({});
      setStatus(`Joined ${response.roomId} as ${response.role}`);
    });
  }

  function createRoom() {
    const code = `CLASS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    setRoomInput(code);
    joinRoom(code, "teacher");
  }

  function sendCursor(event) {
    if (!joined || !socketRef.current) return;
    const now = Date.now();
    if (now - cursorThrottleRef.current < 35) return;
    cursorThrottleRef.current = now;
    const point = getPoint(event);
    socketRef.current.emit("cursor-move", { roomId, x: point.x, y: point.y });
  }

  function startDrawing(event) {
    if (!joined || (boardLocked && !isTeacher) || event.button !== 0) return;
    if (tool === "text") {
      event.preventDefault();
      const point = getPoint(event);
      const value = textInput.trim();
      if (!value) return setStatus("Text tool: pehle text likho");
      const item = {
        kind: "text", text: value.slice(0, 240), x0: point.x, y0: point.y,
        color, width: Number(size), fontSize: Number(fontSize),
        strokeId: crypto.randomUUID(), createdBy: username,
      };
      addBoardItem(item);
      return;
    }
    event.preventDefault();
    const point = getPoint(event);
    drawingRef.current = true;
    startPointRef.current = point;
    activeStrokeRef.current = crypto.randomUUID();
    canvasRef.current?.setPointerCapture(event.pointerId);

    if (tool === "pen" || tool === "eraser") {
      const item = {
        kind: "stroke", x0: point.x, y0: point.y, x1: point.x, y1: point.y,
        color, width: Number(size), tool, strokeId: activeStrokeRef.current, createdBy: username,
      };
      addLocalItem(item);
      socketRef.current?.emit("draw", { roomId, segment: item });
    }
  }

  function addLocalItem(item) {
    segmentsRef.current.push(item);
    setRevision((n) => n + 1);
  }

  function addBoardItem(item) {
    addLocalItem(item);
    socketRef.current?.emit("draw", { roomId, segment: item });
  }

  function draw(event) {
    sendCursor(event);
    if (!drawingRef.current || !startPointRef.current || !joined || (boardLocked && !isTeacher)) return;
    event.preventDefault();
    const next = getPoint(event);
    const start = startPointRef.current;
    const strokeId = activeStrokeRef.current;
    if (tool === "pen" || tool === "eraser") {
      const item = {
        kind: "stroke", x0: start.x, y0: start.y, x1: next.x, y1: next.y,
        color, width: Number(size), tool, strokeId, createdBy: username,
      };
      startPointRef.current = next;
      addBoardItem(item);
    } else if (tool === "line" || tool === "shape") {
      // Render a temporary preview without persisting every pointer movement.
      setPreview({ kind: "shape", shape: tool === "line" ? "line" : shape, x0: start.x, y0: start.y, x1: next.x, y1: next.y, color, width: Number(size), strokeId });
      startPointRef.current = next;
    }
  }

  const [preview, setPreview] = useState(null);

  function stopDrawing() {
    if (drawingRef.current && initialShapePointRef.current && activeStrokeRef.current && (tool === "line" || tool === "shape")) {
      const start = initialShapePointRef.current;
      const end = latestPointRef.current || start;
      const item = {
        kind: "shape", shape: tool === "line" ? "line" : shape,
        x0: start.x, y0: start.y, x1: end.x, y1: end.y,
        color, width: Number(size), strokeId: activeStrokeRef.current, createdBy: username,
      };
      addBoardItem(item);
    }
    drawingRef.current = false;
    startPointRef.current = null;
    activeStrokeRef.current = null;
    initialShapePointRef.current = null;
    latestPointRef.current = null;
    setPreview(null);
  }

  const initialShapePointRef = useRef(null);
  const latestPointRef = useRef(null);

  // Keep the initial and latest pointer positions for drag-to-create shapes.
  function beginCanvas(event) {
    if ((tool === "line" || tool === "shape") && joined && !boardLocked && event.button === 0) {
      const point = getPoint(event);
      initialShapePointRef.current = point;
      latestPointRef.current = point;
    }
    startDrawing(event);
  }

  function moveCanvas(event) {
    if (drawingRef.current && (tool === "line" || tool === "shape")) {
      latestPointRef.current = getPoint(event);
    }
    draw(event);
  }

  function clearBoard() {
    if (!joined) return;
    socketRef.current?.emit("clear-board", { roomId });
  }

  function undoBoard() {
    if (joined) socketRef.current?.emit("undo-board", { roomId });
  }

  function redoBoard() {
    if (joined) socketRef.current?.emit("redo-board", { roomId });
  }

  function toggleBoardLock() {
    if (joined && isTeacher) socketRef.current?.emit("set-board-lock", { roomId, locked: !boardLocked });
  }

  function downloadBoard() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `CollabBoard-${roomId || "board"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  function sendMessage(event) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || !joined) return;
    socketRef.current?.emit("chat-message", { roomId, message });
    setChatInput("");
  }

  function leaveRoom() {
    socketRef.current?.emit("leave-room", () => {
      setJoined(false);
      setRoomId("");
      setParticipants([]);
      setMessages([]);
      setCursors({});
      segmentsRef.current = [];
      setRevision((n) => n + 1);
      setStatus("You left the classroom");
    });
  }

  const canvasRect = () => canvasRef.current?.getBoundingClientRect();

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-slate-900 px-5 py-4 text-white shadow">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">CollabBoard</h1>
            <p className="text-sm text-slate-300">Real-Time Collaborative Digital Classroom</p>
          </div>
          <span className="rounded-full bg-slate-700 px-3 py-1 text-sm">{status}</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
        {!joined && (
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-lg font-bold">Join your classroom</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <input className="rounded-lg border p-3" placeholder="Your name" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} />
              <input className="rounded-lg border p-3 uppercase" placeholder="Enter room code (student)" value={roomInput} onChange={(e) => setRoomInput(e.target.value)} />
              <div className="flex gap-2">
                <button onClick={() => joinRoom(roomInput, "student")} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700">Join as Student</button>
                <button onClick={createRoom} className="flex-1 rounded-lg bg-slate-800 px-4 py-3 font-semibold text-white hover:bg-slate-700">Create as Teacher</button>
              </div>
            </div>
            <p className="mt-3 text-sm text-slate-500">Room creator becomes teacher. Joining an existing room as a student does not grant teacher controls.</p>
          </section>
        )}

        {joined && (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm">
              <div>
                <p className="text-sm text-slate-500">Classroom room code</p>
                <p className="text-xl font-bold">{roomId}</p>
                <p className="text-sm text-slate-500">Your role: <strong className="capitalize">{role}</strong>{boardLocked ? " · Board locked" : ""}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => navigator.clipboard?.writeText(roomId)} className={`${buttonBase} ${buttonOff}`}>Copy room code</button>
                <button onClick={undoBoard} className={`${buttonBase} bg-amber-500 text-white hover:bg-amber-600`}>↶ Undo</button>
                <button onClick={redoBoard} className={`${buttonBase} bg-indigo-600 text-white hover:bg-indigo-700`}>↷ Redo</button>
                <button onClick={clearBoard} disabled={!isTeacher} title={!isTeacher ? "Teacher only" : ""} className={`${buttonBase} ${isTeacher ? "bg-red-600 text-white hover:bg-red-700" : "cursor-not-allowed bg-slate-200 text-slate-500"}`}>Clear Board</button>
                <button onClick={downloadBoard} className={`${buttonBase} bg-emerald-600 text-white hover:bg-emerald-700`}>Download PNG</button>
                {isTeacher && <button onClick={toggleBoardLock} className={`${buttonBase} ${boardLocked ? "bg-orange-600 text-white" : buttonOff}`}>{boardLocked ? "Unlock Board" : "Lock Board"}</button>}
                <button onClick={leaveRoom} className={`${buttonBase} ${buttonOff}`}>Leave Room</button>
              </div>
            </section>

            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="min-w-0 overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">Color
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-11 cursor-pointer rounded border p-1" />
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium">Size
                    <input type="range" min="1" max="20" value={size} onChange={(e) => setSize(Number(e.target.value))} />
                    <span>{size}px</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {[
                      ["pen", "Pen"], ["eraser", "Eraser"], ["line", "Line"],
                      ["shape", "Shape"], ["text", "Text"],
                    ].map(([value, label]) => (
                      <button key={value} onClick={() => setTool(value)} className={`${buttonBase} ${tool === value ? buttonOn : buttonOff}`}>{label}</button>
                    ))}
                  </div>
                  {tool === "shape" && (
                    <select value={shape} onChange={(e) => setShape(e.target.value)} className="rounded-lg border p-2 text-sm">
                      <option value="rect">Rectangle</option><option value="circle">Ellipse</option><option value="arrow">Arrow</option>
                    </select>
                  )}
                  {tool === "text" && (
                    <>
                      <input value={textInput} onChange={(e) => setTextInput(e.target.value)} maxLength={240} className="min-w-40 flex-1 rounded-lg border p-2 text-sm" placeholder="Text to place on board" />
                      <label className="flex items-center gap-2 text-sm">Font
                        <input type="number" min="12" max="64" value={fontSize} onChange={(e) => setFontSize(Math.min(64, Math.max(12, Number(e.target.value) || 22)))} className="w-16 rounded border p-2" />
                      </label>
                    </>
                  )}
                </div>

                {boardLocked && !isTeacher && <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">Teacher ne board lock kiya hai. Abhi aap draw nahi kar sakte.</p>}
                <div className="relative">
                  <canvas
                    ref={canvasRef}
                    onPointerDown={beginCanvas}
                    onPointerMove={moveCanvas}
                    onPointerUp={stopDrawing}
                    onPointerCancel={stopDrawing}
                    onLostPointerCapture={stopDrawing}
                    className={`h-[60vh] min-h-80 w-full rounded-lg border border-slate-200 bg-white touch-none ${joined && (!boardLocked || isTeacher) ? "cursor-crosshair" : "cursor-not-allowed"}`}
                  />
                  {preview && (
                    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 600" preserveAspectRatio="none">
                      {preview.shape === "rect" && <rect x={preview.x0*1000} y={preview.y0*600} width={(preview.x1-preview.x0)*1000} height={(preview.y1-preview.y0)*600} fill="none" stroke={preview.color} strokeWidth={preview.width} />}
                      {preview.shape === "circle" && <ellipse cx={(preview.x0+preview.x1)*500} cy={(preview.y0+preview.y1)*300} rx={Math.abs(preview.x1-preview.x0)*500} ry={Math.abs(preview.y1-preview.y0)*300} fill="none" stroke={preview.color} strokeWidth={preview.width} />}
                      {(preview.shape === "line" || preview.shape === "arrow") && <line x1={preview.x0*1000} y1={preview.y0*600} x2={preview.x1*1000} y2={preview.y1*600} stroke={preview.color} strokeWidth={preview.width} />}
                    </svg>
                  )}
                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
                    {Object.values(cursors).filter((cursor) => cursor.id !== socketRef.current?.id).map((cursor) => (
                      <div key={cursor.id} className="absolute" style={{ left: `${cursor.x*100}%`, top: `${cursor.y*100}%` }}>
                        <div className="h-3 w-3 -translate-x-1 -translate-y-1 rotate-45 bg-fuchsia-600" />
                        <span className="ml-2 rounded bg-fuchsia-600 px-2 py-0.5 text-xs text-white shadow">{cursor.username}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="mt-3 text-sm text-slate-500">Pen/Eraser se draw karo; Shape/Line ke liye drag karo; Text select karke board par click karo. Live cursors room ke users ko dikhte hain.</p>
              </section>

              <aside className="space-y-5">
                <section className="rounded-2xl bg-white p-4 shadow-sm">
                  <h2 className="mb-3 text-lg font-bold">Participants ({participants.length})</h2>
                  {participants.length === 0 ? <p className="text-sm text-slate-500">Waiting for participants...</p> : (
                    <ul className="space-y-2">{participants.map((person) => (
                      <li key={person.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">{person.username?.charAt(0)?.toUpperCase() || "?"}</span>
                          <span className="break-all text-sm font-medium">{person.username}{person.id === socketRef.current?.id ? " (You)" : ""}</span>
                        </span>
                        <span className={`rounded px-2 py-1 text-xs font-semibold ${person.role === "teacher" ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-600"}`}>{person.role || "student"}</span>
                      </li>
                    ))}</ul>
                  )}
                </section>
                <section className="rounded-2xl bg-white p-4 shadow-sm">
                  <h2 className="mb-3 text-lg font-bold">Classroom Chat</h2>
                  <div className="mb-3 flex h-64 flex-col gap-3 overflow-y-auto rounded-lg bg-slate-50 p-3">
                    {messages.length === 0 && <p className="m-auto text-center text-sm text-slate-500">No messages yet. Say hello!</p>}
                    {messages.map((item, index) => (
                      <div key={item.id || `${item.time}-${index}`} className="break-words rounded-lg bg-white p-2 shadow-sm">
                        <div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-bold text-blue-700">{item.username}</span><span className="text-xs text-slate-400">{item.time ? new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
                        <p className="text-sm">{item.message}</p>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={sendMessage} className="flex gap-2">
                    <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} maxLength={500} placeholder="Type a message..." className="min-w-0 flex-1 rounded-lg border p-2 text-sm" />
                    <button className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">Send</button>
                  </form>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
