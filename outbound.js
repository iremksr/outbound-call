import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { MongoClient, ObjectId } from "mongodb";
import { callQueue, extractNullValues } from "./functions.js";
import { initDB, saveCallRecord, updateCallStatus, testDatabaseConnection } from "./database.js";

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
  console.error("Required variables:", {
    ELEVENLABS_API_KEY: !!ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID: !!ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID: !!TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: !!TWILIO_PHONE_NUMBER,
    MONGODB_URL: !!MONGODB_URL
  });
  process.exit(1);
}

// Initialize Fastify server
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);


// Status callback endpoint
fastify.post("/call-status", async (req, reply) => {
  try {
    const { CallSid, CallStatus, AnsweredBy, CallDuration } = req.body;
    const docId = req.body.CustomParameterDocId || req.query.docId;
    
    console.log(`StatusCallback for ${CallSid}:`);
    console.log(`  - Status: ${CallStatus}`);
    console.log(`  - AnsweredBy: ${AnsweredBy}`);
    console.log(`  - Duration: ${CallDuration}`);
    console.log(`  - DocId: ${docId}`);

    let yeniDurum;
    
    if (["no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
      yeniDurum = "Arandı, Açmadı";
    } else if (CallStatus === "completed") {
      const duration = parseInt(CallDuration) || 0;
      
      if (AnsweredBy === "human" && duration > 5) {
        yeniDurum = "Arandı";
      } else if (AnsweredBy === "machine" || AnsweredBy === "fax") {
        yeniDurum = "Arandı, Açmadı";
      } else if (AnsweredBy === "unknown" && duration > 15) {
        yeniDurum = "Arandı";
      } else if (AnsweredBy === "unknown" && duration <= 15) {
        yeniDurum = "Arandı, Açmadı";
      } else {
        yeniDurum = "Arandı, Açmadı";
      }
    } else if (CallStatus === "answered") {
      yeniDurum = "Arandı (Devam Ediyor)";
    } else {
      yeniDurum = `Arandı (${CallStatus})`;
    }

    console.log(`  - Yeni Durum: ${yeniDurum}`);

    if (docId) {
      await updateCallStatus(docId, yeniDurum);
    }
    
    reply.send("OK");
  } catch (error) {
    console.error("Error in call-status endpoint:", error);
    reply.code(500).send("Error processing status");
  }
});


// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running", timestamp: new Date().toISOString() });
});


// Debug endpoint
fastify.get("/debug", async (request, reply) => {
  try {
    const database = await initDB();
    const collection = database.collection("parsed_cv_data");
    
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
    console.error("Debug endpoint error:", error);
    reply.code(500).send({
      success: false,
      error: error.message
    });
  }
});


// Client tools definition
const clientTools = {
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
  }
};

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl(docId = null) {
  try {
    const toolsParam = encodeURIComponent(JSON.stringify({
      extract_null_values: {
        description: "Extract null or empty values from candidate data, and return the parsed data of the candidate.",
        parameters: {
          docId: { type: "string", description: "Document ID to extract data from" }
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
      const errorText = await response.text();
      throw new Error(`Failed to get signed URL: ${response.status} ${response.statusText} - ${errorText}`);
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
  try {
    const { number } = request.body;

    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml`,
      statusCallback: `https://${request.headers.host}/call-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed", "canceled"],
      statusCallbackMethod: "POST",
      machineDetection: "Enable",
      machineDetectionTimeout: 30,
      machineDetectionSpeechThreshold: 2400,
      machineDetectionSpeechEndThreshold: 1200,
      machineDetectionSilenceTimeout: 5000,
      timeout: 60
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
      error: error.message,
    });
  }
});

// Route to initiate bulk calls from database
fastify.post("/advanced-calls", async (request, reply) => {
  try {
    const { 
      concurrent = false,
      waitForCompletion = true, 
      delayBetweenCalls = 60000,
      maxWaitTime = 180000,
      numbers = []
    } = request.body;

    console.log(`[Advanced Calls] Starting ${concurrent ? 'concurrent' : 'sequential'} calls`);

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
      const callPromises = queue.map(async ({ number, docId, name }) => {
        try {
          const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: number,
            url: `https://${host}/outbound-call-twiml?docId=${docId}&name=${encodeURIComponent(name || '')}`,
            statusCallback: `https://${host}/call-status?docId=${docId}`,
            statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed", "canceled"],
            statusCallbackMethod: "POST",
            machineDetection: "Enable",
            machineDetectionTimeout: 30,
            machineDetectionSpeechThreshold: 2400,
            machineDetectionSpeechEndThreshold: 1200,
            machineDetectionSilenceTimeout: 5000,
            timeout: 60
          });

          let finalStatus = "initiated";
          if (waitForCompletion) {
            finalStatus = await waitForCallCompletion(call.sid, maxWaitTime);
          }

          return { number, name, callSid: call.sid, status: finalStatus };
        } catch (err) {
          console.error(`[Advanced Calls] Concurrent call failed: ${number} - ${err.message}`);
          return { number, name, status: "failed", error: err.message };
        }
      });

      results = await Promise.all(callPromises);
    } else {
      for (let i = 0; i < queue.length; i++) {
        const { number, docId, name } = queue[i];
        
        try {
          const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: number,
            url: `https://${host}/outbound-call-twiml?docId=${docId}&name=${encodeURIComponent(name || '')}`,
            statusCallback: `https://${host}/call-status?docId=${docId}`,
            statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed", "canceled"],
            statusCallbackMethod: "POST",
            machineDetection: "Enable",
            machineDetectionTimeout: 30,
            machineDetectionSpeechThreshold: 2400,
            machineDetectionSpeechEndThreshold: 1200,
            machineDetectionSilenceTimeout: 5000,
            timeout: 60
          });

          let finalStatus = "initiated";
          if (waitForCompletion) {
            finalStatus = await waitForCallCompletion(call.sid, maxWaitTime);
          }

          results.push({ number, name, callSid: call.sid, status: finalStatus });

          if (i < queue.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
          }
        } catch (err) {
          console.error(`[Advanced Calls] Sequential call failed: ${number} - ${err.message}`);
          results.push({ number, name, status: "failed", error: err.message });
          
          if (i < queue.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
          }
        }
      }
    }

    const successful = results.filter(r => r.status !== "failed").length;
    const failed = results.filter(r => r.status === "failed").length;

    return reply.send({
      success: true,
      message: `Advanced calls completed - ${concurrent ? 'concurrent' : 'sequential'} mode`,
      mode: concurrent ? 'concurrent' : 'sequential',
      total: queue.length,
      successful,
      failed,
      waitedForCompletion: waitForCompletion,
      delayBetweenCalls: concurrent ? 0 : delayBetweenCalls,
      results
    });
  } catch (error) {
    console.error("Error in advanced-calls:", error);
    reply.code(500).send({
      success: false,
      error: error.message
    });
  }
});

// Helper function to wait for call completion
async function waitForCallCompletion(callSid, maxWaitTime) {
  const startTime = Date.now();
  const pollInterval = 5000;
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const call = await twilioClient.calls(callSid).fetch();
      
      if (['completed', 'failed', 'canceled', 'no-answer', 'busy'].includes(call.status)) {
        return call.status;
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.error(`[Wait] Error checking call ${callSid}:`, error);
      break;
    }
  }
  
  return 'timeout';
}

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
      error: error.message
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  try {
    const docId = request.query.docId || "";
    const name = decodeURIComponent(request.query.name || "");

    console.log(`[TwiML] Webhook called for ${name} (docId: ${docId})`);

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
  } catch (error) {
    console.error("Error in TwiML endpoint:", error);
    reply.code(500).send("Error generating TwiML");
  }
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");      

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let callRecord = []; 
      let isCallRecordSaved = false;


      ws.on("error", (error) => {
        console.error("[WebSocket] Error:", error);
      });

      const setupElevenLabs = async () => {
        try {
          const docId = customParameters?.docId;
          const signedUrl = await getSignedUrl(docId);
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔗 ElevenLabs: Connected to Conversational AI`);
            console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 📞 Calling: ${customParameters?.name || 'Unknown'} (docId: ${customParameters?.docId || 'N/A'})`);
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
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({
                      event: "clear",
                      streamSid,
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    }));
                  }
                  break;

                case "agent_response":
                  console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🤖 Agent: ${message.agent_response_event?.agent_response}`);
                  callRecord.push({
                    type: 'agent',
                    message: message.agent_response_event?.agent_response,
                    timestamp: new Date()
                  });
                  break;

                case "user_transcript":
                  console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 👤 User: ${message.user_transcription_event?.user_transcript}`);
                  callRecord.push({
                    type: 'user',
                    message: message.user_transcription_event?.user_transcript,
                    timestamp: new Date()
                  });
                  break;

                case "tool_response":
                  console.log("[ElevenLabs] 🔧 Tool response received:", message);
                  break;

                case "client_tool_call":
                  console.log("[ElevenLabs] 🔧 Client tool call received:", message);
                  
                  const toolName = message.client_tool_call?.tool_name;
                  const toolCallId = message.client_tool_call?.tool_call_id;
                  const parameters = message.client_tool_call?.parameters || {};
                  
                  console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔧 Tool Called: ${toolName} with parameters:`, parameters);
                  
                  if (clientTools[toolName]) {
                    try {
                      const docId = customParameters?.docId;
                      if (docId && !parameters.docId) {
                        parameters.docId = docId;
                      }
                      
                      const result = await clientTools[toolName](parameters);
                      console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔧 Tool Result: ${toolName} returned:`, result);
                      
                      const toolResponse = {
                        type: "client_tool_result",
                        tool_call_id: toolCallId,
                        result: JSON.stringify(result),
                        is_error: false
                      };
                      
                      elevenLabsWs.send(JSON.stringify(toolResponse));
                    } catch (error) {
                      console.error(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] ❌ Tool Error: ${toolName} failed:`, error);
                      
                      const errorResponse = {
                        type: "client_tool_result",
                        tool_call_id: toolCallId,
                        result: JSON.stringify({ error: error.message }),
                        is_error: true
                      };
                      
                      elevenLabsWs.send(JSON.stringify(errorResponse));
                    }
                  } else {
                    console.error(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] ❌ Unknown tool: ${toolName}`);
                  }
                  break;

                default:
                  // Diğer mesaj tiplerini de logla
                  if (message.type) {
                    console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 📨 ElevenLabs Message: ${message.type}`, message);
                  }
                  break;
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", error => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", async () => {
            console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔗 ElevenLabs: Disconnected from Conversational AI`);
            
            // Konuşma bittiğinde call record'ı kaydet
            if (callRecord.length > 0 && customParameters?.docId) {
              try {
                await saveCallRecord(customParameters.docId, callRecord);
                isCallRecordSaved = true;
                console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] ✅ Call record saved successfully`);
              } catch (error) {
                console.error(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] ❌ Error saving call record:`, error);
              }
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      ws.on("message", message => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              
              setupElevenLabs();
              console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔗 Twilio: Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔗 Twilio: Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              if (msg.event !== "media") {
                console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 📨 Twilio Event: ${msg.event}`, msg);
              }
              break;
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", async () => {
        console.log(`[${customParameters?.name || customParameters?.docId || 'Unknown'}] 🔗 Twilio: Client disconnected`);
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Initialize and start server
async function startServer() {
  try {
    // Test database connection
    const dbConnected = await testDatabaseConnection();
    if (!dbConnected) {
      console.error("❌ Cannot start server - database connection failed");
      process.exit(1);
    }

    // Start server
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`✅ Server started successfully on port ${PORT}`);
  } catch (error) {
    console.error("❌ Error starting server:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await fastify.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await fastify.close();
  process.exit(0);
});

// Start the server
startServer();