require("dotenv").config();
const express = require("express");
const { pipeline } = import("@xenova/transformers");
const cors = require("cors");
const path = require("path");
const port = 3322;
const app = express();
const admin = require("firebase-admin");
const deepl = require("deepl-node");

const {
  firestore,
  serverTimestamp,
  firebaseAuth,
} = require("./firebaseService");
const http = require("http");
const multer = require("multer");
const WebSocket = require("ws");

app.use(cors({ origin: "*" }));
app.get("/", (req, res) => {
  res.send("Alloo we are live my bwooy!");
});
const upload = multer({
  storage: multer.memoryStorage(),
});

const checkAndSetCooldown = async (userId) => {
  const userRef = firestore.collection("Users").doc(userId);
  const tasksRef = userRef.collection("assignedTasks");
  
  const pendingTasks = await tasksRef.where("status", "in", ["active", "Pending"]).get();
  
  if (pendingTasks.empty) {
    const cooldownHours = 2;
    const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
    
    await userRef.update({
      taskCooldownUntil: admin.firestore.Timestamp.fromDate(cooldownUntil),
      lastTaskBatchCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      hasTasks: false,
    });
    
    return { cooldownUntil, cooldownHours };
  }
  return null;
};

const authKey = process.env.TRANSLATE_AUTHKEY; // replace with your key
const translator = new deepl.Translator(authKey);
async function translateTxt(content, trnsLang) {
  const result = await translator.translateText(content, "EN", trnsLang);

  return result.text;
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let userConnections = new Map(); // uid -> set of ws


let modelInstance = null;

async function initModel() {
  modelInstance = await loadModel();
  console.log("Model ready globally");
}

server.listen(port, async () => {
  await initModel(); // run at server startup
  console.log(`Hello Rodger you app is running on port ${port}`);
});



let extractor = null;

// load model once
async function loadModel() {
  if (!extractor) {
    const { pipeline } = await import("@xenova/transformers");

    extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );

    console.log("Embedding model loaded");
  }
  return extractor;
}

// cosine similarity
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vec : vec.map(x => x / norm);
}

function meanPooling(tensor) {
  const data = tensor.data;
  const [ , tokens, size ] = tensor.dims;

  const embedding = new Array(size).fill(0);

  for (let t = 0; t < tokens; t++) {
    const offset = t * size;

    for (let i = 0; i < size; i++) {
      embedding[i] += data[offset + i];
    }
  }

  for (let i = 0; i < size; i++) {
    embedding[i] /= tokens;
  }

  return embedding;
}
async function weRTest(reference, userText, modelInstance){ 
  const score = await scoreTexts(reference, userText, modelInstance);

  return score;
}
async function scoreTexts(reference, userText, modelInstance) {
  const emb1 = await modelInstance(reference);
  const emb2 = await modelInstance(userText);

  let vec1 = normalize(meanPooling(emb1));
  let vec2 = normalize(meanPooling(emb2));

  let semanticScore = cosineSimilarity(vec1, vec2) * 100;

  const lenRatio =
    Math.min(reference.length, userText.length) /
    Math.max(reference.length, userText.length);

  let lengthScore = lenRatio * 100;

  // 🔥 CALIBRATION (this is the magic part)

  // Boost weak but valid matches (cross-language sentences)
  if (semanticScore > 2 && semanticScore < 50) {
    semanticScore = semanticScore * 1.8 + 20;
  }

  // Prevent very low scores for meaningful translations
  if (semanticScore < 30) {
    semanticScore += 25;
  }

  // Clamp
  semanticScore = Math.min(100, semanticScore);

  // Weighted final score (meaning matters more)
  let aiScore = semanticScore * 0.85 + lengthScore * 0.15;

  aiScore = Math.round(Math.max(0, Math.min(100, aiScore)));

  return aiScore;
}

// grammar check using LanguageTool
async function grammarErrors(text) {
  const params = new URLSearchParams();
  params.append("text", text);
  params.append("language", "en"); // change if needed

  const res = await fetch("https://api.languagetool.org/v2/check", {
    method: "POST",
    body: params,
  });

  const data = await res.json();
  return data.matches.length;
}

// 1️⃣ GLOBAL TIMER REGISTRY
const activeTaskTimers = new Map();
// Add this with your other maps
const activeScreeningTimers = new Map();

const startScreeningTimer = ({ ws, userId, testId, duration, startedAt }) => {
  const key = `${userId}_${testId}`;

  if (activeScreeningTimers.has(key)) {
    activeScreeningTimers.get(key).sockets.add(ws);
    return;
  }

  const sockets = new Set([ws]);

  const intervalId = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsed = Math.floor((now - startedAt) / 1000);
      const remaining = duration - elapsed;

      sockets.forEach((s) => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({
            type: "screeningTimerUpdate",
            remainingTime: remaining,
          }));
        }
      });

      if (remaining <= 0) {
        clearInterval(intervalId);
        activeScreeningTimers.delete(key);

        const testRef = firestore
          .collection("Users")
          .doc(userId)
          .collection("screeningTests")
          .doc(testId);

        await testRef.update({ status: "expired" });

        sockets.forEach((s) => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "screeningTimeExpired",
            }));
          }
        });
      }
    } catch (err) {
      console.error("Screening timer error:", err);
    }
  }, 1000);

  activeScreeningTimers.set(key, { intervalId, sockets, duration, startedAt });
};

const startTaskTimer = ({ ws, userId, taskId, duration, startedAt }) => {
  const key = `${userId}_${taskId}`;

  // If timer already exists, just add this socket
  if (activeTaskTimers.has(key)) {
    activeTaskTimers.get(key).sockets.add(ws);
    return;
  }

  // Otherwise, start a new timer
  const sockets = new Set([ws]);

  const intervalId = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsed = Math.floor((now - startedAt) / 1000);
      const remaining = duration - elapsed;

      // Broadcast to all sockets
      sockets.forEach((s) => {
        try {
          s.send(
            JSON.stringify({
              type: "timerUpdate",
              taskId,
              remainingTime: remaining,
            }),
          );
        } catch (err) {
          console.error("Socket send error:", err);
        }
      });

      // Task finished
      if (remaining <= 0) {
        clearInterval(intervalId);
        activeTaskTimers.delete(key);

        await firestore
          .collection("Users")
          .doc(userId)
          .collection("assignedTasks")
          .doc(taskId)
          .update({ status: "Timed-out" });

        sockets.forEach((s) => {
          try {
            s.send(
              JSON.stringify({
                type: "taskComplete",
                taskId,
                completeMethod: "Timed-out",
                payOut: 0,
              }),
            );
          } catch (err) {
            console.log(err);
          }
        });
      }
    } catch (err) {
      console.error("Timer error:", err);
    }
  }, 1000);

  activeTaskTimers.set(key, { intervalId, sockets, duration, startedAt });
};

wss.on("connection", (ws) => {
  // Expect client to send uid immediately
  ws.on("message", async (msg) => {

    try {
      const data = JSON.parse(msg);
      console.log(data);
       console.log("this is the socket type: " + data.type)

        
     switch (data.type) {

  case "init":
    if (!data.uid) return;

    ws.uid = data.uid;
    ws.taskId = data.taskId || null;

    // 🚫 SINGLE DEVICE ENFORCEMENT
    if (userConnections.has(ws.uid)) {
      const existingSockets = userConnections.get(ws.uid);

      existingSockets.forEach((oldWs) => {
        try {
          oldWs.send(
            JSON.stringify({
              type: "forceLogout",
              reason: "You logged in from another device",
            })
          );
          oldWs.close();
        } catch (e) {}
      });

      userConnections.delete(ws.uid);
    }

    // Register new socket
    userConnections.set(ws.uid, new Set([ws]));

    console.log(
      `User ${ws.uid} connected, devices: ${userConnections.get(ws.uid).size}`
    );

    // ---------- 🔁 RESUME TASK IF PRESENT ----------
    if (ws.taskId) {
      try {
        const taskRef = firestore
          .collection("Users")
          .doc(ws.uid)
          .collection("assignedTasks")
          .doc(ws.taskId);

        const snap = await taskRef.get();
        const task = snap.data();

        if (!task) {
          ws.send(JSON.stringify({
            type: "resumeError",
            reason: "Task not found or unauthorized",
          }));
          return;
        }

        if (task.status === "Complete") {
          ws.send(JSON.stringify({ type: "taskComplete" }));
          return;
        }

        const now = Date.now();
        const elapsed = Math.floor(
          (now - task.assignedAt.toMillis()) / 1000
        );
        const remaining = Math.max(task.durationSec - elapsed, 0);

        // 1️⃣ Send immediate remaining time
        ws.send(JSON.stringify({
          type: "timerUpdate",
          remainingTime: remaining,
        }));

        console.log(
          `Resumed task ${ws.taskId} for user ${ws.uid}, remaining ${remaining}s`
        );

        // 2️⃣ Attach socket to active timer OR start new one
        const key = `${ws.uid}_${ws.taskId}`;

        if (activeTaskTimers.has(key)) {
          activeTaskTimers.get(key).sockets.add(ws);
        } else {
          startTaskTimer({
            ws,
            userId: ws.uid,
            taskId: ws.taskId,
            duration: task.durationSec,
            startedAt: task.assignedAt.toMillis(),
          });
        }

      } catch (err) {
        console.error("Resume failed:", err);

        ws.send(JSON.stringify({
          type: "resumeError",
          reason: err.message,
        }));
      }
    }

    break;
case "requestTask":
  if (!data.uid) return;
  
  const userRef = firestore.collection("Users").doc(data.uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "Error",
      reason: "An error occurred. Try again later.",
    }));
    break;
  }

  const user = userSnap.data();
  const now = Date.now();

  // ❌ Not eligible
  if (!user.jobEligibility) {
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "Not Eligible",
      reason: "You are not eligible for tasks at the moment.",
    }));
    break;
  }

  // ✅ Check if user is in cooldown
  if (user.taskCooldownUntil && user.taskCooldownUntil.toMillis() > now) {
    const remainingMinutes = Math.ceil((user.taskCooldownUntil.toMillis() - now) / 60000);
    const remainingHours = Math.floor(remainingMinutes / 60);
    const remainingMins = remainingMinutes % 60;
    
    let timeMessage = "";
    if (remainingHours > 0) {
      timeMessage = `${remainingHours} hour${remainingHours > 1 ? 's' : ''}`;
      if (remainingMins > 0) timeMessage += ` and ${remainingMins} minute${remainingMins > 1 ? 's' : ''}`;
    } else {
      timeMessage = `${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
    }
    
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "Cooldown",
      reason: `New tasks available in ${timeMessage}. Complete your current tasks first!`,
      remainingTime: user.taskCooldownUntil.toMillis() - now,
    }));
    break;
  }

  // ❌ Daily limit reached
  if (user.dailyTaskTaken >= 100) {
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "Limit Reached",
      reason: "Sorry, you've reached your daily task limit!",
    }));
    break;
  }

  // ❌ Already working on a task
  if (user.taskID) {
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "Denied",
      reason: "You have already been assigned an AI task.",
    }));
    break;
  }

  // ✅ USER IS ELIGIBLE → FETCH TASKS
  const taskQuery = await firestore
    .collection("Ai-tasks")
    .where("status", "==", "active")
    .get();

  if (taskQuery.empty) {
    ws.send(JSON.stringify({
      type: "taskResponse",
      status: "No Tasks Available",
      reason: "Sorry, we have no tasks at the moment. Try again later.",
    }));
    break;
  }

  // Convert to array and shuffle
  const availableTasks = taskQuery.docs.map((doc) => ({
    taskId: doc.id,
    ...doc.data(),
  }));

  // Fisher-Yates shuffle for randomness
  for (let i = availableTasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [availableTasks[i], availableTasks[j]] = [availableTasks[j], availableTasks[i]];
  }

  const BATCH_SIZE = 10;
  const tasksToAssign = availableTasks.slice(0, BATCH_SIZE);
  
  // ✅ DECLARE HERE (outside transaction)
  let assignedTasks = [];

  await admin.firestore().runTransaction(async (tx) => {
    tx.update(userRef, {
      dailyTaskTaken: admin.firestore.FieldValue.increment(tasksToAssign.length),
    });

    for (const task of tasksToAssign) {
      const taskRef = firestore.collection("Ai-tasks").doc(task.taskId);
      tx.update(taskRef, {
        assignCount: admin.firestore.FieldValue.increment(1),
        assignedTo: data.uid,
      });

      assignedTasks.push({
        taskId: task.taskId,
        instructions: task.instructions,
        pay: task.pay,
        status: "Pending",
        type: task.type,
        mainTask: task,
      });
    }
  });

  // Save tasks in batch
  const batch = firestore.batch();
  for (const task of assignedTasks) {
    const taskRef = firestore
      .collection("Users")
      .doc(data.uid)
      .collection("assignedTasks")
      .doc(task.taskId);

    batch.set(taskRef, {
      taskId: task.taskId,
      task: task,
      type: task.type,
      pay: task.pay,
      instructions: task.instructions,
      status: task.status,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      batchNumber: user.totalCompletedTasks ? Math.floor(user.totalCompletedTasks / BATCH_SIZE) + 1 : 1,
    });
  }
  
  await batch.commit();
  
  await firestore.collection("Users").doc(data.uid).update({
    hasTasks: true,
  });
  
  ws.send(JSON.stringify({
    type: "taskResponse",
    status: "Success",
    tasks: assignedTasks.map(t => ({ taskId: t.taskId, type: t.type })),
    message: `${tasksToAssign.length} tasks assigned. Complete them to unlock the next batch!`,
  }));
  
  break;
  case "startTask":
  if (!data.userId || !data.taskId) break;

  const duration = 900; // seconds

  const taskRef = firestore
    .collection("Users")
    .doc(data.userId)
    .collection("assignedTasks")
    .doc(data.taskId);

  try {
    // 1️⃣ Update Firestore FIRST
    await taskRef.update({
      status: "active",
      assignedAt: serverTimestamp(),
      durationSec: duration,
    });

    console.log("Task started for:", data.userId);

    // 2️⃣ READ BACK server timestamp (CRITICAL)
    const snap = await taskRef.get();

    if (!snap.exists) {
      throw new Error("Task document not found after update");
    }

    const startedAt = snap.data().assignedAt.toMillis();

    // 3️⃣ START SERVER TIMER ⏱️
    startTaskTimer({
      ws,
      userId: data.userId,
      taskId: data.taskId,
      duration,
      startedAt,
    });

    // 4️⃣ Respond to client
    ws.send(
      JSON.stringify({
        type: "startTaskResponse",
        msg: "You are ready to begin",
      }),
    );
  } catch (error) {
    console.error("Task launch failed:", error);

    ws.send(
      JSON.stringify({
        type: "startTaskError",
        msg: "Sorry, an error occurred when starting the task",
      }),
    );
  }


  break;
  case "submitTask":

  if (!data.uid || !data.taskId || !data.taskType) break;

  if (data.taskType == "Content Review") {
    const key = `${data.uid}_${data.taskId}`;
    let timer;
    let payOut=0;

    try {
      if (activeTaskTimers.has(key)) {
        timer = activeTaskTimers.get(key);
        clearInterval(timer.intervalId);
      }

      const language = "en-US";

      const checkText = async (text) => {
        const formData = new URLSearchParams();
        formData.append("text", text);
        formData.append("language", language);

        const res = await fetch("https://api.languagetool.org/v2/check", {
          method: "POST",
          body: formData,
        });

        const result = await res.json();
        return (result.matches || []).length;
      };

      const originalErrors = await checkText(data.originalText);
      const refinedErrors = await checkText(data.refinedText);

      let aiScore =
        100 - refinedErrors * 10 + (originalErrors - refinedErrors) * 5;
      aiScore = Math.max(0, Math.min(100, aiScore));

      const userRef = firestore.collection("Users").doc(data.uid);
      const taskRef = userRef
        .collection("assignedTasks")
        .doc(data.taskId);

      let cash = 0;
      let rewarded = false;
      let status = "Failed";

   await firestore.runTransaction(async (tx) => {
  const [taskSnap, userSnap] = await Promise.all([
    tx.get(taskRef),
    tx.get(userRef),
  ]);

  if (!taskSnap.exists || !userSnap.exists) return;
  if (taskSnap.data().status === "Completed") return;

  const currentBalance = userSnap.data().accountBalance || 0;
  const currentPoints = userSnap.data().accountPoints || 0;

  let pointsEarned = 0;
 if (aiScore >= 80) {
  const payPercent = aiScore / 100;
  const fullPay = parseInt(taskSnap.data().pay, 10) || 0;
   payOut = Math.round((fullPay * payPercent) * 100) / 100;  // ✅ Rounds to 2 decimals
  
  rewarded = true;
  status = "Completed";

  // 🎯 POINTS LOGIC
  pointsEarned = Math.floor(aiScore / 10); // e.g. 85 → 8 points

  tx.update(taskRef, {
    aiScore,
    reviewedAt: Date.now(),
    status,
    rewarded: true,
    pointsEarned,
    fullPay,        // Store original amount
    payOut,         // Store what they actually got
    payPercent,     // Store percentage
  });

  tx.update(userRef, {
    accountBalance: currentBalance + payOut,  // ✅ Add payOut, not fullPay!
    accountPoints: currentPoints + pointsEarned,
  });
}else {
    tx.update(taskRef, {
      aiScore,
      reviewedAt: Date.now(),
      status,
      rewarded: false,
    });
  }
});


  const cooldownInfo = await checkAndSetCooldown(data.uid);

    if (timer?.sockets?.size) {
      timer.sockets.forEach((s) => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(
            JSON.stringify({
              type: "taskComplete",
              taskId: data.taskId,
              aiScore,
              payOut,  // ✅ USE payOut (not cash)
              rewarded,
              status,
              completeMethod: "Instant",
              cooldown: cooldownInfo, // ✅ SEND cooldown info
            }),
          );
        }
      });
    }

    activeTaskTimers.delete(key);
    } catch (error) {
      console.error("Error processing task:", error.message);

      if (timer?.sockets?.size) {
        timer.sockets.forEach((s) => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(
              JSON.stringify({
                type: "taskError",
                taskId: data.taskId,
                error: error.message || "Task processing failed",
              }),
            );
          }
        });
      }
    }
  }

  if (data.taskType === "Content Translation") {
    const key = `${data.uid}_${data.taskId}`;
    let timer;
    let payOut = 0;

    try {


      if (!modelInstance) {
  console.log("Model not ready yet");

  if (timer?.sockets?.size) {
    timer.sockets.forEach((s) => {
      if (s.readyState === WebSocket.OPEN) {
        s.send(
          JSON.stringify({
            type: "taskError",
            taskId: data.taskId,
            error: "System warming up, try again in a few seconds",
          })
        );
      }
    });
  }

  return;
       }


      if (activeTaskTimers.has(key)) {
        timer = activeTaskTimers.get(key);
        clearInterval(timer.intervalId);
      }
      const reference = data.textotranslate ;
      const userText = data.translatedText;
      if (!reference || !userText) throw new Error("Invalid input");
   
let aiScore = await weRTest(reference, userText, modelInstance);
      const userRef = firestore.collection("Users").doc(data.uid);
      const taskRef = userRef
        .collection("assignedTasks")
        .doc(data.taskId);

      let cash = 0;
      let rewarded = false;
      let status = "Failed";

   await firestore.runTransaction(async (tx) => {
  const [taskSnap, userSnap] = await Promise.all([
    tx.get(taskRef),
    tx.get(userRef),
  ]);

  if (!taskSnap.exists || !userSnap.exists) return;
  if (taskSnap.data().status === "Completed") return;

  const currentBalance = userSnap.data().accountBalance || 0;
  const currentPoints = userSnap.data().accountPoints || 0;

  let pointsEarned = 0;

 if (aiScore >= 75) {
  const payPercent = aiScore / 100;
  const fullPay = parseInt(taskSnap.data().pay, 10) || 0;
   payOut = Math.round((fullPay * payPercent) * 100) / 100;  // ✅ Rounds to 2 decimals
  rewarded = true;
  status = "Completed";

  // 🎯 POINTS LOGIC
  pointsEarned = Math.floor(aiScore / 10);

  tx.update(taskRef, {
    aiScore,
    reviewedAt: Date.now(),
    status,
    rewarded: true,
    pointsEarned,
    fullPay,
    payOut,
    payPercent,
  });

  tx.update(userRef, {
    accountBalance: currentBalance + payOut,  // ✅ Use payOut, not cash
    accountPoints: currentPoints + pointsEarned,
  });
} else {
    tx.update(taskRef, {
      aiScore,
      reviewedAt: Date.now(),
      status,
      rewarded: false,
    });
  }
});

  const cooldownInfo = await checkAndSetCooldown(data.uid);

    if (timer?.sockets?.size) {
      timer.sockets.forEach((s) => {
        s.send(JSON.stringify({
          type: "taskComplete",
          taskId: data.taskId,
          aiScore,
          payOut,  // ✅ USE payOut
          rewarded,
          status,
          completeMethod: "Instant",
          cooldown: cooldownInfo,
        }));
      });
    }
      activeTaskTimers.delete(key);
    } catch (error) {
      console.error("Error processing translation task:", error.message);

      if (timer?.sockets?.size) {
        timer.sockets.forEach((s) => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(
              JSON.stringify({
                type: "taskError",
                taskId: data.taskId,
                error: error.message || "Task processing failed",
              }),
            );
          }
        });
      }
    }
  }

  if (data.taskType === "Fact Check") {
    const key = `${data.uid}_${data.taskId}`;
    let timer;
        let payOut = 0;


    try {
      if (activeTaskTimers.has(key)) {
        timer = activeTaskTimers.get(key);
        clearInterval(timer.intervalId);
      }

      const correctVerdict = data.originalverdict;
      const userVerdict = data.userVerdict;

      const correctExplanation = data.originalExplanation;
      const userExplanation = data.userExplanation;


      let verdictScore = 0;

      if (
        correctVerdict.toLowerCase().trim() ===
        userVerdict.toLowerCase().trim()
      ) {
        verdictScore = 50;
      }

      const emb1 = await modelInstance(correctExplanation);
      const emb2 = await modelInstance(userExplanation);

      const vec1 = meanPooling(emb1);
      const vec2 = meanPooling(emb2);

      const similarity = cosineSimilarity(vec1, vec2);
      const explanationScore = similarity * 40;

      const grammarErr = await grammarErrors(userExplanation);
      const grammarScore = Math.max(0, 10 - grammarErr * 2);

      let aiScore = verdictScore + explanationScore + grammarScore;
      aiScore = Math.round(Math.max(0, Math.min(100, aiScore)));

      const userRef = firestore.collection("Users").doc(data.uid);
      const taskRef = userRef
        .collection("assignedTasks")
        .doc(data.taskId);

      let cash = 0;
      let rewarded = false;
      let status = "Failed";

      await firestore.runTransaction(async (tx) => {
  const [taskSnap, userSnap] = await Promise.all([
    tx.get(taskRef),
    tx.get(userRef),
  ]);

  if (!taskSnap.exists || !userSnap.exists) return;
  if (taskSnap.data().status === "Completed") return;

  const currentBalance = userSnap.data().accountBalance || 0;
  const currentPoints = userSnap.data().accountPoints || 0;

  let pointsEarned = 0;

  if (aiScore >= 90) {
  const payPercent = aiScore / 100;
  const fullPay = parseInt(taskSnap.data().pay, 10) || 0;
   payOut = Math.round((fullPay * payPercent) * 100) / 100;  // ✅ Rounds to 2 decimals
  rewarded = true;
  status = "Completed";

  // 🎯 POINTS LOGIC
  pointsEarned = Math.floor(aiScore / 10);

  tx.update(taskRef, {
    aiScore,
    reviewedAt: Date.now(),
    status,
    rewarded: true,
    pointsEarned,
    fullPay,
    payOut,
    payPercent,
  });

  tx.update(userRef, {
    accountBalance: currentBalance + payOut,  // ✅ Use payOut, not cash
    accountPoints: currentPoints + pointsEarned,
  });
}else {
    tx.update(taskRef, {
      aiScore,
      reviewedAt: Date.now(),
      status,
      rewarded: false,
    });
  }
});
 const cooldownInfo = await checkAndSetCooldown(data.uid);

    if (timer?.sockets?.size) {
      timer.sockets.forEach((s) => {
        s.send(JSON.stringify({
          type: "taskComplete",
          taskId: data.taskId,
          aiScore,
          payOut,  // ✅ USE payOut
          rewarded,
          status,
          completeMethod: "Instant",
          cooldown: cooldownInfo,
        }));
      });
    }

      activeTaskTimers.delete(key);
    } catch (error) {
      console.error("Error processing fact check task:", error.message);

      if (timer?.sockets?.size) {
        timer.sockets.forEach((s) => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(
              JSON.stringify({
                type: "taskError",
                taskId: data.taskId,
                error: error.message || "Task processing failed",
              }),
            );
          }
        });
      }
    }
  }

  break;


  case "cancelTask":
  if (!data.uid || !data.taskId) break;

  try {
    const key = `${data.uid}_${data.taskId}`;

    // ⏱️ Stop & clear timer if it exists
    if (activeTaskTimers.has(key)) {
      const timer = activeTaskTimers.get(key);
      clearInterval(timer.intervalId);
      activeTaskTimers.delete(key);

      // 🔔 Notify all sockets tied to this task
      if (timer.sockets) {
        timer.sockets.forEach((s) => {
          try {
            s.send(
              JSON.stringify({
                type: "taskCanceled",
                taskId: data.taskId,
                reason: "User canceled task",
              }),
            );
          } catch (err) {
            console.error("Socket notify failed:", err);
          }
        });
      }
    }

    // 🔥 Update Firestore
    const taskRef = firestore
      .collection("Users")
      .doc(data.uid)
      .collection("assignedTasks")
      .doc(data.taskId);

    await taskRef.update({
      status: "Canceled",
      canceledAt: admin.firestore.FieldValue.serverTimestamp(),
      rewarded: false,
    });

    console.log(`Task ${data.taskId} canceled by user ${data.uid}`);
  } catch (err) {
    console.error("Cancel task failed:", err);

    ws.send(
      JSON.stringify({
        type: "cancelTaskError",
        msg: "Failed to cancel task. Try again.",
      }),
    );
  }

  break;

case "startScreeningTimer":
  if (!data.userId) break;

  const durationScreen = 900; // 15 minutes
  const key = `screening_${data.userId}`;

  try {
    // Check if timer already exists
    if (activeScreeningTimers.has(key)) {
      const existing = activeScreeningTimers.get(key);
      existing.sockets.add(ws);
      const now = Date.now();
      const elapsed = Math.floor((now - existing.startedAt) / 1000);
      const remaining = Math.max(durationScreen - elapsed, 0);
    
      ws.send(JSON.stringify({
        type: "screeningTimerUpdate",
        remainingTime: remaining,
      }));
      break;
    }

    // Start new timer
    const startedAt = Date.now();
    const sockets = new Set([ws]);
    
    const intervalId = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - startedAt) / 1000);
      const remaining = durationScreen - elapsed;
      
      sockets.forEach((s) => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({
            type: "screeningTimerUpdate",
            remainingTime: remaining,
          }));
        }
      });
      
      if (remaining <= 0) {
        clearInterval(intervalId);
        activeScreeningTimers.delete(key);
        
        sockets.forEach((s) => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({ type: "screeningTimeExpired" }));
          }
        });
      }
    }, 1000);
    
    activeScreeningTimers.set(key, { intervalId, sockets, startedAt });
    
    ws.send(JSON.stringify({
      type: "screeningTimerStarted",
      remainingTime: duration,
    }));
    
  } catch (error) {
    console.error("Screening timer error:", error);
  }
  break;

  case "screeningComplete":
  if (!data.userId) break;

  try {
    const userRef = firestore.collection("Users").doc(data.userId);
    
    await userRef.update({
      screeningCompleted: true,
      screeningScore: data.score,
      screeningTotal: data.totalQuestions,
      screeningPercentage: data.percentage,
      screeningPassed: data.passed,
      screeningCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      screenCount: admin.firestore.FieldValue.increment(1),
      screeningExpired: data.timeExpired || false,
    });
    
    // Clean up timer if exists
    const key = `screening_${data.userId}`;
    if (activeScreeningTimers.has(key)) {
      const timer = activeScreeningTimers.get(key);
      clearInterval(timer.intervalId);
      activeScreeningTimers.delete(key);
    }
    
    ws.send(JSON.stringify({
      type: "screeningCompleteConfirm",
      success: true,
    }));
    
    console.log(`Screening complete for ${data.userId}: ${data.score}/${data.totalQuestions} (${data.passed ? "PASS" : "FAIL"})`);
    
  } catch (error) {
    console.error("Error saving screening results:", error);
    ws.send(JSON.stringify({
      type: "screeningCompleteError",
      error: error.message,
    }));
  }
  break;

}
    

   
    } catch (err) {
      console.error("Invalid message", err);
    }
  });
  ws.on("close", () => {
    if (ws.uid && userConnections.has(ws.uid)) {
      userConnections.get(ws.uid).delete(ws);
      if (userConnections.get(ws.uid).size === 0) {
        userConnections.delete(ws.uid);
      }
      console.log(`User ${ws.uid} disconnected`);
    }
  });
  ws.on("error", (err) => {
    console.error("WebSocket error", err);
  });
});

//  admin set claims

const adminUIDS = [process.env.ADMIN_ONE];

adminUIDS.forEach((uid) => {
  admin
    .auth()
    .setCustomUserClaims(uid, { admin: true })
    .then(() => {
      console.log("Admin is set", uid);
    })
    .catch((err) => {
      console.error("Admin authentication failed", err);
    });
});

// claims end

app.post("/uploadAITask", upload.none(), async (req, res) => {
  const { taskType, content, uid, jobpay } = req.body;
  // if (adminUIDS.includes(uid)) {
    if (!uid) {

    return res.status(403).json({
      status: 403,
      msg: "You do not have access",
    });
  }

    const docRef = await firestore.collection("Ai-tasks").doc();
    docRef
      .set({
        taskId: docRef.id,
        assignCount: 0,
        type: taskType,
        instructions:
          "Fix grammar, spelling, and clarity. Do not change the meaning.",
        originaltext: content,
        pay: Number(jobpay),
        status: "active",
      })
      .then(() => {
        res.json({ msg: "AI task uploaded", status: 200 });
      })
      .catch(() => {
        res.json({ msg: "Error uploading task", status: 300 });
      });
  
});

app.post("/Aloo", (req, res) => {
  res.json({ message: "Wozaaaa" });
});

// ---------- Upload Translation Task Route ----------
app.post("/uploadTranslationTask", upload.none(), async (req, res) => {
  const { taskType, content, uid, jobpay, trnsLang } = req.body;

  // Only allow admins
  // if (!adminUIDS.includes(uid)) {
    if (!uid) {

    return res.status(403).json({
      status: 403,
      msg: "You do not have access",
    });
  }

  try {
    // ----------- Step 1: Translate content -----------
    const translatedContent = await translateTxt(content, trnsLang);

    // ----------- Step 2: Save task to Firestore -----------
    const docRef = firestore.collection("Ai-tasks").doc();
    const langs = [
      { lng: "DE", language: "German" },
      { lng: "FR", language: "French" },
      { lng: "ES", language: "Spanish" },
      { lng: "IT", language: "Italian" },
      { lng: "pt-BR", language: "Portuguese" },
      { lng: "NL", language: "Dutch" },
      { lng: "DA", language: "Danish" },
      { lng: "SV", language: "Swedish" },
      { lng: "PL", language: "Polish" },
      { lng: "CS", language: "Czech" },
      { lng: "SW", language: "Swahili" },
    ];

    const cleanLng = langs.find((item) => item.lng === trnsLang);
    await docRef.set({
      taskId: docRef.id,
      assignCount: 0,
      type: taskType,
      instructions: `Translate the content to ${cleanLng.language}. Do not change the meaning.`,
      originaltext: content,
      translatedText: translatedContent,
      language: trnsLang,
      pay: Number(jobpay),
      status: "active",
    });

    res.json({
      msg: "AI task uploaded",
      status: 200,
      translation: translatedContent,
    });
  } catch (error) {
    console.error("Upload task error:", error);
    res.status(500).json({
      msg: "Error uploading task",
      status: 500,
      error: error.message,
    });
  }
});

// upload fact check route

app.post("/uploadFactCheckTask", upload.none(), async (req, res) => {
  const { taskType, explanation, statement, verdict, jobpay, uid } = req.body;

  // Only allow admins
  // if (!adminUIDS.includes(uid)) {
    if (!uid) {

    return res.status(403).json({
      status: 403,
      msg: "You do not have access",
    });
  }

  try {
    // ----------- Step 2: Save task to Firestore -----------
    const docRef = firestore.collection("Ai-tasks").doc();

    await docRef.set({
      taskId: docRef.id,
      assignCount: 0,
      type: taskType,
      instructions: `Is the below statement TRUE or FALSE. Give your reason.`,
      statement: statement,
      verdict: verdict,
      explanation: explanation,
      pay: Number(jobpay),
      status: "active",
    });

    res.json({
      msg: "AI task uploaded",
      status: 200,
    });
  } catch (error) {
    console.error("Upload task error:", error);
    res.status(500).json({
      msg: "Error uploading task",
      status: 500,
      error: error.message,
    });
  }
});





app.post("/uploadJob", upload.none(), async (req, res) => {
  const { jobCat, jobName, jobReq,jobDesc,jobPay,uid } = req.body;
  // if (adminUIDS.includes(uid)) {
    if (!uid) {

    return res.status(403).json({
      status: 403,
      msg: "You do not have access",
    });
  }

   try {
    const docRef = firestore.collection("Jobs").doc();

    await docRef.set({
      jobID: docRef.id,
      jobCat,
      jobName,
      jobminiTtile:jobCat,
      jobReq,
      jobDesc,
      jobNameLowerCase: jobName.toLowerCase(),
      jobPay: Number(jobPay),
      status: "active",
    });

    res.json({ msg: "Job uploaded", status: 200 });
  } catch (err) {
    res.json({ msg: "Error uploading Job", status: 300 });
  }
    
});

app.post("/withdrawRequest", upload.none(), async (req, res) => {
  try {
    // 🔐 1. Verify Firebase Auth Token
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        status: 401,
        msg: "Unauthorized: No token",
      });
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const uid = decodedToken.uid;

    // 📦 2. Get data (IGNORE uid & name from frontend)
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({
        status: 400,
        msg: "Amount is required",
      });
    }

    const withdrawAmount = Number(amount);

    // 🧪 3. Validate amount
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({
        status: 400,
        msg: "Invalid amount",
      });
    }

    if (withdrawAmount < 50) {
      return res.status(400).json({
        status: 400,
        msg: "Minimum withdrawal is $50",
      });
    }

    if (withdrawAmount > 10000) {
      return res.status(400).json({
        status: 400,
        msg: "Maximum withdrawal is $10,000",
      });
    }

    // 🧾 4. Get user from Firestore
    const userRef = firestore.collection("Users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        status: 404,
        msg: "User not found",
      });
    }

    const userData = userSnap.data();

    // 💰 5. Check balance
    if (!userData.accountBalance || userData.accountBalance < withdrawAmount) {
      return res.status(403).json({
        status: 403,
        msg: "Insufficient balance",
      });
    }

    // ⏱️ 6. Cooldown protection (1 minute)
    if (userData.lastWithdrawAt) {
      const now = Date.now();
      const last = userData.lastWithdrawAt.toMillis();

      if (now - last < 60000) {
        return res.status(429).json({
          status: 429,
          msg: "Please wait before another withdrawal",
        });
      }
    }

    // 🚫 7. Prevent duplicate pending requests
    const existingRequest = await firestore
      .collection("WithdrawRequests")
      .where("uid", "==", uid)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!existingRequest.empty) {
      return res.status(409).json({
        status: 409,
        msg: "You already have a pending withdrawal",
      });
    }

    // 📝 8. Create withdrawal request
    await firestore.collection("WithdrawRequests").add({
      uid,
      name: userData.name, // ✅ always from DB
      amount: withdrawAmount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const transactionRef = firestore
  .collection("Users")
  .doc(uid)
  .collection("transactions")
  .doc();

await transactionRef.set({
  amount: withdrawAmount,
  type: "withdrawal",
  status: "pending",
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
});

    // 🕒 9. Update cooldown timestamp
    await userRef.update({
      lastWithdrawAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Success
    return res.status(200).json({
      status: 200,
      msg: "Withdrawal request submitted",
    });

  } catch (error) {
    console.error("Withdraw error:", error);

    return res.status(500).json({
      status: 500,
      msg: "Server error",
    });
  }
});

