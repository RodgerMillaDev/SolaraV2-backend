require("dotenv").config();
const express = require("express");
const { pipeline } = import("@xenova/transformers");
const cors = require("cors");
const path = require("path");
const port = 3322;
const app = express();
const nodemailer = require("nodemailer")
const admin = require("firebase-admin");
const https = require("https");
const axios = require("axios");
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

  const pendingTasks = await tasksRef
    .where("status", "in", ["active", "Pending"])
    .get();

  if (pendingTasks.empty) {
    const cooldownHours = 2;
    const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);

    // ✅ Delete ALL tasks in assignedTasks collection
    const allTasks = await tasksRef.get();
    const batch = firestore.batch();
    allTasks.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    // ✅ Update user document with cooldown
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

    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

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
  return norm === 0 ? vec : vec.map((x) => x / norm);
}

function meanPooling(tensor) {
  const data = tensor.data;
  const [, tokens, size] = tensor.dims;

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
async function weRTest(reference, userText, modelInstance) {
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
          s.send(
            JSON.stringify({
              type: "screeningTimerUpdate",
              remainingTime: remaining,
            }),
          );
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
            s.send(
              JSON.stringify({
                type: "screeningTimeExpired",
              }),
            );
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
                  }),
                );
                oldWs.close();
              } catch (e) {}
            });

            userConnections.delete(ws.uid);
          }

          // Register new socket
          userConnections.set(ws.uid, new Set([ws]));

          console.log(
            `User ${ws.uid} connected, devices: ${userConnections.get(ws.uid).size}`,
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
                ws.send(
                  JSON.stringify({
                    type: "resumeError",
                    reason: "Task not found or unauthorized",
                  }),
                );
                return;
              }

              if (task.status === "Complete") {
                ws.send(JSON.stringify({ type: "taskComplete" }));
                return;
              }

              const now = Date.now();
              const elapsed = Math.floor(
                (now - task.assignedAt.toMillis()) / 1000,
              );
              const remaining = Math.max(task.durationSec - elapsed, 0);

              // 1️⃣ Send immediate remaining time
              ws.send(
                JSON.stringify({
                  type: "timerUpdate",
                  remainingTime: remaining,
                }),
              );

              console.log(
                `Resumed task ${ws.taskId} for user ${ws.uid}, remaining ${remaining}s`,
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

              ws.send(
                JSON.stringify({
                  type: "resumeError",
                  reason: err.message,
                }),
              );
            }
          }

          break;
        case "requestTask":
          if (!data.uid) return;

          const userRef = firestore.collection("Users").doc(data.uid);
          const userSnap = await userRef.get();

          if (!userSnap.exists) {
            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "Error",
                reason: "An error occurred. Try again later.",
              }),
            );
            break;
          }

          const user = userSnap.data();
          const now = Date.now();

          // ✅ Determine user level
          const getUserLevel = (accountPoints) => {
            if (accountPoints >= 3500) return "Pro";
            if (accountPoints >= 1000) return "Intermediate";
            return "Noob";
          };

          const userLevel = getUserLevel(user.accountPoints || 0);
          const isProUser = userLevel === "Pro";

          // Set limits based on user level
          const DAILY_LIMIT = isProUser ? 50 : 30;
          const COOLDOWN_ENABLED = !isProUser; // Pro users have no cooldown

          // ❌ Not eligible
          if (!user.jobEligibility) {
            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "Not Eligible",
                reason: "You are not eligible for tasks at the moment.",
              }),
            );
            break;
          }

          // ✅ Check if user is in cooldown (skip for Pro users)
          if (
            COOLDOWN_ENABLED &&
            user.taskCooldownUntil &&
            user.taskCooldownUntil.toMillis() > now
          ) {
            const remainingMinutes = Math.ceil(
              (user.taskCooldownUntil.toMillis() - now) / 60000,
            );
            const remainingHours = Math.floor(remainingMinutes / 60);
            const remainingMins = remainingMinutes % 60;

            let timeMessage = "";
            if (remainingHours > 0) {
              timeMessage = `${remainingHours} hour${remainingHours > 1 ? "s" : ""}`;
              if (remainingMins > 0)
                timeMessage += ` and ${remainingMins} minute${remainingMins > 1 ? "s" : ""}`;
            } else {
              timeMessage = `${remainingMinutes} minute${remainingMinutes > 1 ? "s" : ""}`;
            }

            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "Cooldown",
                reason: `New tasks available in ${timeMessage}. Complete your current tasks first!`,
                remainingTime: user.taskCooldownUntil.toMillis() - now,
              }),
            );
            break;
          }

          // ❌ Daily limit reached (higher for Pro users)
          if (user.dailyTaskTaken >= DAILY_LIMIT) {
            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "Limit Reached",
                reason: isProUser
                  ? "Sorry, you've reached your daily task limit of 50 tasks!"
                  : "Sorry, you've reached your daily task limit of 30 tasks!",
              }),
            );
            break;
          }

          // ❌ Already working on a task
          if (user.taskID) {
            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "Denied",
                reason: "You have already been assigned an AI task.",
              }),
            );
            break;
          }

          // ✅ USER IS ELIGIBLE → FETCH TASKS
          const taskQuery = await firestore
            .collection("Ai-tasks")
            .where("status", "==", "active")
            .get();

          if (taskQuery.empty) {
            ws.send(
              JSON.stringify({
                type: "taskResponse",
                status: "No Tasks Available",
                reason:
                  "Sorry, we have no tasks at the moment. Try again later.",
              }),
            );
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
            [availableTasks[i], availableTasks[j]] = [
              availableTasks[j],
              availableTasks[i],
            ];
          }

          const BATCH_SIZE = isProUser ? 15 : 10; // Pro users get 15 tasks per batch
          const tasksToAssign = availableTasks.slice(0, BATCH_SIZE);

          let assignedTasks = [];

          await admin.firestore().runTransaction(async (tx) => {
            tx.update(userRef, {
              dailyTaskTaken: admin.firestore.FieldValue.increment(
                tasksToAssign.length,
              ),
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
              batchNumber: user.totalCompletedTasks
                ? Math.floor(user.totalCompletedTasks / BATCH_SIZE) + 1
                : 1,
            });
          }

          await batch.commit();

          await firestore.collection("Users").doc(data.uid).update({
            hasTasks: true,
          });

          // ✅ UPDATE STATISTICS - tasksRequested
          const monthNames = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];
          const currentMonth = monthNames[new Date().getMonth()];
          const currentYear = new Date().getFullYear();
          const statsRef = firestore
            .collection("Users")
            .doc(data.uid)
            .collection("taskStats")
            .doc(`${currentYear}_${currentMonth}`);

          await firestore.runTransaction(async (tx) => {
            const statsSnap = await tx.get(statsRef);

            if (statsSnap.exists) {
              tx.update(statsRef, {
                tasksRequested: admin.firestore.FieldValue.increment(
                  tasksToAssign.length,
                ),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              tx.set(statsRef, {
                month: currentMonth,
                year: currentYear,
                tasksRequested: tasksToAssign.length,
                tasksCompleted: 0,
                totalEarnings: 0,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });

          // Include user level in response
          ws.send(
            JSON.stringify({
              type: "taskResponse",
              status: "Success",
              tasks: assignedTasks.map((t) => ({
                taskId: t.taskId,
                type: t.type,
              })),
              message: isProUser
                ? `${tasksToAssign.length} tasks assigned (Pro benefit: 50 tasks/day, no cooldown, larger batches!) Complete them to get more!`
                : `${tasksToAssign.length} tasks assigned. Complete them to unlock the next batch!`,
              userLevel: userLevel,
              isProUser: isProUser,
            }),
          );

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
            let payOut = 0;

            try {
              if (activeTaskTimers.has(key)) {
                timer = activeTaskTimers.get(key);
                clearInterval(timer.intervalId);
              }

              const language = "en-US";

              const checkText = async (text) => {
                try {
                  const formData = new URLSearchParams();
                  formData.append("text", text);
                  formData.append("language", language);

                  const res = await fetch(
                    "https://api.languagetool.org/v2/check",
                    {
                      method: "POST",
                      body: formData,
                    },
                  );

                  // ✅ Check if response is OK
                  if (!res.ok) {
                    console.error(
                      `LanguageTool API error: ${res.status} ${res.statusText}`,
                    );
                    return 0; // Return 0 errors as fallback
                  }

                  // ✅ Check content type before parsing JSON
                  const contentType = res.headers.get("content-type");
                  if (
                    !contentType ||
                    !contentType.includes("application/json")
                  ) {
                    const errorText = await res.text();
                    console.error(
                      "LanguageTool returned non-JSON:",
                      errorText.substring(0, 200),
                    );
                    return 0; // Return 0 errors as fallback
                  }

                  const result = await res.json();
                  return (result.matches || []).length;
                } catch (error) {
                  console.error("checkText error:", error.message);
                  return 0; // Graceful fallback
                }
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
                  const fullPay = parseFloat(taskSnap.data().pay, 10) || 0;
                  payOut = Math.round(fullPay * payPercent * 100) / 100; // ✅ Rounds to 2 decimals

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
                    fullPay, // Store original amount
                    payOut, // Store what they actually got
                    payPercent, // Store percentage
                  });

                  tx.update(userRef, {
                    accountBalance:
                      Math.round((currentBalance + payOut) * 100) / 100,
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

              const monthNames = [
                "Jan",
                "Feb",
                "Mar",
                "Apr",
                "May",
                "Jun",
                "Jul",
                "Aug",
                "Sep",
                "Oct",
                "Nov",
                "Dec",
              ];
              const currentMonth = monthNames[new Date().getMonth()];
              const currentYear = new Date().getFullYear();
              const statsRef = firestore
                .collection("Users")
                .doc(data.uid)
                .collection("taskStats")
                .doc(`${currentYear}_${currentMonth}`);

              await firestore.runTransaction(async (tx) => {
                const statsSnap = await tx.get(statsRef);

                if (statsSnap.exists) {
                  tx.update(statsRef, {
                    tasksCompleted: admin.firestore.FieldValue.increment(1),
                    totalEarnings: admin.firestore.FieldValue.increment(payOut),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                } else {
                  tx.set(statsRef, {
                    month: currentMonth,
                    year: currentYear,
                    tasksRequested: 0,
                    tasksCompleted: 1,
                    totalEarnings: payOut,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
                        payOut, // ✅ USE payOut (not cash)
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
                          error:
                            "System warming up, try again in a few seconds",
                        }),
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
              const reference = data.textotranslate;
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

                if (aiScore >= 70) {
                  const payPercent = aiScore / 100;
                  const fullPay = parseFloat(taskSnap.data().pay, 10) || 0;
                  payOut = Math.round(fullPay * payPercent * 100) / 100; // ✅ Rounds to 2 decimals
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
                    accountBalance:
                      Math.round((currentBalance + payOut) * 100) / 100,
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

              const monthNames = [
                "Jan",
                "Feb",
                "Mar",
                "Apr",
                "May",
                "Jun",
                "Jul",
                "Aug",
                "Sep",
                "Oct",
                "Nov",
                "Dec",
              ];
              const currentMonth = monthNames[new Date().getMonth()];
              const currentYear = new Date().getFullYear();
              const statsRef = firestore
                .collection("Users")
                .doc(data.uid)
                .collection("taskStats")
                .doc(`${currentYear}_${currentMonth}`);

              await firestore.runTransaction(async (tx) => {
                const statsSnap = await tx.get(statsRef);

                if (statsSnap.exists) {
                  tx.update(statsRef, {
                    tasksCompleted: admin.firestore.FieldValue.increment(1),
                    totalEarnings: admin.firestore.FieldValue.increment(payOut),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                } else {
                  tx.set(statsRef, {
                    month: currentMonth,
                    year: currentYear,
                    tasksRequested: 0,
                    tasksCompleted: 1,
                    totalEarnings: payOut,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              });

              const cooldownInfo = await checkAndSetCooldown(data.uid);

              if (timer?.sockets?.size) {
                timer.sockets.forEach((s) => {
                  s.send(
                    JSON.stringify({
                      type: "taskComplete",
                      taskId: data.taskId,
                      aiScore,
                      payOut, // ✅ USE payOut
                      rewarded,
                      status,
                      completeMethod: "Instant",
                      cooldown: cooldownInfo,
                    }),
                  );
                });
              }
              activeTaskTimers.delete(key);
            } catch (error) {
              console.error(
                "Error processing translation task:",
                error.message,
              );

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

                if (aiScore >= 70) {
                  const payPercent = aiScore / 100;
                  const fullPay = parseFloat(taskSnap.data().pay, 10) || 0;
                  payOut = Math.round(fullPay * payPercent * 100) / 100; // ✅ Rounds to 2 decimals
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
                    accountBalance:
                      Math.round((currentBalance + payOut) * 100) / 100,
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

              const monthNames = [
                "Jan",
                "Feb",
                "Mar",
                "Apr",
                "May",
                "Jun",
                "Jul",
                "Aug",
                "Sep",
                "Oct",
                "Nov",
                "Dec",
              ];
              const currentMonth = monthNames[new Date().getMonth()];
              const currentYear = new Date().getFullYear();
              const statsRef = firestore
                .collection("Users")
                .doc(data.uid)
                .collection("taskStats")
                .doc(`${currentYear}_${currentMonth}`);

              await firestore.runTransaction(async (tx) => {
                const statsSnap = await tx.get(statsRef);

                if (statsSnap.exists) {
                  tx.update(statsRef, {
                    tasksCompleted: admin.firestore.FieldValue.increment(1),
                    totalEarnings: admin.firestore.FieldValue.increment(payOut),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                } else {
                  tx.set(statsRef, {
                    month: currentMonth,
                    year: currentYear,
                    tasksRequested: 0,
                    tasksCompleted: 1,
                    totalEarnings: payOut,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              });

              const cooldownInfo = await checkAndSetCooldown(data.uid);

              if (timer?.sockets?.size) {
                timer.sockets.forEach((s) => {
                  s.send(
                    JSON.stringify({
                      type: "taskComplete",
                      taskId: data.taskId,
                      aiScore,
                      payOut, // ✅ USE payOut
                      rewarded,
                      status,
                      completeMethod: "Instant",
                      cooldown: cooldownInfo,
                    }),
                  );
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

              ws.send(
                JSON.stringify({
                  type: "screeningTimerUpdate",
                  remainingTime: remaining,
                }),
              );
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
                  s.send(
                    JSON.stringify({
                      type: "screeningTimerUpdate",
                      remainingTime: remaining,
                    }),
                  );
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

            ws.send(
              JSON.stringify({
                type: "screeningTimerStarted",
                remainingTime: durationScreen,
              }),
            );
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
              screeningCompletedAt:
                admin.firestore.FieldValue.serverTimestamp(),
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

            ws.send(
              JSON.stringify({
                type: "screeningCompleteConfirm",
                success: true,
              }),
            );

            console.log(
              `Screening complete for ${data.userId}: ${data.score}/${data.totalQuestions} (${data.passed ? "PASS" : "FAIL"})`,
            );
          } catch (error) {
            console.error("Error saving screening results:", error);
            ws.send(
              JSON.stringify({
                type: "screeningCompleteError",
                error: error.message,
              }),
            );
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
  if (!adminUIDS.includes(uid)) {
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
  if (!adminUIDS.includes(uid)) {
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
  const { jobCat, jobName, jobReq, jobDesc, jobPay, uid } = req.body;
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
      jobminiTtile: jobCat,
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
    const { amount, withdrawMethod, bankDetails, cryptoDetails, userEmail, name } = req.body;

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

    const withdrawreference = `wd_${uid}_${Date.now()}`;

    // 🔧 FIX: Create document with CUSTOM ID instead of auto-generated ID
    // Use withdrawreference as the document ID for WithdrawRequests
    const withdrawalRef = firestore.collection("WithdrawRequests").doc(withdrawreference);
    
    // 📝 8. Create withdrawal request with CUSTOM ID
    await withdrawalRef.set({
      uid,
      name: userData.name, // ✅ always from DB
      amount: withdrawAmount,
      status: "pending",
      withdrawMethod,
      email: userEmail,
      bankDetails,
      cryptoDetails,
      withdrawreference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create transaction document with the SAME ID (withdrawreference)
    const transactionRef = firestore
      .collection("Users")
      .doc(uid)
      .collection("transactions")
      .doc(withdrawreference); // ✅ Same ID as withdrawal request

    await transactionRef.set({
      amountUSD: withdrawAmount, // Changed from 'amount' to 'amountUSD' to match process-withdrawal
      amountKES: withdrawAmount * 125, // Add this for consistency
      exchangeRate: 125, // Add exchange rate
      bankDetails,
      cryptoDetails,
      withdrawMethod,
      type: "withdrawal",
      status: "pending",
      currency: "USD", // Add currency field
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 🕒 9. Update cooldown timestamp
    await userRef.update({
      lastWithdrawAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // send email (your existing email code)
    const emailUser = userEmail;
    const subject = "Withdrawal Request Submitted - Solara Jobs";
    const body =
    ` <!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withdrawal Request Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden;">
          
          <!-- Header with Image Logo -->
          <tr>
            <td style="padding: 32px 40px 24px; text-align: center; background: linear-gradient(135deg, #0d0a22 0%, #1a0e69 100%);">
              <img src="https://solara-ver2.web.app/static/media/favIcon.8db8a902a3252e8211b5.png" alt="Solara Jobs" style="height: 50px; width: auto; max-width: 200px;">
              <div style="font-size: 20px; color: #ffffff; margin-top: 10px; letter-spacing: -1px;">Solara Jobs</div>
             </td>
           </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px;">
              
              <!-- Greeting -->
              <h2 style="margin: 0 0 8px; font-size: 24px; color: #5a00c0;">Hello ${name},</h2>
              <p style="margin: 0 0 24px; color: #555555; font-size: 16px; line-height: 1.5;">We have received your withdrawal request and it is now being processed.</p>
              
              <!-- Withdrawal Amount -->
              <div style="background-color: #f3f4f6; padding: 20px; margin-bottom: 24px; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280; font-weight: 500;">WITHDRAWAL AMOUNT</p>
                <p style="margin: 0; font-size: 36px; font-weight: bold; color: #5a00c0;">$${amount}</p>
                <p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">USD - United States Dollar</p>
              </div>
              
              <!-- Status Badge -->
              <div style=" padding: 16px 00px; margin-bottom: 24px; border-radius: 0px;">
                <p style="margin: 0; color: #166534; font-weight: 500;">Request Status: <strong>Pending</strong></p>
              </div>
              
              <!-- Important Notice -->
              <div style="background-color: #fff7ed; padding: 20px; margin-bottom: 24px; border-radius: 0px;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #9a3412;">Important: Disbursement Schedule</p>
                <p style="margin: 0; color: #431407; font-size: 14px; line-height: 1.5;">
                  All withdrawal requests are processed and disbursed on <strong style="color: #ea580c;">Tuesdays</strong>. 
                  Please ensure your request is submitted before Tuesday to be included in the upcoming disbursement.
                </p>
              </div>
              
              <!-- What to Expect -->
              <div style="margin-bottom: 24px;">
                <p style="font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">What happens next?</p>
                <ul style="margin: 0; padding-left: 20px; color: #555555; line-height: 1.6;">
                  <li style="margin-bottom: 8px;">Our finance team will review your request within 24-48 hours</li>
                  <li style="margin-bottom: 8px;">Funds will be disbursed on the upcoming Tuesday</li>
                  <li style="margin-bottom: 8px;">You will receive a confirmation email once the transfer is initiated</li>
                  <li style="margin-bottom: 8px;">Processing may take 1-3 business days depending on your selected payment method.</li>
                </ul>
              </div>
              
              <!-- Contact Support -->
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #1e293b;">Need assistance?</p>
                <p style="margin: 0; color: #64748b; font-size: 14px;">
                  Contact our support team at <a href="mailto:support@solarajobs.com" style="color: #5a00c0; text-decoration: none;">support@solarajobs.com</a>
                </p>
              </div>
              
              <!-- Thank You -->
              <p style="margin: 24px 0 0; color: #555555; text-align: center; font-size: 14px;">
                Thank you for choosing Solara Jobs.<br>
                We appreciate your trust in us.
              </p>
              
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 12px; font-size: 12px; color: #6c757d;">
                Solara Jobs | Professional Workforce Solutions
              </p>
              <p style="margin: 0; font-size: 11px; color: #adb5bd;">
                This is an automated message, please do not reply directly to this email.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;; // Your existing email HTML
    
    sendEmail(emailUser, subject, body);

    // ✅ Success
    return res.status(200).json({
      status: 200,
      msg: "Withdrawal request submitted",
      withdrawalId: withdrawreference, // Return the ID to frontend
    });
  } catch (error) {
    console.error("Withdraw error:", error);
    return res.status(500).json({
      status: 500,
      msg: "Server error",
    });
  }
});
// buy tokens - Add upload.none() middleware
app.post("/payNow", upload.none(), async (req, res) => {
  const { uid, payEmail, name, amount } = req.body;

  // ✅ Validate required fields
  if (!uid || !payEmail || !name || !amount) {
    return res.status(400).json({
      error: "Missing required fields: uid, payEmail, name, amount",
    });
  }

  // ✅ Validate amount
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 5 || numAmount > 500) {
    return res.status(400).json({
      error: "Amount must be between $5 and $500 USD",
    });
  }

  // ✅ Calculate tokens (6 tokens per $1)
  const TOKEN_RATE = 6;
  const tokensToAdd = Math.round(numAmount * TOKEN_RATE);

  // ✅ Store purchase info in Firestore
  const purchaseRef = firestore.collection("TokenPurchases").doc();
  await purchaseRef.set({
    uid,
    email: payEmail,
    name,
    amount: numAmount,
    tokens: tokensToAdd,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const params = JSON.stringify({
    email: payEmail,
    amount: numAmount * 100,
    currency: "USD",
    channels: ["card"],
    callback_url: `${process.env.FRONTEND_URL}/confirmpayment`,
    metadata: {
      uid: uid,
      purchaseId: purchaseRef.id,
      tokens: tokensToAdd,
      amount: numAmount,
    },
  });

  const options = {
    hostname: "api.paystack.co",
    port: 443,
    path: "/transaction/initialize",
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  };

  const payStackreq = https
    .request(options, (payStackres) => {
      let data = "";

      payStackres.on("data", (chunk) => {
        data += chunk;
      });

      payStackres.on("end", () => {
        try {
          const payStackRespData = JSON.parse(data);
          console.log(payStackRespData);

          if (payStackRespData.status && payStackRespData.data?.reference) {
            purchaseRef.update({
              reference: payStackRespData.data.reference,
              paystackData: payStackRespData.data,
            });
          }

          res.json(payStackRespData);
        } catch (error) {
          console.error("Parse error:", error);
          res
            .status(500)
            .json({ error: "Invalid response from payment provider" });
        }
      });
    })
    .on("error", (error) => {
      console.error("Request error:", error);
      res.status(500).json({ error: "Payment initialization failed" });
    });

  payStackreq.write(params);
  payStackreq.end();
});
// Verify webhook signature (function definition only - NO CALL)
const verifyPaystackSignature = (req) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers["x-paystack-signature"];

  console.log("Signature received:", signature);
  console.log("Secret key (first 10 chars):", secret?.substring(0, 10));

  if (!signature) {
    console.log("❌ No signature header");
    return false;
  }

  const rawBody = req.body.toString();
  const hash = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  return hash === signature;
};

// ✅ Webhook route - THIS is where the function should be called
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // Verify signature - passing req object here
    if (!verifyPaystackSignature(req)) {
      console.log("Invalid webhook signature");
      return res.status(401).send("Unauthorized");
    }

    const event = req.body;
    console.log("Webhook received:", event.event);

    // Handle successful payment
    if (event.event === "charge.success") {
      const { reference, metadata } = event.data;

      try {
        const purchaseQuery = await firestore
          .collection("TokenPurchases")
          .where("reference", "==", reference)
          .limit(1)
          .get();

        if (purchaseQuery.empty) {
          console.log("Purchase not found for reference:", reference);
          return res.sendStatus(200);
        }

        const purchaseDoc = purchaseQuery.docs[0];
        const purchase = purchaseDoc.data();

        if (purchase.status === "completed") {
          console.log("Purchase already processed:", reference);
          return res.sendStatus(200);
        }

        await purchaseDoc.ref.update({
          status: "completed",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paystackData: event.data,
        });

        const userRef = firestore.collection("Users").doc(purchase.uid);
        await userRef.update({
          solaraTokens: admin.firestore.FieldValue.increment(purchase.tokens),
        });
      } catch (error) {
        console.error("Webhook processing error:", error);
      }
    }

    res.sendStatus(200);
  },
);

// ✅ VERIFY PAYMENT - Accept FormData (with multer)
app.post("/verify-payment", upload.none(), async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: "Reference is required" });
  }

  try {
    // Check if already processed
    const purchaseQuery = await firestore
      .collection("TokenPurchases")
      .where("reference", "==", reference)
      .limit(1)
      .get();

    if (!purchaseQuery.empty) {
      const purchase = purchaseQuery.docs[0].data();

      if (purchase.status === "completed") {
        console.log("✅ Payment already verified:", reference);
        return res.json({
          status: "success",
          message: "Payment already verified",
          tokens: purchase.tokens,
        });
      }
    }

    // Verify with Paystack API
    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: `/transaction/verify/${reference}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    };

    const paystackRes = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.end();
    });

    console.log("Paystack response status:", paystackRes.status);

    if (paystackRes.status && paystackRes.data.status === "success") {
      const { metadata, amount } = paystackRes.data;

      // ✅ FIX: Ensure tokensToAdd is a valid number
      let tokensToAdd = metadata?.tokens || Math.round((amount / 100) * 6);

      // Validate tokensToAdd
      if (
        isNaN(tokensToAdd) ||
        tokensToAdd === undefined ||
        tokensToAdd === null
      ) {
        console.error("Invalid tokensToAdd:", tokensToAdd);
        tokensToAdd = 0;
      }

      // Ensure it's a number and round it
      tokensToAdd = Number(tokensToAdd);
      tokensToAdd = Math.round(tokensToAdd);

      if (purchaseQuery.empty) {
        // Create purchase record
        await firestore
          .collection("TokenPurchases")
          .doc()
          .set({
            uid: metadata?.uid,
            reference: reference,
            amount: amount / 100,
            tokens: tokensToAdd,
            status: "completed",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      } else {
        await purchaseQuery.docs[0].ref.update({
          status: "completed",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // ✅ FIX: Only increment if tokensToAdd > 0
      if (tokensToAdd > 0 && metadata?.uid) {
        const userRef = firestore.collection("Users").doc(metadata?.uid);
        await userRef.update({
          solaraTokens: admin.firestore.FieldValue.increment(tokensToAdd),
        });
      } else {
        console.log("⚠️ No tokens to add or missing UID");
      }

      return res.json({
        status: "success",
        tokens: tokensToAdd,
      });
    }

    res.json({ status: "pending", message: "Payment not yet verified" });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Verification failed: " + error.message });
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.post("/extractIDdata", async (req, res) => {
  const { base64ID } = req.body;

  if (!base64ID) {
    return res.status(400).json({ error: "Missing image data" });
  }

  // ✅ Remove any data:image/... prefix if present
  const cleanBase64 = base64ID.replace(/^data:image\/\w+;base64,/, "");

  const options = {
    method: "POST",
    url: "https://id-document-recognition2.p.rapidapi.com/api/iddoc_base64",
    headers: {
      "x-rapidapi-key": "5143db4c77msh2c63df3a0683cc7p194ebfjsn474a41def10e",
      "x-rapidapi-host": "id-document-recognition2.p.rapidapi.com",
      "Content-Type": "application/json", // ✅ Critical fix
    },
    data: {
      image: cleanBase64, // Try without the data URL prefix
    },
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error(
      "ID extraction error:",
      error.response?.data || error.message,
    );
    res.status(500).json({
      error: error.message,
      details: error.response?.data,
    });
  }
});
app.post("/compareFaces", async (req, res) => {
  // Try both possible field names
  const base64selfie = req.body.base64selfie;
  const base64ID =
    req.body.base64ID || req.body.idImage || req.body.documentImage;

  console.log("Compare faces - Request body keys:", Object.keys(req.body));

  if (!base64selfie || !base64ID) {
    return res.status(400).json({
      error: "Missing images",
      selfieProvided: !!base64selfie,
      idProvided: !!base64ID,
    });
  }

  const options = {
    method: "POST",
    url: "https://face-recognition26.p.rapidapi.com/api/face_compare_base64",
    headers: {
      "x-rapidapi-key": "5143db4c77msh2c63df3a0683cc7p194ebfjsn474a41def10e",
      "x-rapidapi-host": "face-recognition26.p.rapidapi.com",
      "Content-Type": "application/json",
    },
    data: {
      image1: base64selfie,
      image2: base64ID,
    },
  };

  try {
    const response = await axios.request(options);
    console.log("Face comparison successful");
    res.json(response.data);
  } catch (error) {
    console.error("Face comparison error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Apply for job endpoint
app.post("/apply-job", upload.single("cv"), async (req, res) => {
  const { jobId, userId } = req.body;
  const cvFile = req.file;

  // Validate required fields
  if (!jobId) {
    return res.status(400).json({
      status: "error",
      message: "Job ID is required",
    });
  }

  if (!userId) {
    return res.status(400).json({
      status: "error",
      message: "User ID is required",
    });
  }

  if (!cvFile) {
    return res.status(400).json({
      status: "error",
      message: "CV file is required",
    });
  }

  // Validate file type
  const validTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (!validTypes.includes(cvFile.mimetype)) {
    return res.status(400).json({
      status: "error",
      message: "Please upload a PDF or DOCX file",
    });
  }

  // Validate file size (max 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (cvFile.size > maxSize) {
    return res.status(400).json({
      status: "error",
      message: "File size must be less than 5MB",
    });
  }

  try {
    // Get user details from Firestore
    const userRef = firestore.collection("Users").doc(userId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    const userData = userSnap.data();
    const userEmail = userData.em || userData.email;
    const userName = userData.name || "User";
    const currentTokens = userData.solaraTokens || 0;

    // ✅ Check if user has enough tokens
    if (currentTokens < 10) {
      return res.status(400).json({
        status: "error",
        message:
          "Insufficient tokens. You need 10 Solara tokens to apply for this job.",
      });
    }

    // Get job details (optional - if you have a jobs collection)
    let jobTitle = "the position";
    try {
      const jobRef = firestore.collection("Jobs").doc(jobId);
      const jobSnap = await jobRef.get();
      if (jobSnap.exists) {
        jobTitle =
          jobSnap.data().title || jobSnap.data().jobName || "the position";
      }
    } catch (err) {
      console.log("Could not fetch job details:", err.message);
    }

    // ✅ Run transaction to deduct tokens and save application
    const applicationId = firestore.collection("JobApplications").doc().id;
    const applicationRef = firestore
      .collection("JobApplications")
      .doc(applicationId);

    await firestore.runTransaction(async (transaction) => {
      // Get fresh user data within transaction
      const freshUserSnap = await transaction.get(userRef);
      const freshUserData = freshUserSnap.data();
      const freshTokens = freshUserData.solaraTokens || 0;

      // Double-check token balance within transaction
      if (freshTokens < 10) {
        throw new Error("Insufficient tokens");
      }

      // Deduct 10 tokens
      transaction.update(userRef, {
        solaraTokens: freshTokens - 10,
      });

      // Save application record
      transaction.set(applicationRef, {
        id: applicationId,
        jobId: jobId,
        userId: userId,
        userName: userName,
        userEmail: userEmail,
        cvFileName: cvFile.originalname,
        cvSize: cvFile.size,
        cvType: cvFile.mimetype,
        tokensDeducted: 10,
        status: "pending",
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });



    const emailUser = userEmail;
    const subject = "Job Application Received - Solara Jobs";
    const body =`
    <!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Job Application Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden;">
          
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 32px 40px 24px; text-align: center; background: linear-gradient(135deg, #0d0a22 0%, #1a0e69 100%);">
              <img src="https://solara-ver2.web.app/static/media/favIcon.8db8a902a3252e8211b5.png" alt="Solara Jobs" style="height: 50px; width: auto; max-width: 200px;">
              <div style="font-size: 20px; color: #ffffff; margin-top: 10px; letter-spacing: -1px;">Solara Jobs</div>
             </td>
           </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px;">
              
              <!-- Success Badge -->
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="background-color: #22c55e; width: 60px; height: 60px; border-radius: 50%; display: inline-block; line-height: 60px; text-align: center;">
                  <span style="color: white; font-size: 32px;">✓</span>
                </div>
              </div>
              
              <!-- Greeting -->
              <h2 style="margin: 0 0 8px; font-size: 24px; color: #5a00c0; text-align: center;">Application Received!</h2>
              <p style="margin: 0 0 8px; color: #555555; font-size: 16px; line-height: 1.5; text-align: center;">
                Hello <strong>${userName}</strong>,
              </p>
              <p style="margin: 0 0 24px; color: #555555; font-size: 16px; line-height: 1.5; text-align: center;">
                Thank you for applying for the position at Solara Jobs.
              </p>
              
              <!-- Job Details Card -->
              <div style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 24px; margin-bottom: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <p style="margin: 0 0 12px; font-size: 14px; color: #5a00c0; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Job Applied For</p>
                <h3 style="margin: 0 0 8px; font-size: 22px; color: #1e293b;">${jobTitle}</h3>
              </div>
              
              <!-- What Happens Next -->
              <div style="margin-bottom: 24px;">
                <p style="font-weight: 600; color: #1a1a1a; margin-bottom: 16px; font-size: 18px;">What happens next?</p>
                
                <div style="margin-bottom: 20px;">
                  <div style="display: flex; margin-bottom: 16px;">
                    <div style="background-color: #5a00c0; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;">
                      <span style="color: white; font-size: 14px; font-weight: bold;">1</span>
                    </div>
                    <div>
                      <p style="margin: 0 0 4px; font-weight: 600; color: #1e293b;">Application Review</p>
                      <p style="margin: 0; color: #64748b; font-size: 14px;">Our hiring team will review your application and qualifications</p>
                    </div>
                  </div>
                  
                  <div style="display: flex; margin-bottom: 16px;">
                    <div style="background-color: #5a00c0; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;">
                      <span style="color: white; font-size: 14px; font-weight: bold;">2</span>
                    </div>
                    <div>
                      <p style="margin: 0 0 4px; font-weight: 600; color: #1e293b;">Contact If Shortlisted</p>
                      <p style="margin: 0; color: #64748b; font-size: 14px;">You will be contacted directly if your profile matches our requirements</p>
                    </div>
                  </div>
                  
                  <div style="display: flex; margin-bottom: 16px;">
                    <div style="background-color: #5a00c0; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;">
                      <span style="color: white; font-size: 14px; font-weight: bold;">3</span>
                    </div>
                    <div>
                      <p style="margin: 0 0 4px; font-weight: 600; color: #1e293b;">Interview Process</p>
                      <p style="margin: 0; color: #64748b; font-size: 14px;">Selected candidates will go through our interview process</p>
                    </div>
                  </div>
                </div>
              </div>
              
            
              
              <!-- Quick Tips -->
              <div style="background-color: #f0fdf4; padding: 20px; margin-bottom: 24px; border-radius: 0px; border-left: 4px solid #22c55e;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #166534;"> Quick Tips</p>
                <ul style="margin: 0; padding-left: 20px; color: #14532d; font-size: 14px; line-height: 1.6;">
                  <li style="margin-bottom: 6px;">Complete your profile to increase visibility to employers</li>
                  <li style="margin-bottom: 6px;">Upload an updated resume for better opportunities</li>
                  <li style="margin-bottom: 6px;">Keep your contact information current</li>
                  <li>Check your email regularly for interview invitations</li>
                </ul>
              </div>
              
              <!-- Contact Support -->
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #1e293b;">Have questions about your application?</p>
                <p style="margin: 0; color: #64748b; font-size: 14px;">
                  Contact our support team at <a href="mailto:support@solarajobs.com" style="color: #5a00c0; text-decoration: none;">support@solarajobs.com</a>
                </p>
              </div>
              
              <!-- Thank You -->
              <p style="margin: 24px 0 0; color: #555555; text-align: center; font-size: 14px;">
                Best regards,<br>
                <strong>Solara Jobs Recruitment Team</strong>
              </p>
              <p style="margin: 8px 0 0; color: #94a3b8; text-align: center; font-size: 12px;">
                Connecting Talent with Opportunity
              </p>
              
             </td>
           </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 12px; font-size: 12px; color: #6c757d;">
                Solara Jobs | Professional Workforce Solutions
              </p>
              <p style="margin: 0; font-size: 11px; color: #adb5bd;">
                This is an automated message, please do not reply directly to this email.
              </p>
             </td>
           </tr>
          
        </table>
       </td>
     </tr>
   </table>
</body>
</html>
  `;

    sendEmail(emailUser,subject,body)

    // Return success response
    return res.json({
      status: "success",
      message:
        "Your application has been submitted successfully. 10 Solara tokens have been deducted. You will receive a response via email within 3-5 business days.",
      data: {
        applicationId: applicationId,
        jobId: jobId,
        appliedAt: new Date().toISOString(),
        status: "pending",
        tokensRemaining: userData.solaraTokens - 10,
      },
    });
  } catch (error) {
    console.error("Application error:", error);

    if (error.message === "Insufficient tokens") {
      return res.status(400).json({
        status: "error",
        message:
          "Insufficient tokens. You need 10 Solara tokens to apply for this job.",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Something went wrong. Please try again later.",
    });
  }
});

// Helper function to make Paystack request
function makePaystackRequest(options, params) {
  return new Promise((resolve, reject) => {
    if (!params || typeof params !== "string") {
      reject(new Error("Invalid params"));
      return;
    }

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        if (chunk) data += chunk;
      });
      res.on("end", () => {
        try {
          const parsedData = data ? JSON.parse(data) : {};
          resolve(parsedData);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(params);
    req.end();
  });
}

// Function to create transfer recipient
function createTransferRecipient(accountNumber, bankCode, accountName) {
  return new Promise((resolve, reject) => {
    const params = JSON.stringify({
      type: "bank_account",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "KES",
    });

    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: "/transferrecipient",
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    };

    makePaystackRequest(options, params)
      .then((response) => {
        if (response.status) {
          resolve(response.data.recipient_code);
        } else {
          reject(new Error(response.message));
        }
      })
      .catch(reject);
  });
}

// Function to initiate transfer
function initiateTransfer(amount, recipientCode, reference, reason) {
  console.log("this is the amount in initate transfer" +" "+amount)
  return new Promise((resolve, reject) => {
    const params = JSON.stringify({
      source: "balance",
      reason: reason,
      amount: amount * 125,
      recipient: recipientCode,
      reference: reference,
      currency: "KES",
    });

    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: "/transfer",
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    };

    makePaystackRequest(options, params)
      .then((response) => {
        if (response.status) {
          resolve(response);
        } else {
          reject(new Error(response.message));
        }
      })
      .catch(reject);
  });
}

// ENDPOINT: Process withdrawal
app.post("/process-withdrawal", async (req, res) => {
  try {
    const {
      withdrawalId,
      withdrawreference,
      amount,
      bankDetails,
      withdrawMethod,
      uid,
      name,
      email,
      adminName,
    } = req.body;

    console.log("this is the amount from front end"+" " + amount)

    // Validate required fields
    if (!withdrawalId || !amount || !bankDetails || !uid) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Update Firebase: Mark as processing
    const withdrawalRef = firestore
      .collection("WithdrawRequests")
      .doc(withdrawalId);
    await withdrawalRef.update({
      status: "processing",
      processedAt: new Date().toISOString(),
      processedBy: adminName,
      processingStartedAt: serverTimestamp(),
    });

    // Step 1: Create transfer recipient
    const recipientCode = await createTransferRecipient(
      bankDetails.accountNumber,
      bankDetails.bankCode,
      bankDetails.accountName,
    );

   

    // Step 3: Initiate transfer
    const transfer = await initiateTransfer(
      amount,
      recipientCode,
            withdrawreference,
      `Withdrawal for ${name || uid}`,
    );

    // Calculate KES amount for records
    const amountInKES = amount * 125;

    // Step 4: Update withdrawal request with success
    await withdrawalRef.update({
      status: "completed",
      completedAt: new Date().toISOString(),
      transferCode: transfer.data.transfer_code,
      transferReference: transfer.data.reference,
      recipientCode: recipientCode,
      amountUSD: amount,
      amountKES: amountInKES,
      exchangeRate: 125,
      transferDetails: {
        amountUSD: amount,
        amountKES: amountInKES,
        status: transfer.data.status,
        initiatedAt: new Date().toISOString(),
      },
    });

 // Step 5: UPDATE existing transaction document
const transactionRef = firestore
  .collection("Users")
  .doc(uid)
  .collection("transactions")
  .doc(withdrawalId); // This will now match!

// Remove the if/else check and just update directly
await transactionRef.update({
  status: "completed",
  amountUSD: amount,
  amountKES: amountInKES,
  exchangeRate: 125,
  currency: "USD",
  type: "withdrawal",
  withdrawMethod: withdrawMethod,
  bankDetails: bankDetails,
  transferCode: transfer.data.transfer_code,
  transferReference: transfer.data.reference,
  processedBy: adminName,
  processedAt: new Date().toISOString(),
  updatedAt: serverTimestamp(),
});
    // Step 6: Update user's account balance (deduct the correct amount)
    const userRef = firestore.collection("Users").doc(uid);
    const userSnap = await userRef.get();

    if (userSnap.exists) {
      const currentBalance = userSnap.data().accountBalance || 0;
      // Deduct the USD amount directly (not divided by anything)
      const newBalance = currentBalance - amount;
      await userRef.update({
        accountBalance: newBalance,
        lastWithdrawalCompleted: new Date().toISOString(),
      });
      
      console.log(`Balance updated: $${currentBalance} USD -> $${newBalance} USD`);
    }

    // Send email notification
    const emailUser = email;
    const subject = "Withdrawal Request Approved - Solara Jobs";
    const body = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withdrawal Disbursement Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden;">
          
          <!-- Header with Image Logo -->
          <tr>
            <td style="padding: 32px 40px 24px; text-align: center; background: linear-gradient(135deg, #0d0a22 0%, #1a0e69 100%);">
              <img src="https://solara-ver2.web.app/static/media/favIcon.8db8a902a3252e8211b5.png" alt="Solara Jobs" style="height: 50px; width: auto; max-width: 200px;">
              <div style="font-size: 20px; color: #ffffff; margin-top: 10px; letter-spacing: -1px;">Solara Jobs</div>
              </td>
            </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px;">
              
              <!-- Greeting -->
              <h2 style="margin: 0 0 8px; font-size: 24px; color: #5a00c0;">Hi ${name},</h2>
              <p style="margin: 0 0 24px; color: #555555; font-size: 16px; line-height: 1.5;">Your withdrawal request has been successfully disbursed to your bank account.</p>
              
              <!-- Success Badge -->
              <div style="background-color: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px 20px; margin-bottom: 24px; border-radius: 0px;">
                <p style="margin: 0; color: #166534; font-weight: 500;">Transaction Status: <strong>Completed</strong></p>
              </div>
              
              <!-- Withdrawal Amount -->
              <div style="background-color: #f3f4f6; padding: 20px; margin-bottom: 24px; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280; font-weight: 500;">AMOUNT DISBURSED</p>
                <p style="margin: 0; font-size: 36px; font-weight: bold; color: #5a00c0;">$${amount} USD</p>
                <p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">≈ ${amountInKES.toLocaleString()} KES (Exchange rate: 1 USD = 125 KES)</p>
              </div>
              
              <!-- Bank Details -->
              <div style="background-color: #f8fafc; padding: 20px; margin-bottom: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <p style="margin: 0 0 16px; font-weight: 600; color: #1e293b; font-size: 16px;">Bank Account Details</p>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b; width: 140px;">Bank Name:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${bankDetails.bankName}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b;">Account Name:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${bankDetails.accountName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #64748b;">Account Number:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${bankDetails.accountNumber}</td>
                  </tr>
                </table>
              </div>
              
              <!-- Transaction Summary -->
              <div style="margin-bottom: 24px;">
                <p style="font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">Transaction Summary</p>
                <ul style="margin: 0; padding-left: 20px; color: #555555; line-height: 1.6;">
                  <li style="margin-bottom: 8px;">Funds have been transferred to your registered bank account</li>
                  <li style="margin-bottom: 8px;">Please allow 1-3 business days for the amount to reflect in your account</li>
                  <li style="margin-bottom: 8px;">A confirmation receipt has been sent to your registered email</li>
                  <li style="margin-bottom: 8px;">Check your bank statement for the credited amount in KES</li>
                </ul>
              </div>
              
              <!-- Need Help -->
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #1e293b;">Need assistance?</p>
                <p style="margin: 0; color: #64748b; font-size: 14px;">
                  If you don't receive the amount within 3 business days, contact our support team at <a href="mailto:support@solarajobs.com" style="color: #5a00c0; text-decoration: none;">support@solarajobs.com</a>
                </p>
              </div>
              
              <!-- Thank You -->
              <p style="margin: 24px 0 0; color: #555555; text-align: center; font-size: 14px;">
                Thank you for choosing Solara Jobs.<br>
                We appreciate your trust in us.
              </p>
              
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 12px; font-size: 12px; color: #6c757d;">
                Solara Jobs | Professional Workforce Solutions
              </p>
              <p style="margin: 0; font-size: 11px; color: #adb5bd;">
                This is an automated message, please do not reply directly to this email.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

    await sendEmail(emailUser, subject, body);

    res.status(200).json({
      success: true,
      message: "Transfer completed successfully",
      data: {
        transferCode: transfer.data.transfer_code,
        reference: transfer.data.reference,
        status: transfer.data.status,
        amountUSD: amount,
        amountKES: amountInKES,
        exchangeRate: 130,
      },
    });
  } catch (error) {
    console.error("Process withdrawal error:", error);

    // Update Firebase with failure
    try {
      const { withdrawalId, uid, amount } = req.body;

      if (withdrawalId) {
        const withdrawalRef = firestore
          .collection("WithdrawRequests")
          .doc(withdrawalId);
        await withdrawalRef.update({
          status: "failed",
          failedAt: new Date().toISOString(),
          failureReason: error.message,
          errorDetails: error.toString(),
        });
      }

      // Update existing transaction document with failure status
      if (uid && withdrawalId) {
        const transactionRef = firestore
          .collection("Users")
          .doc(uid)
          .collection("transactions")
          .doc(withdrawalId);
        
        const transactionDoc = await transactionRef.get();
        
        if (transactionDoc.exists) {
          await transactionRef.update({
            status: "failed",
            failureReason: error.message,
            failedAt: new Date().toISOString(),
            updatedAt: serverTimestamp(),
          });
        } else {
          // Create failed transaction record if doesn't exist
          await transactionRef.set({
            amountUSD: amount || 0,
            amountKES: amount ? amount * 130 : 0,
            exchangeRate: 130,
            currency: "USD",
            type: "withdrawal",
            status: "failed",
            withdrawMethod: req.body.withdrawMethod,
            bankDetails: req.body.bankDetails,
            failureReason: error.message,
            attemptedAt: new Date().toISOString(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
    } catch (dbError) {
      console.error("Failed to update error status:", dbError);
    }

    res.status(500).json({
      success: false,
      message: error.message || "Transfer failed",
    });
  }
});
// ENDPOINT: Reject withdrawal
// ENDPOINT: Reject withdrawal (UPDATES existing transaction)
app.post("/reject-withdrawal", async (req, res) => {
  try {
    const {
      withdrawalId,
      adminName,
      reason,
      uid,
      name,
      email,
      amount,
      withdrawMethod,
      bankDetails,
      cryptoDetails,
    } = req.body;

    if (!withdrawalId) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal ID is required",
      });
    }

    const withdrawalRef = firestore
      .collection("WithdrawRequests")
      .doc(withdrawalId);
    
    // Update withdrawal request status
    await withdrawalRef.update({
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      processedBy: adminName,
      rejectionReason: reason || "Rejected by admin",
      rejectedAtTimestamp: serverTimestamp(),
    });

    // UPDATE existing transaction record instead of creating new one
    if (uid) {
      const transactionsRef = firestore
        .collection("Users")
        .doc(uid)
        .collection("transactions");
      
      // Find the pending transaction for this withdrawal
      const snapshot = await transactionsRef
        .where("withdrawalId", "==", withdrawalId)
        .where("status", "==", "pending")
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        // Update existing transaction
        const transactionDoc = snapshot.docs[0];
        await transactionDoc.ref.update({
          status: "rejected",
          rejectionReason: reason || "Rejected by admin",
          rejectedBy: adminName,
          rejectedAt: new Date().toISOString(),
          updatedAt: serverTimestamp(),
        });
      } else {
        // If no pending transaction found (fallback), create one
        console.log("No pending transaction found for withdrawal:", withdrawalId);
        const transactionRef = firestore
          .collection("Users")
          .doc(uid)
          .collection("transactions")
          .doc();
        
        await transactionRef.set({
          amount: amount || 0,
          type: "withdrawal",
          status: "rejected",
          withdrawMethod: withdrawMethod || "Bank Transfer",
          bankDetails: bankDetails || {},
          cryptoDetails: cryptoDetails || {},
          withdrawalId: withdrawalId,
          rejectionReason: reason || "Rejected by admin",
          rejectedBy: adminName,
          rejectedAt: new Date().toISOString(),
          createdAt: serverTimestamp(),
        });
      }
    }

    // send email 
const emailUser = email;
const subject = "Withdrawal Request Update - Solara Jobs";
const body = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withdrawal Request Update</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden;">
          
          <!-- Header with Image Logo -->
          <tr>
            <td style="padding: 32px 40px 24px; text-align: center; background: linear-gradient(135deg, #0d0a22 0%, #1a0e69 100%);">
              <img src="https://solara-ver2.web.app/static/media/favIcon.8db8a902a3252e8211b5.png" alt="Solara Jobs" style="height: 50px; width: auto; max-width: 200px;">
              <div style="font-size: 20px; color: #ffffff; margin-top: 10px; letter-spacing: -1px;">Solara Jobs</div>
             </td>
           </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px;">
              
              <!-- Greeting -->
              <h2 style="margin: 0 0 8px; font-size: 24px; color: #5a00c0;">Hi ${name},</h2>
              <p style="margin: 0 0 24px; color: #555555; font-size: 16px; line-height: 1.5;">We regret to inform you that your withdrawal request could not be processed at this time.</p>
              
              <!-- Status Badge -->
              <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 16px 20px; margin-bottom: 24px; border-radius: 0px;">
                <p style="margin: 0; color: #991b1b; font-weight: 500;">Request Status: <strong>Declined</strong></p>
              </div>
              
              <!-- Withdrawal Details -->
              <div style="background-color: #f3f4f6; padding: 20px; margin-bottom: 24px; border-radius: 8px;">
                <p style="margin: 0 0 16px; font-weight: 600; color: #1e293b; font-size: 16px;">Withdrawal Details</p>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b; width: 140px;">Method:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${withdrawMethod}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b;">Amount:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">$${amount} USD</td>
                  </tr>
                </table>
              </div>
              
           
              
              <!-- What You Can Do -->
              <div style="margin-bottom: 24px;">
                <p style="font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">Next Steps</p>
                <ul style="margin: 0; padding-left: 20px; color: #555555; line-height: 1.6;">
                  <li style="margin-bottom: 8px;">Make the necessary adjustments or corrections</li>
                  <li style="margin-bottom: 8px;">Submit a new withdrawal request once resolved</li>
                  <li style="margin-bottom: 8px;">Contact support if you need clarification</li>
                </ul>
              </div>
              
              <!-- Need Help -->
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #1e293b;">Need assistance?</p>
                <p style="margin: 0; color: #64748b; font-size: 14px;">
                  Contact our support team at <a href="mailto:support@solarajobs.com" style="color: #5a00c0; text-decoration: none;">support@solarajobs.com</a>
                </p>
              </div>
              
              <!-- Thank You -->
              <p style="margin: 24px 0 0; color: #555555; text-align: center; font-size: 14px;">
                Thank you for understanding.<br>
                We appreciate your patience.
              </p>
              
            </td>
           </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 12px; font-size: 12px; color: #6c757d;">
                Solara Jobs | Professional Workforce Solutions
              </p>
              <p style="margin: 0; font-size: 11px; color: #adb5bd;">
                This is an automated message, please do not reply directly to this email.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </table>
  </table>
</body>
</html>
`;

sendEmail(emailUser, subject, body);



    res.status(200).json({
      success: true,
      message: "Withdrawal rejected successfully",
    });
  } catch (error) {
    console.error("Reject withdrawal error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to reject withdrawal",
    });
  }
});


// ENDPOINT: Process Crypto Withdrawal (Manual via Minisend)
app.post("/process-crypto-withdrawal", async (req, res) => {
  try {
    const {
      withdrawalId,
      amount,
      cryptoDetails,
      withdrawMethod,
      uid,
      name,
      email,
      adminName,
    } = req.body;

    // Validate required fields
    if (!withdrawalId || !amount || !cryptoDetails || !uid) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Get user reference
    const userRef = firestore.collection("Users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userData = userSnap.data();
    const currentBalance = userData.accountBalance || 0;

    // Check if user has sufficient balance
    if (currentBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      });
    }

    // Update withdrawal request status
    const withdrawalRef = firestore
      .collection("WithdrawRequests")
      .doc(withdrawalId);
    await withdrawalRef.update({
      status: "completed",
      completedAt: new Date().toISOString(),
      processedBy: adminName,
      processedAt: serverTimestamp(),
      cryptoDetails: {
        walletAddress: cryptoDetails.walletAddress,
        network: cryptoDetails.network,
        currency: cryptoDetails.currency || "USDT",
        note: "To be sent manually via Minisend",
      },
    });

    // Deduct amount from user's balance
    const newBalance = currentBalance - amount;
    await userRef.update({
      accountBalance: newBalance,
      lastCryptoWithdrawalAt: serverTimestamp(),
    });

    // Add transaction to user's transaction subcollection
    const transactionRef = firestore
      .collection("Users")
      .doc(uid)
      .collection("transactions")
      .doc();

    await transactionRef.set({
      amount: amount,
      type: "crypto_withdrawal",
      status: "completed",
      withdrawMethod: "Crypto Currency",
      cryptoDetails: {
        walletAddress: cryptoDetails.walletAddress,
        network: cryptoDetails.network,
        currency: cryptoDetails.currency || "USDT",
        note: "Processed manually via Minisend",
      },
      processedBy: adminName,
      balanceAfter: newBalance,
      balanceBefore: currentBalance,
      processedAt: new Date().toISOString(),
      createdAt: serverTimestamp(),
      withdrawalId: withdrawalId,
    });

         // send email 

// send email 
const emailUser = email;
const subject = "Withdrawal Request Approved - Solara Jobs (Crypto)";
const body = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crypto Withdrawal Disbursement Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden;">
          
          <!-- Header with Image Logo -->
          <tr>
            <td style="padding: 32px 40px 24px; text-align: center; background: linear-gradient(135deg, #0d0a22 0%, #1a0e69 100%);">
              <img src="https://solara-ver2.web.app/static/media/favIcon.8db8a902a3252e8211b5.png" alt="Solara Jobs" style="height: 50px; width: auto; max-width: 200px;">
              <div style="font-size: 20px; color: #ffffff; margin-top: 10px; letter-spacing: -1px;">Solara Jobs</div>
             </td>
           </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px;">
              
              <!-- Greeting -->
              <h2 style="margin: 0 0 8px; font-size: 24px; color: #5a00c0;">Hi ${name},</h2>
              <p style="margin: 0 0 24px; color: #555555; font-size: 16px; line-height: 1.5;">Your cryptocurrency withdrawal request has been successfully approved and processed.</p>
              
              <!-- Success Badge -->
              <div style="background-color: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px 20px; margin-bottom: 24px; border-radius: 0px;">
                <p style="margin: 0; color: #166534; font-weight: 500;">Transaction Status: <strong>Completed</strong></p>
              </div>
              
              <!-- Withdrawal Amount -->
              <div style="background-color: #f3f4f6; padding: 20px; margin-bottom: 24px; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280; font-weight: 500;">AMOUNT DISBURSED</p>
                <p style="margin: 0; font-size: 36px; font-weight: bold; color: #22c55e;">$${amount} USD</p>
                <p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">Converted at market rate</p>
              </div>
              
              <!-- Crypto Wallet Details -->
              <div style="background-color: #f8fafc; padding: 20px; margin-bottom: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <p style="margin: 0 0 16px; font-weight: 600; color: #1e293b; font-size: 16px;">Cryptocurrency Wallet Details</p>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b; width: 140px;">Network:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${cryptoDetails.network}</td>
                  </tr>
              
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; color: #64748b;">Wallet Address:</td>
                    <td style="padding: 8px 0; color: #1e293b; font-weight: 500; word-break: break-all;">${cryptoDetails.walletAddress}</td>
                  </tr>
                 
                </table>
              </div>
              
              
              <!-- Transaction Summary -->
              <div style="margin-bottom: 24px;">
                <p style="font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">Transaction Summary</p>
                <ul style="margin: 0; padding-left: 20px; color: #555555; line-height: 1.6;">
                  <li style="margin-bottom: 8px;">Funds have been sent to your registered crypto wallet address</li>
                  <li style="margin-bottom: 8px;">Blockchain confirmations may take 15-30 minutes depending on network traffic</li>
                  <li style="margin-bottom: 8px;">You can track the transaction using the transaction hash above</li>
                  <li style="margin-bottom: 8px;">A confirmation receipt has been sent to your registered email</li>
                </ul>
              </div>
              
              <!-- Need Help -->
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; font-weight: 600; color: #1e293b;">Need assistance?</p>
                <p style="margin: 0; color: #64748b; font-size: 14px;">
                  If you don't receive the crypto within 2 hours, contact our support team at <a href="mailto:support@solarajobs.com" style="color: #5a00c0; text-decoration: none;">support@solarajobs.com</a>
                </p>
              </div>
              
              <!-- Security Note -->
              <div style="background-color: #fef2f2; padding: 12px 16px; margin-bottom: 24px;">
                <p style="margin: 0; color: #991b1b; font-size: 12px;">
                  <strong>Security Note:</strong> Always verify wallet addresses before sending crypto. Solara Jobs will never ask you to send crypto to any address.
                </p>
              </div>
              
              <!-- Thank You -->
              <p style="margin: 24px 0 0; color: #555555; text-align: center; font-size: 14px;">
                Thank you for choosing Solara Jobs.<br>
                We appreciate your trust in us.
              </p>
              
             </td>
           </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 12px; font-size: 12px; color: #6c757d;">
                Solara Jobs | Professional Workforce Solutions
              </p>
              <p style="margin: 0; font-size: 11px; color: #adb5bd;">
                This is an automated message, please do not reply directly to this email.
              </p>
             </td>
           </td>
          
        </table>
       </td>
     </td>
   </table>
</body>
</html>
`;

sendEmail(emailUser, subject, body);

    res.status(200).json({
      success: true,
      message: "Crypto withdrawal completed successfully",
      data: {
        withdrawalId: withdrawalId,
        amount: amount,
        newBalance: newBalance,
        walletAddress: cryptoDetails.walletAddress,
        note: "Amount deducted from balance. Send crypto manually via Minisend.",
      },
    });
  } catch (error) {
    console.error("Process crypto withdrawal error:", error);

    // Update Firebase with failure
    try {
      const { withdrawalId, uid, amount } = req.body;

      if (withdrawalId) {
        const withdrawalRef = firestore
          .collection("WithdrawRequests")
          .doc(withdrawalId);
        await withdrawalRef.update({
          status: "failed",
          failedAt: new Date().toISOString(),
          failureReason: error.message,
          errorDetails: error.toString(),
        });
      }

      // Add failed transaction record
      if (uid) {
        const transactionRef = firestore
          .collection("Users")
          .doc(uid)
          .collection("transactions")
          .doc();

        await transactionRef.set({
          amount: req.body.amount || 0,
          type: "crypto_withdrawal",
          status: "failed",
          withdrawMethod: "Crypto Currency",
          failureReason: error.message,
          attemptedAt: new Date().toISOString(),
          createdAt: serverTimestamp(),
        });
      }
    } catch (dbError) {
      console.error("Failed to update error status:", dbError);
    }

    res.status(500).json({
      success: false,
      message: error.message || "Crypto withdrawal failed",
    });
  }
});

// ENDPOINT: Get transfer status
app.get("/transfer-status/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: `/transfer/verify/${reference}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    };

    const response = await makePaystackRequest(options, "");

    res.status(200).json({
      success: response.status,
      data: response.data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ENDPOINT: Get user transaction history
app.get("/user-transactions/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const { limit = 50 } = req.query;

    const transactionsRef = firestore
      .collection("Users")
      .doc(uid)
      .collection("transactions")
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit));

    const snapshot = await transactionsRef.get();

    const transactions = [];
    snapshot.forEach((doc) => {
      transactions.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.status(200).json({
      success: true,
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const transporter = nodemailer.createTransport({
  host: process.env.HAK,
  port: 465,
  secure: true,
  auth: {
    user: process.env.EM_USER,
    pass: process.env.EM_PASS,
  },
  tls: {
    servername: process.env.HAK,
  },
});


async function sendEmail( emailUser, subject, body) {
  
  try {
    /* ---- SEND TO BUSINESS ---- */
    await transporter.sendMail({
      from: `"Solara Jobs" <${process.env.EM_USER}>`,
      to: emailUser,
      subject: subject ,
      html: body,
    });

    console.log("✅ Email sent to user");


  } catch (error) {
    console.error("❌ Email error:", error);

   
  }
};


