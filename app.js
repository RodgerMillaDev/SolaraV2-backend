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

wss.on("connection", (ws) => {
    console.log("New connection");

    // Expect client to send uid immediately
    ws.on("message", (msg) => {
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