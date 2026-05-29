import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import { GoogleGenAI, Type } from "@google/genai";
import { toolDeclarations } from "./tools"; // Ensure your patched tools.ts file matches this path

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Initialize the modern Google GenAI Client
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // Static baseline mock fleet (Simulated Corridor Cargo Links)
  const baselineMockFleet = [
    {
      id: "SIM-8821",
      headNumber: "G 43122",
      unitNumber: "EG 3104",
      locoType: "EG",
      length: 640,
      origin: "Maschen",
      destination: "Aarhus",
      status: "DELAYED",
      carrier: "DB Cargo Denmark",
      location: "Padborg, Denmark",
      lat: 54.8239,
      lng: 9.3562,
      description: "Freight Service - Northbound",
      delay: "00:45:00",
      speed: "82 km/h",
      vector: { lat: 0.0001, lng: 0.0002 }
    },
    {
      id: "SIM-5510",
      headNumber: "G 45010",
      unitNumber: "BR 185-300",
      locoType: "185",
      length: 620,
      origin: "Malmö",
      destination: "Trelleborg",
      status: "ON TIME",
      carrier: "DB Cargo Scandinavia",
      location: "Malmö, Sweden",
      lat: 55.6050,
      lng: 13.0038,
      description: "Scandinavian Link",
      delay: "00:00:00",
      speed: "75 km/h",
      vector: { lat: -0.0015, lng: -0.00005 }
    }
  ];

  // Global thread-safe internal state
  let simulatedFleet = [...baselineMockFleet];
  let liveFleet: any[] = [];
  
  // Explicit initialization of global scope variable for tools context
  globalThis.fleet = [];

  // ==========================================
  // UPDATED POLING METHOD START
  // ==========================================
  const fetchRealTimeFleet = async () => {
    try {
      const res = await axios.get(
        "https://services.arcgis.com/S8p9Z0vNps6vI6Kj/ArcGIS/rest/services/Live_togtrafik/FeatureServer/0/query", 
        {
          params: {
            where: "1=1",
            outFields: "OBJECTID,TrainNumber,Contractor,Origin,Destination,Status,Delay,Latitude,Longitude",
            outSR: "4326", 
            f: "json" 
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          },
          timeout: 8000
        }
      );

      if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
        throw new Error("ArcGIS returned HTML payload text structure.");
      }

      if (res.data && res.data.features) {
        liveFleet = res.data.features
          .filter((f: any) => f.attributes && f.attributes.Latitude && f.attributes.Longitude)
          .map((f: any) => {
            const attr = f.attributes;
            return {
              id: `LIVE-${attr.OBJECTID}`,
              headNumber: attr.TrainNumber || "UNKN",
              unitNumber: "N/A",
              locoType: "N/A",
              length: 0,
              origin: attr.Origin || "Unknown",
              destination: attr.Destination || "Unknown",
              status: attr.Status === "CANCELED" ? "DELAYED" : (attr.Delay && attr.Delay !== "00:00:00" ? "DELAYED" : "ON TIME"),
              carrier: attr.Contractor || "Unknown",
              location: "DK Infrastructure Network",
              lat: Number(attr.Latitude),
              lng: Number(attr.Longitude),
              description: "Live Telemetry Feed (Banedanmark)",
              delay: attr.Delay || "00:00:00",
              speed: "Track Speed",
              vector: { lat: 0, lng: 0 }
            };
          });
        console.log(`Successfully synced ${liveFleet.length} live units.`);
      }
    } catch (error) {
      console.warn(
        "Telemetry Interface Sync Suspended (Clearing stale live records):", 
        error instanceof Error ? error.message : "Unknown error"
      );
      // Clears old items out so they do not freeze in space forever on layout failures
      liveFleet = []; 
    }

    // Handle Simulation Vectoring Cleanly 
    simulatedFleet = simulatedFleet.map(train => {
      const vLat = train.vector?.lat || 0;
      const vLng = train.vector?.lng || 0;
      
      const newLat = train.lat + (vLat * (0.8 + Math.random() * 0.4));
      const newLng = train.lng + (vLng * (0.8 + Math.random() * 0.4));
      
      let newSpeed = train.speed;
      if (Math.random() > 0.8) {
        const speedVal = Math.floor(Math.random() * 40) + 60; 
        newSpeed = `${speedVal} km/h`;
      }

      return { ...train, lat: newLat, lng: newLng, speed: newSpeed };
    });

    // Emit combined array down the websocket pipe
    const updatedFleet = [...simulatedFleet, ...liveFleet];
    globalThis.fleet = updatedFleet;
    io.emit("fleet_update", updatedFleet);

    // RECURSION CALL FIX: Schedule next execution ONLY when this complete lifecycle finishes
    setTimeout(fetchRealTimeFleet, 10000);
  };

  // Kick off the initial loop execution
  fetchRealTimeFleet();
  // ==========================================
  // UPDATED POLING METHOD END
  // ==========================================

  io.on("connection", (socket) => {
    console.log(`Client active: ${socket.id} connects via [${socket.conn.transport.name}]`);
    socket.emit("fleet_update", globalThis.fleet);

    socket.on("disconnect", () => {
      console.log(`Connection dropped: ${socket.id}`);
    });
  });

  app.get("/api/fleet", (req, res) => {
    res.json({ success: true, fleet: globalThis.fleet });
  });

  // GOOGLE AI STUDIO FUNCTION CALLING GATEWAY ENDPOINT
  app.post("/api/chat", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Missing user prompt string." });

    try {
      const trackingTool = {
        functionDeclarations:
