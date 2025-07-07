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
    await dbClient.connect();
    db = dbClient.db(DATABASE_NAME);
    // Bağlantı testi
    await db.command({ ping: 1 });
    console.log(`MongoDB bağlantısı başarılı: ${DATABASE_NAME}`);
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

/**
 * Telefon numarasını temizler ve uluslararası formata getirir
 */
function cleanPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let cleaned = rawNumber.replace(/\s+/g, "");
  // 10 haneli ise başına +90 ekle
  if (cleaned.length === 10) {
    cleaned = `+90${cleaned}`;
  } else if (cleaned.length > 10) {
    if (!cleaned.startsWith("+90")) {
      cleaned = `+90${cleaned.slice(-10)}`;
    }
  }
  return cleaned;
}

/**
 * "Aranacak" durumundaki dökümanlardaki numaraları döner
 */
async function callQueue() {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");

  const queue = [];
  const cursor = collection.find({ durum: "Aranacak" });

  // 3) Toplam belge sayısı
  const total = await collection.countDocuments();
  const filtered = await collection.countDocuments({ durum: "Aranacak" });
  console.log(`Toplam doküman: ${total}, durum=Aranacak olan: ${filtered}`);

  await cursor.forEach(doc => {
    const raw = doc.parsed_data?.["Kişisel Bilgiler"]?.["Telefon Numarası"];
    const number = cleanPhoneNumber(raw);
    if (number) {
      queue.push({ number, docId: doc._id });
    }
  });

  console.log("Queue:", queue);
  return queue;
}

/**
 * Bir dökümanda null/undefined alanları bulur ve path listesini döner
 */
async function extractNullValues(_id) {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");

  const doc = await collection.findOne({ _id: new ObjectId(_id) });
  if (!doc) {
    return { error: `parsed CV verisi bulunamadı: ${_id}` };
  }

  function findNulls(data, path = "") {
    const results = [];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (value === null || value === undefined) {
          results.push(fullPath);
        } else {
          results.push(...findNulls(value, fullPath));
        }
      }
    } else if (Array.isArray(data)) {
      data.forEach((item, idx) => {
        const fullPath = `${path}[${idx}]`;
        results.push(...findNulls(item, fullPath));
      });
    }
    return results;
  }

  const parsed = doc.parsed_data || {};
  const nullFields = findNulls(parsed);
  const name = parsed["Kişisel Bilgiler"]?.["Ad Soyad"] || "Bulunamadı";

  
  return (    {
      name,
      nullFields,
      parsedData: parsed
    }
  );
}
 

export { initDB, cleanPhoneNumber, callQueue, extractNullValues, saveCallRecord };
