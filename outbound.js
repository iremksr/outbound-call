import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { MongoClient, ObjectId } from "mongodb";
import { callQueue, initDB, extractNullValues } from "./functions.js";

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
  const { CallSid, CallStatus, AnsweredBy } = req.body;
  const docId = req.body.CustomParameterDocId || req.query.docId;
  fastify.log.info(`StatusCallback for ${CallSid}: ${CallStatus}, AnsweredBy: ${AnsweredBy}, docId: ${docId}`);
  console.log(`StatusCallback for ${CallSid}: ${CallStatus}, AnsweredBy: ${AnsweredBy}, docId: ${docId}`);

  let yeniDurum;
  if (["no-answer","busy","failed","canceled"].includes(CallStatus)) {
    yeniDurum = "Arandı, Açmadı";
  } else if (CallStatus === "completed") {
    if (AnsweredBy && AnsweredBy !== "human") {
      yeniDurum = "Arandı, Açmadı";
    } else {
      yeniDurum = "Arandı";
    }
  } else {
    yeniDurum = `Arandı (${CallStatus})`;
  }

  if (docId) {
    await updateCallStatus(docId, yeniDurum);
  }
  reply.send("");
});

async function updateCallStatus(docId, status) {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");
  await collection.updateOne(
    { _id: new ObjectId(docId)},
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

// Client tools definition - bu kısım önemli
const clientTools = {
  // ElevenLabs snake_case kullanıyor, o yüzden tool isimlerini ona göre ayarlıyoruz
  extract_null_values: async ({ docId }) => {
    console.log(`[Tool] Executing extract_null_values with docId: ${docId}`);
    try {
      const result = await extractNullValues(docId);
      console.log(`[Tool] Extract result:`, result);
      return result;
    } catch (error) {
      console.error(`[Tool] Error in extract_null_values:`, error);
      throw error;
    }
  },

  hello: () =>{
    console.log("[Tool] Hello tool called");
    return "Hello from the tool!";
  },
  
  // Örnek: Müşteri detaylarını getir
  get_customer_details: async ({ docId }) => {
    console.log(`[Tool] Getting customer details for docId: ${docId}`);
    try {
      const database = await initDB();
      const collection = database.collection("parsed_cv_data");
      const customer = await collection.findOne({ _id: new ObjectId(docId) });
      
      if (!customer) {
        return { error: "Customer not found" };
      }
      
      return {
        id: customer._id,
        name: customer.name || "Unknown",
        phone: customer.phone || "Unknown",
        email: customer.email || "Unknown",
        status: customer.durum || "Unknown"
      };
    } catch (error) {
      console.error(`[Tool] Error getting customer details:`, error);
      return { error: error.message };
    }
  },
  
  // Log mesajı için tool
  log_message: async ({ message }) => {
    console.log(`[Tool] Agent Log: ${message}`);
    return { success: true, logged: message };
  }
};

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl(docId = null) {
  try {
    // Tool'ları query parametresi olarak gönder
    const toolsParam = encodeURIComponent(JSON.stringify({
      extract_null_values: {
        description: "Extract null or empty values from customer data",
        parameters: {
          docId: { type: "string", description: "Document ID to extract data from" }
        }
      },
      get_customer_details: {
        description: "Get customer details from database",
        parameters: {
          docId: { type: "string", description: "Document ID of the customer" }
        }
      },
      log_message: {
        description: "Log a message",
        parameters: {
          message: { type: "string", description: "Message to log" }
        }
      }
    }));

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}&tools=${toolsParam}`,
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
  const { number } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml`,
      statusCallback: `https://${request.headers.host}/call-status`,
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"],
      statusCallbackMethod: "POST",
      machineDetection: "Enable" 
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
  // Body'den parametreleri al
  const {
    numbers = [],
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
        url: `https://${host}/outbound-call-twiml?docId=${docId}&name=${encodeURIComponent(name)}`,
        statusCallback: `https://${request.headers.host}/call-status?docId=${docId}`,
        statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"],
        statusCallbackMethod: "POST",
        machineDetection: "Enable" 
      })
      .then(call => {
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
          url: `https://${host}/outbound-call-twiml?docId=${docId}&name=${encodeURIComponent(name)}`,
          statusCallback: `https://${request.headers.host}/call-status?docId=${docId}`,
          statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"],
          statusCallbackMethod: "POST",
          machineDetection: "Enable" 
        });

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
  const docId = request.query.docId || "";
  const name = decodeURIComponent(request.query.name || "");

  console.log(`[TwiML] Webhook called for ${name} (docId: ${docId}) - Host: ${request.headers.host}`);

  // WebSocket URL'ini kontrol et
  const wsUrl = `wss://${request.headers.host}/outbound-media-stream`;
  console.log(`[TwiML] WebSocket URL: ${wsUrl}`);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="${wsUrl}">
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
          const docId = customParameters?.docId;
          const signedUrl = await getSignedUrl(docId);
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            console.log(`[ElevenLabs] Calling ${customParameters?.name || 'Unknown'} - Using agent configuration from ElevenLabs`);
          });

          elevenLabsWs.on("message", async (data) => {
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

                case "tool_response":
                  console.log("[ElevenLabs] Tool response received:", message);
                  break;

                case "client_tool_call":
                  console.log("[ElevenLabs] Client tool call received:", message);
                  
                  const toolName = message.client_tool_call?.tool_name;
                  const toolCallId = message.client_tool_call?.tool_call_id;
                  const parameters = message.client_tool_call?.parameters || {};
                  
                  if (clientTools[toolName]) {
                    try {
                      console.log(`[Tool] Executing ${toolName} with parameters:`, parameters);
                      
                      // DocId'yi customParameters'den al ve parametrelere ekle
                      const docId = customParameters?.docId;
                      if (docId && !parameters.docId) {
                        parameters.docId = docId;
                      }
                      
                      const result = await clientTools[toolName](parameters);
                      
                      const toolResponse = {
                        type: "client_tool_result",
                        tool_call_id: toolCallId,
                        result: JSON.stringify(result),
                        is_error: false
                      };
                      
                      elevenLabsWs.send(JSON.stringify(toolResponse));
                      console.log(`[Tool] ${toolName} response sent to ElevenLabs`);
                    } catch (error) {
                      console.error(`[Tool] Error executing ${toolName}:`, error);
                      
                      const errorResponse = {
                        type: "client_tool_result",
                        tool_call_id: toolCallId,
                        result: JSON.stringify({ error: error.message }),
                        is_error: true
                      };
                      
                      elevenLabsWs.send(JSON.stringify(errorResponse));
                    }
                  } else {
                    console.error(`[Tool] Unknown tool: ${toolName}`);
                    
                    const errorResponse = {
                      type: "client_tool_result",
                      tool_call_id: toolCallId,
                      result: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
                      is_error: true
                    };
                    
                    elevenLabsWs.send(JSON.stringify(errorResponse));
                  }
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`, message
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
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

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
              
              // AnsweredBy kontrolü
              const answeredBy = customParameters?.AnsweredBy;
              if (answeredBy && answeredBy !== "human") {
                console.warn(`[Server] Call did not connect to a human (AnsweredBy=${answeredBy}), skipping ElevenLabs setup.`);
                ws.close();
                return;
              }
              
              // Sadece insan açtıysa ElevenLabs bağlantısı başlat
              setupElevenLabs();
              console.log(
                `[Twilio] Stream started for ${customParameters?.name || 'Unknown'} (docId: ${customParameters?.docId || 'N/A'}) - StreamSid: ${streamSid}, CallSid: ${callSid}`
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