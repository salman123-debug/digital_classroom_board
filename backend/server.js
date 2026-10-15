require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] },
});

const roomBoardSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  segments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  teacherSocketId: { type: String, default: null },
  teacherName: { type: String, default: null },
  boardLocked: { type: Boolean, default: false },
}, { timestamps: true });

const RoomBoard = mongoose.model("RoomBoard", roomBoardSchema);

const chatMessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  username: { type: String, required: true },
  message: { type: String, required: true, maxlength: 500 },
  sentAt: { type: Date, default: Date.now },
}, { timestamps: true });
chatMessageSchema.index({ roomId: 1, sentAt: -1 });
const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

const redoStacks = new Map();
const roomQueues = new Map();

function runRoomOperation(room, operation) {
  const previous = roomQueues.get(room) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  roomQueues.set(room, current);
  return current.finally(() => {
    if (roomQueues.get(room) === current) roomQueues.delete(room);
  });
}

app.get("/", (_req, res) => res.json({ message: "CollabBoard API is running!" }));

function getParticipants(room) {
  return [...(io.sockets.adapter.rooms.get(room) || [])].map((id) => {
    const client = io.sockets.sockets.get(id);
    return {
      id,
      username: client?.data.username || "Student",
      role: client?.data.role || "student",
    };
  });
}
function sendParticipants(room) {
  io.to(room).emit("participants-update", getParticipants(room));
}
function validRoom(socket, roomId) {
  const room = typeof roomId === "string" ? roomId.trim().toUpperCase() : "";
  return room && socket.data.roomId === room && socket.rooms.has(room) ? room : null;
}
function isTeacher(socket) {
  return socket.data.role === "teacher";
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join-room", async ({ roomId, username, requestedRole } = {}, callback) => {
    try {
      if (typeof roomId !== "string" || !roomId.trim()) {
        callback?.({ error: "Valid room code required" });
        return;
      }
      const room = roomId.trim().toUpperCase();
      const name = typeof username === "string" && username.trim() ? username.trim().slice(0, 24) : "Student";
      let board = await RoomBoard.findOne({ roomId: room });
      const creating = requestedRole === "teacher" && !board;

      if (!board) {
        board = await RoomBoard.create({
          roomId: room,
          segments: [],
          teacherSocketId: creating ? socket.id : null,
          teacherName: creating ? name : null,
          boardLocked: false,
        });
      } else if (!board.teacherSocketId && requestedRole === "teacher") {
        board.teacherSocketId = socket.id;
        board.teacherName = name;
        await board.save();
      }

      const previousRoom = socket.data.roomId;
      if (previousRoom && previousRoom !== room) {
        socket.leave(previousRoom);
        sendParticipants(previousRoom);
        socket.to(previousRoom).emit("cursor-left", { id: socket.id });
      }

      const role = board.teacherSocketId === socket.id ? "teacher" : "student";
      socket.data.roomId = room;
      socket.data.username = name;
      socket.data.role = role;
      socket.join(room);

      const savedMessages = await ChatMessage.find({ roomId: room }).sort({ sentAt: -1 }).limit(100).lean();
      socket.emit("board-state", board.segments || []);
      socket.emit("room-role", { role, boardLocked: board.boardLocked });
      sendParticipants(room);
      callback?.({ success: true, roomId: room, role, boardLocked: board.boardLocked });
      socket.emit("chat-history", savedMessages.reverse().map((item) => ({
        id: String(item._id), username: item.username, message: item.message, time: item.sentAt.toISOString(),
      })));
    } catch (error) {
      console.error("Join room error:", error.message);
      callback?.({ error: "Could not load room from database" });
    }
  });

  socket.on("leave-room", (callback) => {
    const room = socket.data.roomId;
    if (!room) return callback?.({ success: true });
    socket.leave(room);
    socket.to(room).emit("cursor-left", { id: socket.id });
    socket.data.roomId = null;
    socket.data.username = null;
    socket.data.role = null;
    sendParticipants(room);
    callback?.({ success: true });
  });

  socket.on("cursor-move", ({ roomId, x, y } = {}) => {
    const room = validRoom(socket, roomId);
    if (!room || !Number.isFinite(x) || !Number.isFinite(y)) return;
    socket.to(room).emit("cursor-update", {
      id: socket.id, username: socket.data.username || "Student",
      x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)),
    });
  });

  socket.on("draw", async ({ roomId, segment } = {}) => {
    try {
      const room = validRoom(socket, roomId);
      if (!room || !segment || typeof segment !== "object") return;
      const board = await RoomBoard.findOne({ roomId: room }).lean();
      if (!board) return;
      if (board.boardLocked && !isTeacher(socket)) {
        socket.emit("board-error", { message: "Teacher has locked the board." });
        return;
      }
      const kind = segment.kind || "stroke";
      const numeric = ["x0", "y0"].every((key) => Number.isFinite(segment[key]));
      const shapeNumeric = kind !== "shape" || ["x1", "y1"].every((key) => Number.isFinite(segment[key]));
      if (!numeric || !shapeNumeric || !["stroke", "shape", "text"].includes(kind)) return;
      if (kind !== "text" && (!Number.isFinite(segment.width) || segment.width < 1 || segment.width > 100)) return;
      if (kind === "shape" && !["rect", "circle", "arrow", "line"].includes(segment.shape)) return;
      if (kind === "text" && (typeof segment.text !== "string" || !segment.text.trim() || segment.text.length > 240)) return;
      for (const key of ["x0", "y0", "x1", "y1"]) {
        if (segment[key] !== undefined && (segment[key] < 0 || segment[key] > 1)) return;
      }
      const safeSegment = {
        ...segment,
        kind,
        color: typeof segment.color === "string" && /^#[0-9a-fA-F]{6}$/.test(segment.color) ? segment.color : "#2563eb",
        width: Math.min(100, Math.max(1, Number(segment.width) || 3)),
        strokeId: typeof segment.strokeId === "string" ? segment.strokeId.slice(0, 80) : `${socket.id}-${Date.now()}`,
        createdBy: socket.data.username || "Student",
      };
      await runRoomOperation(room, async () => {
        await RoomBoard.updateOne({ roomId: room }, { $push: { segments: safeSegment } });
        redoStacks.set(room, []);
        socket.to(room).emit("draw", safeSegment);
      });
    } catch (error) {
      console.error("Save drawing error:", error.message);
      socket.emit("board-error", { message: "Drawing could not be saved. Please try again." });
    }
  });

  socket.on("undo-board", async ({ roomId } = {}) => {
    try {
      const room = validRoom(socket, roomId);
      if (!room) return;
      if (!isTeacher(socket)) {
        socket.emit("board-error", { message: "Only the teacher can undo board changes." });
        return;
      }
      await runRoomOperation(room, async () => {
        const board = await RoomBoard.findOne({ roomId: room });
        if (!board || !board.segments.length) return;
        const segments = board.segments.map((s) => s?.toObject ? s.toObject() : s);
        const last = segments[segments.length - 1];
        if (!last?.strokeId) {
          socket.emit("board-error", { message: "This old drawing has no stroke ID. Add a new drawing to test Undo." });
          return;
        }
        const removed = segments.filter((s) => s.strokeId === last.strokeId);
        const remaining = segments.filter((s) => s.strokeId !== last.strokeId);
        await RoomBoard.updateOne({ roomId: room }, { $set: { segments: remaining } });
        const stack = redoStacks.get(room) || [];
        stack.push(removed);
        redoStacks.set(room, stack);
        io.to(room).emit("board-state", remaining);
      });
    } catch (error) {
      console.error("Undo error:", error.message);
      socket.emit("board-error", { message: "Undo failed. Please try again." });
    }
  });

  socket.on("redo-board", async ({ roomId } = {}) => {
    try {
      const room = validRoom(socket, roomId);
      if (!room) return;
      if (!isTeacher(socket)) {
        socket.emit("board-error", { message: "Only the teacher can redo board changes." });
        return;
      }
      await runRoomOperation(room, async () => {
        const stack = redoStacks.get(room) || [];
        if (!stack.length) return;
        const board = await RoomBoard.findOne({ roomId: room });
        if (!board) return;
        const updated = [...board.segments.map((s) => s?.toObject ? s.toObject() : s), ...stack[stack.length - 1]];
        await RoomBoard.updateOne({ roomId: room }, { $set: { segments: updated } });
        stack.pop();
        redoStacks.set(room, stack);
        io.to(room).emit("board-state", updated);
      });
    } catch (error) {
      console.error("Redo error:", error.message);
      socket.emit("board-error", { message: "Redo failed. Please try again." });
    }
  });

  socket.on("clear-board", async ({ roomId } = {}) => {
    try {
      const room = validRoom(socket, roomId);
      if (!room) return;
      if (!isTeacher(socket)) {
        socket.emit("board-error", { message: "Only the teacher can clear the board." });
        return;
      }
      await runRoomOperation(room, async () => {
        await RoomBoard.updateOne({ roomId: room }, { $set: { segments: [] } });
        redoStacks.set(room, []);
        io.to(room).emit("board-cleared");
      });
    } catch (error) {
      console.error("Clear board error:", error.message);
      socket.emit("board-error", { message: "Board could not be cleared." });
    }
  });

  socket.on("set-board-lock", async ({ roomId, locked } = {}) => {
    const room = validRoom(socket, roomId);
    if (!room || !isTeacher(socket) || typeof locked !== "boolean") return;
    await RoomBoard.updateOne({ roomId: room }, { $set: { boardLocked: locked } });
    io.to(room).emit("board-lock-state", { locked });
  });

  socket.on("chat-message", async ({ roomId, message } = {}) => {
    try {
      const room = validRoom(socket, roomId);
      if (!room || typeof message !== "string") return;
      const text = message.trim();
      if (!text || text.length > 500) return;
      const saved = await ChatMessage.create({
        roomId: room, username: socket.data.username || "Student", message: text,
      });
      io.to(room).emit("chat-message", {
        id: String(saved._id), username: saved.username, message: saved.message, time: saved.sentAt.toISOString(),
      });
    } catch (error) {
      console.error("Save chat error:", error.message);
      socket.emit("board-error", { message: "Chat message could not be saved." });
    }
  });

  socket.on("disconnect", () => {
    const room = socket.data.roomId;
    if (room) {
      socket.to(room).emit("cursor-left", { id: socket.id });
      setTimeout(() => sendParticipants(room), 0);
      // A disconnected teacher releases the in-memory room role; the next teacher-requesting join can claim it.
      RoomBoard.updateOne({ roomId: room, teacherSocketId: socket.id }, {
        $set: { teacherSocketId: null },
      }).then(() => {
        const remaining = io.sockets.adapter.rooms.get(room);
        if (!remaining || remaining.size === 0) return;
        const nextTeacher = [...remaining].map((id) => io.sockets.sockets.get(id)).find((s) => s?.data.role === "teacher");
        if (nextTeacher) {
          return RoomBoard.updateOne({ roomId: room }, { $set: { teacherSocketId: nextTeacher.id, teacherName: nextTeacher.data.username } });
        }
      }).catch((error) => console.error("Teacher cleanup error:", error.message));
    }
  });
});

const PORT = process.env.PORT || 5000;
async function startServer() {
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing. Check your backend .env file.");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB Atlas connected successfully!");
    server.listen(PORT, () => console.log(`CollabBoard server running on port ${PORT}`));
  } catch (error) {
    console.error("Startup error:", error.message);
    process.exit(1);
  }
}
startServer();
