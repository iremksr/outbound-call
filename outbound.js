/*import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null; // Add this to store parameters

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config with prompt:",
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", data => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", error => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", message => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters; // Store parameters
              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log("[Twilio] Start parameters:", customParameters);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Start the Fastify server
fastify.listen({ port: PORT }, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});*/




/*import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 8000
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Initialize Fastify server with logger
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Single outbound call endpoint
fastify.post("/outbound-call", async (req, reply) => {
  req.log.info("Single call request", req.body);
  const { number, prompt } = req.body;
  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }
  try {
    const host = req.headers.host;
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}`
    });
    return reply.send({ success: true, callSid: call.sid });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ success: false, error: err.message });
  }
});

// Bulk outbound calls endpoint
fastify.post("/outbound-calls", async (req, reply) => {
  req.log.info("Bulk call request", req.body);
  const { numbers, prompt } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return reply.code(400).send({ error: "At least one phone number is required" });
  }
  try {
    const host = req.headers.host;
    const calls = await Promise.all(
      numbers.map(num =>
        twilioClient.calls.create({
          from: TWILIO_PHONE_NUMBER,
          to: num,
          url: `https://${host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}`
        })
      )
    );
    return reply.send({
      success: true,
      results: calls.map(c => ({ to: c.to, sid: c.sid }))
    });
  } catch (err) {
    req.log.error("Bulk call error", err);
    return reply.code(500).send({ success: false, error: err.message });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (req, reply) => {
  const prompt = req.query.prompt || "";
  const host   = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Görüşme başlatılıyor. Lütfen bekleyin.</Say>
  <Start>
    <Stream url="wss://${host}/outbound-media-stream">
      <Parameter name="prompt" value="${prompt}" />
    </Stream>
  </Start>
  <Pause length="3600"/>
</Response>`;
  reply.type("text/xml").send(twiml);
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");
      // ElevenLabs WS setup & handlers
    }
  );
});

// Start the server
fastify.listen({ port: +PORT }, err => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Listening on http://localhost:${PORT}`);
});*/



import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { MongoClient } from "mongodb";
import { callQueue, initDB } from "./functions.js";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  MONGODB_URL,
  DATABASE_NAME = "chatai_db"
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !MONGODB_URL
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Status callback endpoint
fastify.post("/call-status", async (req, reply) => {
  const { CallSid, CallStatus, CustomParameterDocId } = req.body;
  fastify.log.info(`StatusCallback for ${CallSid}: ${CallStatus}`);

  let yeniDurum;
  if (["no-answer","busy","failed","canceled"].includes(CallStatus)) {
    yeniDurum = "Arandı, Müsait Değildi";
  } else if (CallStatus === "completed") {
    yeniDurum = "Arandı";
  } else {
    yeniDurum = `Arandı (${CallStatus})`;
  }

  if (CustomParameterDocId) {
    await updateCallStatus(CustomParameterDocId, yeniDurum);
  }
  reply.send("");
});


async function updateCallStatus(docId, status) {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");
  await collection.updateOne(
    { _id: docId },
    { $set: { durum: status, last_call_date: new Date() } }
  );
}

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Debug endpoint - sistem durumunu kontrol et
fastify.get("/debug", async (request, reply) => {
  try {
    const database = await initDB();
    const collection = database.collection("parsed_cv_data");
    
    // Durum istatistikleri
    const stats = await collection.aggregate([
      {
        $group: {
          _id: "$durum",
          count: { $sum: 1 }
        }
      }
    ]).toArray();
    
    const queue = await callQueue();
    
    reply.send({
      success: true,
      server: "running",
      ngrok_host: request.headers.host,
      websocket_url: `wss://${request.headers.host}/outbound-media-stream`,
      database: "connected",
      queue_size: queue.length,
      status_breakdown: stats,
      environment: {
        elevenlabs_configured: !!ELEVENLABS_API_KEY,
        twilio_configured: !!TWILIO_ACCOUNT_SID,
        mongodb_configured: !!MONGODB_URL
      }
    });
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: error.message
    });
  }
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate single outbound call
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt || ""
      )}&first_message=${encodeURIComponent(first_message || "")}`
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// Route to initiate bulk calls from database
fastify.post("/bulk-calls", async (request, reply) => {
  // Body’den parametreleri al
  const {
    numbers = [],
    prompt = "",
    first_message = "",
    concurrent = false,
    delay = 5000
  } = request.body;

  // Kuyruğu belirle: manuel numbers veya veritabanından
  let queue;
  if (Array.isArray(numbers) && numbers.length > 0) {
    queue = numbers.map(n => ({ number: n, docId: null, name: null }));
  } else {
    queue = await callQueue();
  }

  if (queue.length === 0) {
    return reply.send({
      success: true,
      message: "No numbers to call",
      total: 0,
      results: []
    });
  }

  const host = request.headers.host;
  let results = [];

  if (concurrent) {
    // Paralel tüm aramaları başlat
    const callPromises = queue.map(({ number, docId, name }) =>
      twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://${host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}&first_message=${encodeURIComponent(first_message)}&docId=${docId}&name=${encodeURIComponent(name)}`
      })
      .then(call => {
        if (docId) updateCallStatus(docId, "Arandı");
        return { number, name, callSid: call.sid, status: "queued" };
      })
      .catch(err => ({ number, name, status: "failed", error: err.message }))
    );
    results = await Promise.all(callPromises);
  } else {
    // Sıralı arama
    for (let i = 0; i < queue.length; i++) {
      const { number, docId, name } = queue[i];
      try {
        const call = await twilioClient.calls.create({
          from: TWILIO_PHONE_NUMBER,
          to: number,
          url: `https://${host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}&first_message=${encodeURIComponent(first_message)}&docId=${docId}&name=${encodeURIComponent(name)}`
        });
        if (docId) await updateCallStatus(docId, "Arandı");
        results.push({ number, name, callSid: call.sid, status: "queued" });
        if (i < queue.length - 1) await new Promise(r => setTimeout(r, delay));
      } catch (err) {
        results.push({ number, name, status: "failed", error: err.message });
      }
    }
  }

  return reply.send({
    success: true,
    message: "Bulk calls completed",
    total: queue.length,
    successful: results.filter(r => r.status === "queued").length,
    failed: results.filter(r => r.status === "failed").length,
    results
  });
});

// Route to get call queue status
fastify.get("/call-queue", async (request, reply) => {
  try {
    const queue = await callQueue();
    reply.send({
      success: true,
      total: queue.length,
      numbers: queue
    });
  } catch (error) {
    console.error("Error getting call queue:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to get call queue"
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";
  const docId = request.query.docId || "";
  const name = request.query.name || "";

  console.log(`[TwiML] Webhook called for ${name} - Host: ${request.headers.host}`);
  console.log(`[TwiML] Parameters: prompt=${prompt.substring(0, 50)}..., first_message=${first_message.substring(0, 30)}...`);

  // WebSocket URL'ini kontrol et
  const wsUrl = `wss://${request.headers.host}/outbound-media-stream`;
  console.log(`[TwiML] WebSocket URL: ${wsUrl}`);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="${wsUrl}">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
            <Parameter name="docId" value="${docId}" />
            <Parameter name="name" value="${name}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              `[ElevenLabs] Calling ${customParameters?.name || 'Unknown'} - Sending initial config with prompt:`,
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", data => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[${customParameters?.name || 'Unknown'}] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  console.log(
                    `[${customParameters?.name || 'Unknown'}] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", error => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log(`[ElevenLabs] Disconnected from ${customParameters?.name || 'Unknown'}`);
            
            // Arama tamamlandığında durumu güncelle
            if (customParameters?.docId) {
              updateCallStatus(customParameters.docId, "Arama Tamamlandı")
                .catch(err => console.error("Error updating call status:", err));
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", message => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(
                `[Twilio] Stream started for ${customParameters?.name || 'Unknown'} - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended for ${customParameters?.name || 'Unknown'}`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log(`[Twilio] Client disconnected for ${customParameters?.name || 'Unknown'}`);
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Initialize database connection on startup
initDB().catch(console.error);

// Start the Fastify server
fastify.listen({ port: PORT }, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
