import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URL = process.env.MONGODB_URL;
const DATABASE_NAME = process.env.DATABASE_NAME || "chatai_db";

if (!MONGODB_URL) {
  console.error("Missing MONGODB_URL in environment");
  process.exit(1);
}

let dbClient;
let db;

/**
 * MongoDB bağlantısını başlatır ve tekil instance döner
 */
async function initDB() {
  if (!dbClient) {
    dbClient = new MongoClient(MONGODB_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    try {
      await dbClient.connect();
      db = dbClient.db(DATABASE_NAME);
      // Bağlantı testi
      await db.command({ ping: 1 });
      console.log(`✅ MongoDB bağlantısı başarılı: ${DATABASE_NAME}`);
    } catch (error) {
      console.error("❌ MongoDB bağlantısı başarısız:", error);
      throw error;
    }
  }
  return db;
}


async function saveCallRecord(docId, callRecord) {
  console.log("🔍 saveCallRecord called with:", { docId, callRecordLength: callRecord?.length });
  
  try {
    const database = await initDB();
    const collection = database.collection("parsed_cv_data");
    
    console.log("🔍 Database connection OK, searching for document...");
    
    // Mevcut kaydı kontrol et
    const existingRecord = await collection.findOne({ _id: new ObjectId(docId) });
    
    if (!existingRecord) {
      console.error(`❌ Document with ID ${docId} not found`);
      throw new Error(`Document with ID ${docId} not found`);
    }
    
    console.log("🔍 Document found:", existingRecord.name || "Unknown");
    
    // Yeni call record objesi
    const newCallRecord = {
      call_date: new Date(),
      conversation: callRecord
    };
    
    console.log("🔍 New call record created:", { 
      call_date: newCallRecord.call_date, 
      conversation_length: newCallRecord.conversation.length 
    });
    
    // Eğer call_records array'i yoksa oluştur, varsa yeni kaydı ekle
    const updateQuery = existingRecord.call_records 
      ? { $push: { call_records: newCallRecord } }  // Var olan array'e ekle
      : { $set: { call_records: [newCallRecord] } }; // Yeni array oluştur
    
    console.log("🔍 Update query:", updateQuery);
    
    const result = await collection.updateOne(
      { _id: new ObjectId(docId) },
      updateQuery
    );
    
    console.log("🔍 Update result:", result);
    
    if (result.modifiedCount > 0) {
      console.log(`✅ Call record saved for ${docId}. Total calls: ${(existingRecord.call_records?.length || 0) + 1}`);
    } else {
      console.log(`⚠️ No documents were modified for ${docId}`);
    }
    
    return result;
    
  } catch (error) {
    console.error("❌ Error saving call record:", error);
    throw error;
  }
}

async function updateCallStatus(docId, status) {
  try {
    const database = await initDB();
    const collection = database.collection("parsed_cv_data");
    const result = await collection.updateOne(
      { _id: new ObjectId(docId) },
      { $set: { durum: status, last_call_date: new Date() } }
    );
    console.log(`Updated call status for ${docId}: ${status}`);
    return result;
  } catch (error) {
    console.error("Error updating call status:", error);
    throw error;
  }
}

export { initDB, saveCallRecord, updateCallStatus};