require("dotenv").config();

const express = require("express");
const cors = require("cors");
const port = 3322;
const app = express();
const admin = require("firebase-admin");
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let userConnections = new Map(); // uid -> set of ws

// 1️⃣ GLOBAL TIMER REGISTRY
const activeTaskTimers = new Map();

// 2️⃣ TIMER FUNCTION (GOES HERE)
// key = `${userId}_${taskId}`, value = { intervalId, sockets: Set<WebSocket>, duration, startedAt }

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
          } catch (err){
            console.log(err)
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
      if (data.type === "init" && data.uid) {
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
              JSON.stringify({ type: "resumeError", reason: err.message }),
            );
          }
        }
      }
      if (data.type === "requestTask" && data.uid) {
        const userRef = firestore.collection("Users").doc(data.uid);
        const userSnap = await userRef.get();

        // ❌ User does not exist
        if (!userSnap.exists) {
          ws.send(
            JSON.stringify({
              type: "taskResponse",
              status: "Error",
              reason: "An error occured. Try again later.",
            }),
          );
          return;
        }

        const user = userSnap.data();

        // ❌ Not eligible
        if (!user.jobEligibility) {
          ws.send(
            JSON.stringify({
              type: "taskResponse",
              status: "Not Eligible",
              reason: "You are not eligible for tasks at the moment.",
            }),
          );
          return;
        }

        // ❌ Daily limit reached
        if (user.dailyTaskTaken >= 30) {
          ws.send(
            JSON.stringify({
              type: "taskResponse",
              status: "Limit Reached",
              reason: "Sorry, you've reached your daily task limit!",
            }),
          );
          return;
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
          return;
        }

        // ✅ USER IS ELIGIBLE → FETCH TASK
        const taskQuery = await firestore
          .collection("Ai-tasks")
          .where("status", "==", "active")
          .limit(4)
          .get();

        if (taskQuery.empty) {
          ws.send(
            JSON.stringify({
              type: "taskResponse",
              status: "No Tasks Available",
              reason: "Sorry, we have no tasks at the moment. Try again later.",
            }),
          );
          return;
        }

        let assignedTasks = [];
        const availableTasks = taskQuery.docs.map((doc) => ({
          taskId: doc.id,
          ...doc.data(),
        }));

        const tasksToAssign = availableTasks.slice(0, 4);

        await admin.firestore().runTransaction(async (tx) => {
          // update user once
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
              originaltext: task.originaltext,
              pay: task.pay,
              status: "Pending",
              type: task.type,
            });
          }
        });

        // // 📤 SEND TASK TO USER
        // ws.send(JSON.stringify({
        //   type: "taskAssigned",
        //   tasks: assignedTasks

        // }));
        async function saveTask() {
          const batch = firestore.batch();

          for (const task of assignedTasks) {
            const taskRef = firestore
              .collection("Users")
              .doc(data.uid)
              .collection("assignedTasks")
              .doc(task.taskId);
            batch.set(taskRef, {
              taskId: task.taskId,
              type: task.type,
              pay: task.pay,
              instructions: task.instructions,
              originaltext: task.originaltext,
              status: task.status,
              assignedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
          firestore.collection("Users").doc(data.uid).update({
            hasTasks: true,
          });
        }
        saveTask();
      }
      if (data.type === "startTask" && data.userId && data.taskId) {
        const duration = 300; // seconds

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
      }


      const key = `${data.uid}_${data.taskId}`;
let timer = null;

if (
  data.type === "submitTask" &&
  data.uid &&
  data.taskId &&
  data.originalText &&
  data.refinedText
) {
  try {
    if (activeTaskTimers.has(key)) {
      const timer = activeTaskTimers.get(key);
      clearInterval(timer.intervalId);
      activeTaskTimers.delete(key);
    }

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAIKEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-r1-0528:free",
          messages: [
            {
              role: "user",
              content: `
Check if the corrected statement is grammatically correct compared to the original and rate it on a scale of  0 t0 100

Original statement:
"${data.originalText}"

Corrected statement:
"${data.refinedText}"


Respond with ONLY a number between 0 and 100.
No symbols, no words.              `,
            },
          ],
        }),
      }
    );

    const result = await response.json();
    const taskResp = result?.choices?.[0]?.message?.content?.trim();

    if (isNaN(taskResp)) {
      throw new Error("Invalid AI response score");
    }

    const userRef = firestore.collection("Users").doc(data.uid);
    const taskRef = userRef.collection("assignedTasks").doc(data.taskId);

    let cash = 0;
    let rewarded = false;
    let status = "Failed";

    await firestore.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      const userSnap = await transaction.get(userRef);

      if (!taskSnap.exists || !userSnap.exists) return;

      const taskData = taskSnap.data();

      if (taskData.status === "Completed") return;

      if (taskResp >= 92) {
        cash = parseInt(taskData.pay) || 0;
        status = "Completed";
        rewarded = true;
        const currentBalance = userSnap.data().accountBalance || 0;

        transaction.update(taskRef, {
          aiScore: taskResp,
          reviewedAt: Date.now(),
          status: "Completed",
          rewarded: true,
        });

        transaction.update(userRef, {
          accountBalance: currentBalance + cash,
        });
      } else {
        transaction.update(taskRef, {
          aiScore: taskResp,
          reviewedAt: Date.now(),
          status: "Failed",
          rewarded: false,
        });
      }
    });

    if (timer?.sockets) {
      timer.sockets.forEach((s) => {
        s.send(
          JSON.stringify({
            type: "taskComplete",
            taskId: data.taskId,
            payOut: cash,
            rewarded,
            aiScore: taskResp,
            status: status,
          })
        );
      });
    }

  } catch (error) {
    console.error("Error checking grammar:", error);
    
    if (timer?.sockets) {
      timer.sockets.forEach((s) => {
        s.send(
          JSON.stringify({
            type: "taskError",
            taskId: data.taskId,
            error: "Processing failed",
          })
        );
      });
    }
  }
}

if (
  data.type === "cancelTask" &&
  data.uid &&
  data.taskId
) {
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
              })
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

    console.log(
      `Task ${data.taskId} canceled by user ${data.uid}`
    );

  } catch (err) {
    console.error("Cancel task failed:", err);

    ws.send(
      JSON.stringify({
        type: "cancelTaskError",
        msg: "Failed to cancel task. Try again.",
      })
    );
  }
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
const upload = multer({
  storage: multer.memoryStorage(),
});

app.post("/uploadAITask", upload.none(), async (req, res) => {
  const { taskType, content, uid, jobpay } = req.body;
  if (adminUIDS.includes(uid)) {
    const docRef = await firestore.collection("Ai-tasks").doc();
    docRef
      .set({
        taskId: docRef.id,
        assignCount: 0,
        type: taskType,
        instructions:
          "Fix grammar, spelling, and clarity. Do not change the meaning.",
        originaltext: content,
        pay: parseInt(jobpay),
        status: "active",
      })
      .then(() => {
        res.json({ msg: "AI task uploaded", status: 200 });
      })
      .catch(() => {
        res.json({ msg: "Error uploading task", status: 300 });
      });
  } else {
    return res.status(403).json({
      status: 403,
      msg: "You do not have access",
    });
  }
});

app.post("/Aloo", (req, res) => {
  res.json({ message: "Wozaaaa" });
});

server.listen(port, () => {
  console.log(`Hello Rodger you app is running on port ${port}`);
});

// timer function


