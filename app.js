require("dotenv").config()

const express = require('express')
const cors = require("cors")
const port = 3322;
const app = express()
const admin = require("firebase-admin")
const {firestore, serverTimestamp, firebaseAuth} = require('./firebaseService');
const http = require("http")
const multer = require("multer");
const WebSocket = require("ws")


app.use(cors({origin:"*"}))

app.get("/", (req,res)=>{
    res.send("Alloo we are live my bwooy!")

})

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let userConnections = new Map(); // uid -> set of ws

wss.on("connection",  (ws) => {
    console.log("New connection");

    // Expect client to send uid immediately
    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === "init" && data.uid) {
                ws.uid = data.uid;
                if (!userConnections.has(data.uid)) {
                    userConnections.set(data.uid, new Set());
                }
                userConnections.get(data.uid).add(ws);
                console.log(`User ${data.uid} connected, total devices: ${userConnections.get(data.uid).size}`);
            }
             if (data.type === "requestTask" && data.uid) {
              console.log("task request received")
        const userRef = firestore.collection("Users").doc(data.uid);
        const userSnap = await userRef.get();

        // ❌ User does not exist
        if (!userSnap.exists) {
          ws.send(JSON.stringify({
            type: "taskResponse",
            status: "error",
            reason: "An error occured. Try again later."
          }));
          return;
        }

        const user = userSnap.data();

        // ❌ Not eligible
        if (!user.jobEligibility) {
          ws.send(JSON.stringify({
            type: "taskResponse",
            status: "denied",
            reason: "You are not eligible for tasks at the moment."
          }));
          return;
        }

        // ❌ Daily limit reached
        if (user.dailyTaskTaken >= 20) {
          ws.send(JSON.stringify({
            type: "taskResponse",
            status: "denied",
            reason: "Sorry, you've reached your daily task limit!"
          }));
          return;
        }

        // ❌ Already working on a task
        if (user.taskID) {
          ws.send(JSON.stringify({
            type: "taskResponse",
            status: "denied",
            reason: "You have already been assigned an AI task."
          }));
          return;
        }

        // ✅ USER IS ELIGIBLE → FETCH TASK
        const taskQuery = await firestore
          .collection("Ai-tasks")
          .where("status", "==", "active")
          .limit(4)
          .get();

        if (taskQuery.empty) {
          ws.send(JSON.stringify({
            type: "taskResponse",
            status: "empty",
            reason: "No tasks available"
          }));
          return;
        }

        let assignedTasks = []
const availableTasks = taskQuery.docs.map(doc => ({
  taskId: doc.id,
  ...doc.data()
}));

const tasksToAssign = availableTasks.slice(0, 4);

await admin.firestore().runTransaction(async (tx) => {
  // update user once
  tx.update(userRef, {
    dailyTaskTaken: admin.firestore.FieldValue.increment(tasksToAssign.length)
  });

  for (const task of tasksToAssign) {
    const taskRef = firestore.collection("Ai-tasks").doc(task.taskId);

    tx.update(taskRef, {
      assignCount: admin.firestore.FieldValue.increment(1),
      assignedTo: data.uid
    });

    assignedTasks.push({
      taskId: task.taskId,
      instructions: task.instructions,
      originaltext: task.originaltext,
      pay: task.pay,
      status: "Pending",
      type: task.type
    });
  }
});


        // // 📤 SEND TASK TO USER
        // ws.send(JSON.stringify({
        //   type: "taskAssigned",
        //   tasks: assignedTasks
                
        // }));
        async function saveTask(){
           const batch = firestore.batch();

        for(const task of assignedTasks){
          const taskRef = firestore.collection("Users").doc(uid).collection("assignedTasks").doc(task.taskId)
          batch.set(taskRef,{
            taskId: task.taskId,
            type: task.type,
            pay: task.pay,
            instructions: task.instructions,
            originaltext: task.originaltext,
            status: task.status,
            assignedAt: admin.firestore.FieldValue.serverTimestamp(),
          })
        }
        await batch.commit()
        firestore.collection('User').doc(uid).update({
          hasTasks: true,
        })
        }
        saveTask()


       

     


      }else{
      console.log("invalid request received")

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

const adminUIDS = [process.env.ADMIN_ONE]

adminUIDS.forEach((uid)=>{
   admin.auth().setCustomUserClaims(uid, {admin: true}).then(()=>{
    console.log("Admin is set", uid)
   }).catch((err)=>{
    console.error("Admin authentication failed", err)
   })
})

// claims end
const upload = multer({
    storage: multer.memoryStorage()
})

app.post("/uploadAITask", upload.none(), async (req,res)=>{
    const {taskType,content,uid,jobpay} = req.body;
    if(adminUIDS.includes(uid)){
         const docRef = await firestore.collection("Ai-tasks").doc()
    docRef.set({
        taskId:docRef.id,
        assignCount:0,
        type:taskType,
        instructions:"Fix grammar, spelling, and clarity. Do not change the meaning.",
        originaltext:content,
        pay: parseInt(jobpay),
        status:"active",
    }).then(()=>{
        res.json({msg:"AI task uploaded", status:200})
    }).catch(()=>{
        res.json({msg:"Error uploading task", status:300})
    })
    }else{
      return res.status(403).json({
      status: 403,
      msg: "You do not have access"
    });  
  }
   
})


app.post("/Aloo", (req,res)=>{
    res.json({message: "Wozaaaa"})
})


server.listen(port, ()=>{
    console.log(`Hello Rodger you app is running on port ${port}`)
})



