require("dotenv").config()

const express = require('express')
const cors = require("cors")
const port = 3322;
const app = express()
const admin = require("firebase-admin")
const {firestore, serverTimestamp, firebaseAuth} = require('./firebaseService');
const http = require("http")
const multer = require("multer");


app.use(cors({origin:"*"}))

app.get("/", (req,res)=>{
    res.send("Alloo we are live my bwooy!")

})


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

const server = http.createServer(app);
const wss = new WebSocket.Server([server]);

wss.on("connection", (ws)=>{
    console.log("theres a connection")
})
wss.on("close", (ws)=>{
    console.log("kuna connection imefungwa")
})

wss.on("error", (ws)=>{
    console.log("kuna error majamaaa")
})

app.post("/Aloo", (req,res)=>{
    res.json({message: "Wozaaaa"})
})


app.listen(port, ()=>{
    console.log(`Hello Rodger you app is running on port ${port}`)
})